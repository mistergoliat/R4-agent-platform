import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, type ApiConfig, type Platform } from '@r4/api';
import { createSilentLogger } from '@r4/observability';
import { SALES_AGENT_DIR } from '@r4-sales/agent';
import { LiveOpsTestbed, invalid, say } from '../support/live-ops.js';

/**
 * ADR-051: incidents are deterministic SQL detectors over existing tables, grouped by signature, with a durable
 * human triage. A real production composition seeds conversations (reply after an invalid answer, a non-retryable
 * model failure, customers nobody answered); rows the testbed cannot produce (failed/unknown/expired sends,
 * failed/rejected inbound) are inserted directly. The read never carries message text or contact data.
 */
const KEY = randomBytes(32).toString('base64url');
const ISS = 'https://accounts.google.com';
const SUB = '109876543210987654321';
const TOKEN = 'console-reader-token-0123456789abcdef0123456789';
const BEARER = { authorization: `Bearer ${TOKEN}` };
const ANSWERED = '56911110001';
const FAILED = '56911110002';
const WAITING = Array.from({ length: 7 }, (_, i) => `5692222000${i}`);
const IN_TEXT = 'Busco trotadora SECRETO-ENTRADA';
const OUT_TEXT = 'Claro, te ayudo SECRETO-SALIDA';
const INBOUND_SIGNATURE = 'inbound_problem:-@-:foreign_business_number';

interface View {
  windowDays: number;
  generatedAt: string;
  incidents: {
    signature: string; detector: string; severity: string; agentId: string | null; agentVersion: number | null; code: string;
    count: number; firstSeen: string; lastSeen: string; exampleTaskIds: string[];
    triage: { state: string; note: string | null; requestUrl: string | null; decidedBy: string | null; decidedAt: string | null };
  }[];
}

let bed: LiveOpsTestbed;
let now: Platform;
let later: Platform;
/** (owner 2026-11-26) Five minutes on: past the 4-minute «sin respuesta», not past the 10-minute consultation SLA. */
let mid: Platform;
const tasks: Record<string, string> = {};

