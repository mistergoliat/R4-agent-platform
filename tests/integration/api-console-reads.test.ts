import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, type Platform } from '@r4/api';
import { createSilentLogger } from '@r4/observability';
import { SALES_AGENT_DIR, migrateSales } from '@r4-sales/agent';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { LiveOpsTestbed, invalid, say } from '../support/live-ops.js';

/**
 * ADR-049 Phase 2: the console's three new reads (run step trace, activity per
 * local day and agent, event feed). Read-only credential like the other
 * operator-plane GETs; never message text, reasoning or contact addresses.
 */
const TOKEN = 'console-reader-token-0123456789abcdef0123456789';
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const BEARER = { authorization: `Bearer ${TOKEN}` };
const RUN = '0190f1a2-0000-7000-8000-000000000001';
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code: string } }).error?.code;

describe('ADR-049 Phase 2 reads: access and validation', () => {
  let db: TestDatabase | null = null;
  let platform: Platform | null = null;
  beforeAll(async () => {
    db = await createMigratedTestDatabase();
    const pool = openPool(db.url);
    try {
      await migrateSales(pool);
    } finally {
      await pool.end();
    }
    platform = await createPlatform(
      { databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: SALES_AGENT_DIR, dbPoolMax: 2, serviceReaderTokenSha256: HASH },
      { logger: createSilentLogger() },
    );
  });
  afterAll(async () => {
    await platform?.close();
    await db?.drop();
  });
  const get = (url: string, headers: Record<string, string> = BEARER) => platform!.app.inject({ method: 'GET', url, headers });

  it.each(['/v1/production/activity', '/v1/events'])('GET %s answers with the service token and refuses without it', async (url) => {
    expect((await get(url)).statusCode).toBe(200);
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}-wrong` }]) {
      const res = await get(url, headers);
      expect([res.statusCode, code(res)]).toEqual([422, 'trusted_human_required']);
    }
  });

  it('GET /v1/runs/:id/steps: token required; unknown run is 404', async () => {
    const res = await get(`/v1/runs/${RUN}/steps`, {});
    expect([res.statusCode, code(res)]).toEqual([422, 'trusted_human_required']);
    const missing = await get(`/v1/runs/${RUN}/steps`);
    expect([missing.statusCode, code(missing)]).toEqual([404, 'run_not_found']);
  });

  it.each([
    '/v1/runs/not-a-uuid/steps',
    '/v1/production/activity?days=0',
    '/v1/production/activity?days=32',
    '/v1/production/activity?days=abc',
    '/v1/production/activity?other=1',
    '/v1/events?limit=0',
    '/v1/events?limit=201',
    '/v1/events?before=yesterday',
    `/v1/events?before=2026-11-19T10:00:00Z|${RUN}`,
    `/v1/events?before=2026-13-45T10:00:00.000Z|${RUN}`,
  ])('GET %s is a 400', async (url) => {
    const res = await get(url);
    expect([res.statusCode, code(res)]).toEqual([400, 'validation_failed']);
  });

  it('activity of an empty database: N local days, oldest first, no agents', async () => {
    const body = (await get('/v1/production/activity?days=3')).json<{ timeZone: string; days: { day: string; agents: unknown[]; customerTurn: unknown }[] }>();
    expect(body.timeZone).toBe('America/Santiago');
    expect(body.days.map((d) => d.day)).toHaveLength(3);
    expect(body.days.at(-1)!.day).toBe(localDay(new Date()));
    expect(body.days.every((d) => d.agents.length === 0)).toBe(true);
    expect(body.days[0]!.customerTurn).toEqual({ p50Ms: null, n: 0 });
    expect(((await get('/v1/production/activity')).json<{ days: unknown[] }>()).days).toHaveLength(7);
  });
});

const CUSTOMER = '56933334444';
const IN_TEXT = 'Busco trotadora SECRETO-ENTRADA';
const OUT_TEXT = 'Claro, te ayudo SECRETO-SALIDA';

describe('ADR-049 Phase 2 reads: data on a live conversation', () => {
  let bed: LiveOpsTestbed;
  let taskId: string;
  beforeAll(async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    bed.next(invalid(), say(OUT_TEXT));
    await bed.customer(CUSTOMER, 'wamid.console.1', IN_TEXT);
    await bed.runAgent();
    await bed.deliver();
    await bed.status([{ id: bed.provider.sends[0]!.providerMessageId!, status: 'delivered', recipientId: CUSTOMER }]);
    await bed.store.setControl({ scope: 'channel:whatsapp', autonomyEnabled: true, reason: 'console test', changedBy: 'ops@example.com', correlationId: 'console-test' });
    taskId = await bed.taskOf(CUSTOMER);
  });
  afterAll(async () => {
    await bed?.close();
  });
  const get = async <T>(url: string) => {
    const res = await bed.api.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/SECRETO|56933334444|ops@example\.com/);
    return res.json<T>();
  };

  it('run steps: oldest first, decision type and timings, no content', async () => {
    const runs = await bed.rows<{ run_id: string }>('select run_id from agent_runs where task_id = $1 order by sequence', [taskId]);
    const traces = await Promise.all(runs.map((r) => get<{ runId: string; startedAt: string; steps: Record<string, unknown>[] }>(`/v1/runs/${r.run_id}/steps`)));
    const steps = traces.flatMap((t) => t.steps);
    expect(steps.some((s) => s.outcome === 'invalid' && typeof s.errorCode === 'string' && s.decisionType === null)).toBe(true);
    const respond = steps.find((s) => s.decisionType === 'respond')!;
    expect(respond).toMatchObject({ origin: 'model', outcome: 'recorded', capabilityId: null, errorCode: null, executeMs: 0 });
    expect(Object.keys(respond).sort()).toEqual(['capabilityId', 'completedAt', 'createdAt', 'decideMs', 'decisionType', 'errorCode', 'executeMs', 'inputTokens', 'iteration', 'origin', 'outcome', 'outputTokens', 'stepId'].sort());
    for (const trace of traces) {
      expect(trace.steps.map((s) => s.iteration)).toEqual(trace.steps.map((_, i) => i + 1));
      trace.steps.forEach((s, i) => {
        const from = i === 0 ? trace.startedAt : (trace.steps[i - 1]!.completedAt as string);
        expect(s.decideMs).toBe(Date.parse(s.createdAt as string) - Date.parse(from));
        expect(s.decideMs as number).toBeGreaterThanOrEqual(0);
      });
    }
  });

  it('activity: today holds the conversation per agent; a run just before local midnight lands on the previous day', async () => {
    const today = localDay(new Date());
    const before = await get<{ days: { day: string; customerTurn: { p50Ms: number | null; n: number }; agents: Record<string, unknown>[] }[] }>('/v1/production/activity?days=2');
    const todayRow = before.days.find((d) => d.day === today)!;
    expect(todayRow.customerTurn.n).toBe(1);
    expect(todayRow.customerTurn.p50Ms).toBeGreaterThanOrEqual(0);
    const agent = todayRow.agents.find((a) => a.agentId !== null)!;
    const runs = await bed.rows<{ n: number; failed: number; calls: number }>(`select count(*)::int as n, count(*) filter (where status = 'failed')::int as failed, sum(model_calls)::int as calls from agent_runs`);
    expect(agent).toMatchObject({ tasksCreated: 1, inboundReceived: 1, outboundDelivered: 1, handoffsRequested: 0, runs: runs[0]!.n, failedRuns: runs[0]!.failed, modelCalls: runs[0]!.calls });
    expect(agent.inputTokens as number).toBeGreaterThan(0);

    // Move the first run to the last millisecond before today's local midnight.
    const [row] = await bed.rows<{ at: Date }>(
      `update agent_runs set started_at = (date_trunc('day', now() at time zone 'America/Santiago') at time zone 'America/Santiago') - interval '1 millisecond'
        where run_id = (select run_id from agent_runs order by sequence limit 1) returning started_at as at`,
    );
    const yesterday = localDay(row!.at);
    expect(yesterday).not.toBe(today);
    const after = await get<typeof before>('/v1/production/activity?days=2');
    expect(after.days.map((d) => d.day)).toEqual([yesterday, today]);
    expect(after.days[0]!.agents).toEqual([expect.objectContaining({ agentId: agent.agentId, runs: 1, tasksCreated: 0 })]);
    expect(after.days[1]!.agents.find((a) => a.agentId === agent.agentId)!.runs).toBe(runs[0]!.n - 1);
    const oneDay = await get<typeof before>('/v1/production/activity?days=1');
    expect(oneDay.days.map((d) => d.day)).toEqual([today]);
  });

  it('events: newest first, fixed kinds, masked actors, stable cursor pagination', async () => {
    const all = await get<{ events: { cursor: string; at: string; kind: string; taskId: string | null; actor: string; code: string }[]; nextCursor: string | null }>('/v1/events?limit=200');
    expect(all.nextCursor).toBeNull();
    const kinds = new Set(all.events.map((e) => e.kind));
    expect([...kinds].every((k) => ['task.transition', 'temporal.event', 'autonomy.control', 'action.receipt'].includes(k))).toBe(true);
    expect(kinds).toEqual(new Set(['task.transition', 'temporal.event', 'autonomy.control']));
    expect(all.events.find((e) => e.kind === 'autonomy.control' && e.code === 'channel:whatsapp:enabled')).toMatchObject({ actor: 'redacted', taskId: null });
    expect(all.events.some((e) => e.kind === 'temporal.event' && e.code === 'task.input.received' && e.taskId === taskId)).toBe(true);
    expect(all.events.every((e) => !/:[0-9a-f]{32}$/.test(e.actor))).toBe(true);
    const keys = all.events.map((e) => e.cursor);
    expect([...keys].sort().reverse()).toEqual(keys);

    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page: typeof all = await get(`/v1/events?limit=3${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
      paged.push(...page.events.map((e) => e.cursor));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged).toEqual(keys);
  });
});

function localDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(at);
}