beforeAll(async () => {
  bed = await LiveOpsTestbed.start({ allowlist: [ANSWERED, FAILED, ...WAITING], autonomy: true });
  // One invalid answer (ADR-028 recovers), then a reply: a failed run, an invalid step, an answered customer.
  bed.next(invalid(), say(OUT_TEXT));
  await bed.customer(ANSWERED, 'wamid.inc.a1', IN_TEXT);
  await bed.runAgent();
  await bed.deliver();
  // A non-retryable model failure: failed run + platform handoff (the customer is then held by a human).
  bed.next({ type: 'provider_error', retryable: false, message: 'credentials rejected' });
  await bed.customer(FAILED, 'wamid.inc.f1', IN_TEXT);
  await bed.runAgent();
  await bed.deliver();
  tasks.answered = await bed.taskOf(ANSWERED);
  tasks.failed = await bed.taskOf(FAILED);
  // Customers whose message no agent run ever answers (the worker never runs again).
  for (const [i, waId] of WAITING.entries()) {
    await bed.customer(waId, `wamid.inc.w${i}`, IN_TEXT);
    tasks[`waiting${i}`] = await bed.taskOf(waId);
  }

  // The agent reply took more than 60 s.
  await bed.rows(`update outbound_messages set accepted_at = accepted_at + interval '61 seconds' where task_id = $1 and origin = 'agent'`, [tasks.answered]);
  // (owner 2026-11-26) A second reply to the same input minutes later (a relayed consultation answer) is NOT slow:
  // the customer already had the first one. slow_reply below still counts exactly one turn for this task.
  await bed.rows(
    `insert into outbound_messages (outbound_id, origin, task_id, binding_id, channel, idempotency_key, content_sha256, body, status, response_key, response_step_id, run_id, profile, correlation_id, accepted_at)
     select $1, 'agent', o.task_id, o.binding_id, o.channel, 'incident-relay', o.content_sha256, o.body, o.status, o.response_key, o.response_step_id, o.run_id, o.profile, 'incident-test', o.accepted_at + interval '3 minutes'
       from outbound_messages o where o.task_id = $2 and o.origin = 'agent' and o.accepted_at is not null order by o.accepted_at limit 1`,
    [randomUUID(), tasks.answered],
  );
  // Delivery problems the testbed cannot produce; a superseded send is not a problem.
  const [binding] = await bed.rows<{ binding_id: string }>('select binding_id from channel_conversation_bindings where task_id = $1', [tasks.answered]);
  for (const [status, cancel, error] of [['failed', null, '131047'], ['unknown', null, null], ['cancelled', 'expired', null], ['cancelled', 'superseded_by_newer_input', null]] as const) {
    await bed.rows(
      `insert into outbound_messages (outbound_id, origin, task_id, binding_id, channel, idempotency_key, content_sha256, body, status, cancel_reason, error_code, human_ref, response_key, profile, correlation_id)
       values ($1, 'operator', $2, $3, 'whatsapp', $4, $5, $6, $7, $8, $9, 'operator-1', $4, 'sales-production@1', 'incident-test')`,
      [randomUUID(), tasks.answered, binding!.binding_id, `incident-${status}-${cancel}`, '0'.repeat(64), OUT_TEXT, status, cancel, error],
    );
  }
  // Inbound problems: six rejected (no task), one failed on a task, one rejected outside a 1-day window.
  const inbound = (status: string, code: string, taskId: string | null, receivedAt = 'clock_timestamp()') =>
    bed.rows(
      `insert into inbound_events (inbound_id, channel, provider_event_id, status, content_kind, failure_code, task_id, received_at, settled_at, correlation_id)
       values ($1, 'whatsapp', $2, $3, $4, $5, $6, ${receivedAt}, clock_timestamp(), 'incident-test')`,
      [randomUUID(), `wamid.inc.in.${randomUUID()}`, status, status === 'rejected' ? 'rejected' : 'text', code, taskId],
    );
  for (let i = 0; i < 6; i++) await inbound('rejected', 'foreign_business_number', null);
  await inbound('failed', 'incomplete_inbound_record', tasks.answered);
  await inbound('rejected', 'old_rejection', null, `clock_timestamp() - interval '3 days'`);
  // (ADR-056 D5) A consultation nobody answers; it is not a handoff, so the customer is not held by it.
  const [run] = await bed.rows<{ run_id: string }>('select run_id from agent_runs where task_id = $1 limit 1', [tasks.answered]);
  await bed.rows(
    `insert into human_requests (request_id, task_id, run_id, kind, status, payload, created_at, updated_at, correlation_id)
     values ($1, $2, $3, 'consultation', 'requested', $4::jsonb, clock_timestamp(), clock_timestamp(), 'incident-test')`,
    [randomUUID(), tasks.answered, run!.run_id, JSON.stringify({ question: '¿Factura a 30 días? SECRETO-PREGUNTA', contextRefs: [], options: ['Sí', 'No'] })],
  );

  const dir = mkdtempSync(join(tmpdir(), 'r4-incidents-it-'));
  const operatorsFile = join(dir, 'operators.json');
  writeFileSync(operatorsFile, JSON.stringify([{ issuer: ISS, subject: SUB, operatorRef: 'felipe', scopes: ['autonomy.control', 'incident.triage'] }]), { mode: 0o600 });
  const config: ApiConfig = {
    databaseUrl: bed.db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: SALES_AGENT_DIR, dbPoolMax: 2,
    serviceReaderTokenSha256: createHash('sha256').update(TOKEN).digest('hex'), consoleOperatorKey: KEY, consoleOperatorsFile: operatorsFile, anonymousWrites: 'disabled',
  };
  now = await createPlatform(config, { logger: createSilentLogger() });
  // Eleven minutes from now: every waiting customer has been without a reply for more than ten.
  later = await createPlatform(config, { logger: createSilentLogger(), clock: { now: () => new Date(Date.now() + 11 * 60_000) } });
  mid = await createPlatform(config, { logger: createSilentLogger(), clock: { now: () => new Date(Date.now() + 5 * 60_000) } });
}, 120_000);

afterAll(async () => {
  await now?.close();
  await later?.close();
  await mid?.close();
  await bed?.close();
});

function assertion(path: string, body: string, scopes: string[]): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ v: 1, iss: ISS, sub: SUB, scopes, method: 'POST', path, bodySha256: createHash('sha256').update(body).digest('hex'), iat, exp: iat + 60, jti: randomUUID() }),
  ).toString('base64url');
  return `v1.${payload}.${createHmac('sha256', Buffer.from(KEY, 'base64url')).update(`v1.${payload}`).digest('base64url')}`;
}
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code: string } }).error?.code;
const triage = (body: object, scopes = ['incident.triage'], headers?: Record<string, string>) => {
  const payload = JSON.stringify(body);
  return now.app.inject({ method: 'POST', url: '/v1/incidents/triage', payload, headers: { 'content-type': 'application/json', ...(headers ?? { 'x-r4-console-assertion': assertion('/v1/incidents/triage', payload, scopes) }) } });
};
async function view(platform: Platform = now, query = ''): Promise<View> {
  const res = await platform.app.inject({ method: 'GET', url: `/v1/incidents${query}`, headers: BEARER });
  expect(res.statusCode).toBe(200);
  expect(res.body).not.toMatch(/SECRETO|5691111|5692222|operator-1@|wamid/);
  return res.json<View>();
}
const find = (v: View, signaturePrefix: string) => v.incidents.filter((i) => i.signature.startsWith(signaturePrefix));

describe('ADR-051 GET /v1/incidents', () => {
  it('opens with the service token; refuses without it; validates days', async () => {
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}-wrong` }]) {
      const res = await now.app.inject({ method: 'GET', url: '/v1/incidents', headers });
      expect([res.statusCode, code(res)]).toEqual([422, 'trusted_human_required']);
    }
    for (const q of ['?days=0', '?days=32', '?days=abc', '?other=1']) {
      const res = await now.app.inject({ method: 'GET', url: `/v1/incidents${q}`, headers: BEARER });
      expect([res.statusCode, code(res)], q).toEqual([400, 'validation_failed']);
    }
    const v = await view();
    expect(v.windowDays).toBe(7);
    expect(Date.parse(v.generatedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect((await view(now, '?days=31')).windowDays).toBe(31);
  });

  it('each detector groups its occurrences with the ADR-051 severity; all open', async () => {
    const v = await view();
    const agent = v.incidents.find((i) => i.detector === 'run_failed')!;
    const at = `${agent.agentId}@${agent.agentVersion}`;
    expect(agent.agentId).toMatch(/^[a-z]/);
    expect(Number.isInteger(agent.agentVersion)).toBe(true);
    const bySignature = Object.fromEntries(v.incidents.map((i) => [i.signature, i]));

    const runFailed = find(v, 'run_failed:');
    expect(runFailed.find((i) => i.code.startsWith('model_failure/'))).toMatchObject({ severity: 'high', count: 1, exampleTaskIds: [tasks.failed] });
    expect(runFailed.find((i) => i.code.startsWith('invalid_decision/'))).toMatchObject({ severity: 'medium', exampleTaskIds: [tasks.answered] });
    expect(bySignature[`platform_handoff:${at}:non_retryable_model_failure`]).toMatchObject({ severity: 'medium', count: 1, exampleTaskIds: [tasks.failed] });
    expect(find(v, 'step_error:')).toEqual([expect.objectContaining({ severity: 'low', exampleTaskIds: [tasks.answered] })]);
    expect(bySignature[`outbound_problem:${at}:unknown`]).toMatchObject({ severity: 'critical', count: 1 });
    expect(bySignature[`outbound_problem:${at}:failed/131047`]).toMatchObject({ severity: 'high', count: 1 });
    expect(bySignature[`outbound_problem:${at}:cancelled/expired`]).toMatchObject({ severity: 'high', count: 1 });
    expect(find(v, 'outbound_problem:')).toHaveLength(3);
    expect(bySignature[INBOUND_SIGNATURE]).toMatchObject({ detector: 'inbound_problem', severity: 'info', agentId: null, agentVersion: null, code: 'foreign_business_number', count: 6, exampleTaskIds: [] });
    expect(bySignature[`inbound_problem:${at}:failed/incomplete_inbound_record`]).toMatchObject({ severity: 'high', count: 1, exampleTaskIds: [tasks.answered] });
    expect(bySignature[`slow_reply:${at}:customer_turn_over_60s`]).toMatchObject({ severity: 'medium', count: 1, exampleTaskIds: [tasks.answered] });
    // Four minutes have not passed: nobody is unanswered yet, and the consultation is not late yet.
    expect(find(v, 'customer_unanswered:')).toEqual([]);
    expect(find(v, 'consultation_waiting:')).toEqual([]);

    for (const i of v.incidents) {
      expect(Object.keys(i).sort()).toEqual(['agentId', 'agentVersion', 'code', 'count', 'detector', 'exampleTaskIds', 'firstSeen', 'lastSeen', 'severity', 'signature', 'triage']);
      expect(i.signature).toBe(`${i.detector}:${i.agentId ?? '-'}@${i.agentVersion ?? '-'}:${i.code}`);
      expect(i.triage).toEqual({ state: 'open', note: null, requestUrl: null, decidedBy: null, decidedAt: null });
      expect(Date.parse(i.firstSeen)).toBeLessThanOrEqual(Date.parse(i.lastSeen));
    }
  });

  it('sorted by severity, then the most recent last occurrence', async () => {
    const order = ['critical', 'high', 'medium', 'low', 'info'];
    const v = await view(later);
    for (let k = 1; k < v.incidents.length; k++) {
      const [a, b] = [v.incidents[k - 1]!, v.incidents[k]!];
      const rank = order.indexOf(a.severity) - order.indexOf(b.severity);
      expect(rank < 0 || (rank === 0 && Date.parse(a.lastSeen) >= Date.parse(b.lastSeen)), `${a.signature} before ${b.signature}`).toBe(true);
    }
    expect(new Set(v.incidents.map((i) => i.detector))).toEqual(new Set(['customer_unanswered', 'run_failed', 'platform_handoff', 'step_error', 'outbound_problem', 'inbound_problem', 'slow_reply', 'consultation_waiting']));
  });

  it('owner 2026-11-26: a customer is unanswered after 4 minutes, a consultation only after its 10-minute SLA', async () => {
    const v = await view(mid);
    expect(find(v, 'customer_unanswered:').length).toBeGreaterThan(0);
    expect(find(v, 'consultation_waiting:')).toEqual([]);
  });

  it('consultation_waiting after ten minutes: high, with the task as example, never the question text', async () => {
    const v = await view(later);
    expect(find(v, 'consultation_waiting:')).toEqual([expect.objectContaining({ severity: 'high', code: 'unanswered_over_10_min', count: 1, exampleTaskIds: [tasks.answered] })]);
    expect(JSON.stringify(v)).not.toMatch(/SECRETO-PREGUNTA/);
  });

  it('customer_unanswered after four minutes: only autonomous, unheld, unanswered customers; five newest examples', async () => {
    const [group, ...others] = find(await view(later), 'customer_unanswered:');
    expect(others).toEqual([]);
    const waiting = WAITING.map((_, i) => tasks[`waiting${i}`]!);
    const newest = (await bed.rows<{ task_id: string }>(`select task_id from task_inputs where task_id = any($1::uuid[]) order by received_at desc limit 5`, [waiting])).map((r) => r.task_id);
    expect(group).toMatchObject({ severity: 'critical', code: 'no_accepted_reply', count: 7, exampleTaskIds: newest });
    expect(group!.exampleTaskIds).not.toContain(tasks.answered);
    expect(group!.exampleTaskIds).not.toContain(tasks.failed);
  });

  it('the window bounds every detector', async () => {
    expect(find(await view(now, '?days=7'), 'inbound_problem:-@-:old_rejection')).toHaveLength(1);
    expect(find(await view(now, '?days=1'), 'inbound_problem:-@-:old_rejection')).toEqual([]);
  });
});

describe('ADR-051 POST /v1/incidents/triage', () => {
  it('needs a signed operator with incident.triage; the service token alone is refused', async () => {
    const body = { signature: INBOUND_SIGNATURE, state: 'ignored', note: 'otro número de negocio' };
    const reader = await triage(body, [], BEARER);
    expect([reader.statusCode, code(reader)]).toEqual([422, 'trusted_human_required']);
    const unsigned = await triage(body, [], {});
    expect([unsigned.statusCode, code(unsigned)]).toEqual([422, 'trusted_human_required']);
    const noScope = await triage(body, ['autonomy.control']);
    expect([noScope.statusCode, code(noScope)]).toEqual([422, 'human_scope_denied']);
    expect(await bed.rows('select * from incident_triage')).toEqual([]);
  });

  it.each([
    ['bad signature', { signature: 'nope', state: 'ignored', note: 'x' }],
    ['long signature', { signature: `run_failed:sales@1:${'x'.repeat(300)}`, state: 'ignored', note: 'x' }],
    ['unknown state', { signature: INBOUND_SIGNATURE, state: 'open', note: 'x' }],
    ['empty note', { signature: INBOUND_SIGNATURE, state: 'ignored', note: '  ' }],
    ['long note', { signature: INBOUND_SIGNATURE, state: 'ignored', note: 'x'.repeat(1001) }],
    ['requested without url', { signature: INBOUND_SIGNATURE, state: 'requested', note: 'x' }],
    ['http url', { signature: INBOUND_SIGNATURE, state: 'requested', note: 'x', requestUrl: 'http://github.com/x/y/issues/1' }],
    ['extra field', { signature: INBOUND_SIGNATURE, state: 'ignored', note: 'x', decidedBy: 'someone' }],
  ])('%s is a 400', async (_name, body) => {
    const res = await triage(body);
    expect([res.statusCode, code(res)]).toEqual([400, 'validation_failed']);
  });

  it('ignored, reopened by a new occurrence, then requested; every decision is kept', async () => {
    const ignored = await triage({ signature: INBOUND_SIGNATURE, state: 'ignored', note: 'otro número de negocio' });
    expect(ignored.statusCode).toBe(200);
    const decided = ignored.json<{ signature: string; triage: View['incidents'][number]['triage'] }>();
    expect(decided).toMatchObject({ signature: INBOUND_SIGNATURE, triage: { state: 'ignored', note: 'otro número de negocio', requestUrl: null, decidedBy: 'oidc:felipe' } });
    expect(find(await view(), INBOUND_SIGNATURE)[0]!.triage).toEqual(decided.triage);

    // A new occurrence after the decision reopens the group; the stored decision is unchanged.
    await bed.rows(
      `insert into inbound_events (inbound_id, channel, provider_event_id, status, content_kind, failure_code, settled_at, correlation_id)
       values ($1, 'whatsapp', $2, 'rejected', 'rejected', 'foreign_business_number', clock_timestamp(), 'incident-test')`,
      [randomUUID(), `wamid.inc.in.${randomUUID()}`],
    );
    const reopened = find(await view(), INBOUND_SIGNATURE)[0]!;
    expect(reopened).toMatchObject({ count: 7, triage: { ...decided.triage, state: 'reopened' } });
    expect(await bed.rows('select state from incident_triage where signature = $1', [INBOUND_SIGNATURE])).toEqual([{ state: 'ignored' }]);

    const url = 'https://github.com/mistergoliat/R4-agent-platform/issues/999';
    const requested = await triage({ signature: INBOUND_SIGNATURE, state: 'requested', note: 'revisar el filtro', requestUrl: url });
    expect(requested.json()).toMatchObject({ triage: { state: 'requested', requestUrl: url, decidedBy: 'oidc:felipe' } });
    expect(find(await view(), INBOUND_SIGNATURE)[0]!.triage).toMatchObject({ state: 'requested', note: 'revisar el filtro', requestUrl: url });

    const history = await bed.rows<{ state: string; decided_by: string }>('select state, decided_by from incident_triage_events where signature = $1 order by decided_at', [INBOUND_SIGNATURE]);
    expect(history).toEqual([{ state: 'ignored', decided_by: 'oidc:felipe' }, { state: 'requested', decided_by: 'oidc:felipe' }]);
    await expect(bed.rows(`update incident_triage_events set note = 'rewritten'`)).rejects.toThrow(/immutable/);
    await expect(bed.rows('delete from incident_triage_events')).rejects.toThrow(/immutable/);
  });
});

describe('ADR-051 customer_unanswered ignores conversations that already ended', () => {
  it('a cancelled or completed task is not an unanswered customer (production dry run: 7 of 7 were ended tasks)', async () => {
    const before = find(await view(later), 'customer_unanswered:')[0]!;
    const [cancelled, completed] = [tasks.waiting0!, tasks.waiting1!];
    // Runs last: the status change is what an idle close, an operator cancel or a lane retirement leaves behind.
    await bed.rows(`update agent_tasks set status = 'cancelled', status_reason = 'cancelled' where task_id = $1`, [cancelled]);
    await bed.rows(`update agent_tasks set status = 'completed', status_reason = 'run_completed' where task_id = $1`, [completed]);
    const after = find(await view(later), 'customer_unanswered:')[0]!;
    expect(after.count).toBe(before.count - 2);
    expect(after.exampleTaskIds).not.toContain(cancelled);
    expect(after.exampleTaskIds).not.toContain(completed);
  });
});
