import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, type ApiConfig, type Platform } from '@r4/api';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import type { FakeModelStep } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { GET_TEST_FACT_ID } from '../fixtures/capabilities/get-test-fact.js';
import { SET_TEST_RECORD_ID, ensureTestLedger } from '../fixtures/capabilities/test-ledger.js';
import { ACTION_AGENTS_DIR, WRITES, actionCapabilities, createActionTask } from '../support/actions.js';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { complete, propose, read, sequence } from '../support/decisions.js';
import { LiveOpsTestbed, invalid, say } from '../support/live-ops.js';
import { HUMAN, consult, handoff } from '../support/temporal.js';
import { startTestWorker } from '../support/worker.js';

/**
 * ADR-052: releases (per agent version), the generic quality funnel, learning gaps with the curated knowledge base,
 * and autonomy per capability. Deterministic SQL over durable tables; a generic test agent (action-probe) with the
 * test read and write capabilities drives real runs, policy decisions, approvals and receipts.
 */
const KEY = randomBytes(32).toString('base64url');
const ISS = 'https://accounts.google.com';
const SUB = '109876543210987654321';
const TOKEN = 'console-reader-token-0123456789abcdef0123456789';
const BEARER = { authorization: `Bearer ${TOKEN}` };
const PRIVILEGED = 'platform_test.privileged_record';
const APPROVED = 'platform_test.approved_record';
const QUESTION = '¿Puedo escribir a ana@example.com o al +56 9 1234 5678? SECRETO-PREGUNTA';
const ANSWER = 'Sí, al 56987654321 SECRETO-RESPUESTA';
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code: string } }).error?.code;

let db: TestDatabase;
let platform: Platform;
let later: Platform;
const tasks: Record<string, string> = {};
const requests: Record<string, string> = {};

async function run(name: string, steps: FakeModelStep[], create = true): Promise<void> {
  if (create) tasks[name] = await createActionTask(platform, { correlationId: `insights-${name}` });
  const capabilities = actionCapabilities(platform.pool, {}, [{ capabilityId: PRIVILEGED, riskClass: 'PRIVILEGED' }, { capabilityId: APPROVED, approvalPolicy: 'required' }]);
  const w = await startTestWorker(db.url, { workerId: `insights-${name}`, script: sequence(steps), capabilities, policy: WRITES });
  try {
    for (let i = 0; i < 10 && (await w.platform.worker.runOnce()).kind !== 'idle'; i++);
  } finally {
    await w.platform.close();
  }
}
const humanOf = async (taskId: string) => (await platform.temporal.inspect(taskId)).humans.at(-1)!;
const fact = (factKey = 'alpha') => read(GET_TEST_FACT_ID, { factKey });
const write = (capabilityId: string, recordKey: string) => propose(capabilityId, { recordKey, value: 'v1' });

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  const dir = mkdtempSync(join(tmpdir(), 'r4-insights-it-'));
  const operatorsFile = join(dir, 'operators.json');
  writeFileSync(operatorsFile, JSON.stringify([{ issuer: ISS, subject: SUB, operatorRef: 'felipe', scopes: ['knowledge.curate', 'knowledge.sign', 'incident.triage'] }]), { mode: 0o600 });
  const config: ApiConfig = {
    databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: ACTION_AGENTS_DIR, dbPoolMax: 4,
    serviceReaderTokenSha256: createHash('sha256').update(TOKEN).digest('hex'), consoleOperatorKey: KEY, consoleOperatorsFile: operatorsFile, anonymousWrites: 'disabled',
  };
  platform = await createPlatform(config, { logger: createSilentLogger() });
  later = await createPlatform(config, { logger: createSilentLogger(), clock: { now: () => new Date(Date.now() + 2 * 86_400_000) } });
  await ensureTestLedger(platform.pool);

  // v1. Read, then a governed write (allow → succeeded receipt).
  await run('full', [fact(), write(SET_TEST_RECORD_ID, 'full'), complete('done')]);
  // The same capability read four times in one run, then a consultation the human answers.
  await run('consulted', [fact(), fact(), fact('platform.name'), fact(), consult(QUESTION)]);
  requests.consultation = (await humanOf(tasks.consulted!)).requestId;
  await platform.temporal.respondHuman(requests.consultation, { responseKey: 'answer-1', outcome: 'answer', content: ANSWER }, HUMAN);
  // Every runnable task is finished before the next worker starts (a worker claims any runnable task).
  await run('consulted', [complete('used the answer')], false);
  // Denied by policy (privileged), then completes.
  await run('denied', [write(PRIVILEGED, 'denied'), complete('could not')]);
  // Capability approval required: one approved (then executed), one rejected, one still pending.
  await run('approved', [write(APPROVED, 'approved')]);
  await platform.temporal.respondHuman((await humanOf(tasks.approved!)).requestId, { responseKey: 'approve', outcome: 'approve', content: 'ok' }, HUMAN);
  await run('approved', [complete('done after approval')], false);
  await run('rejected', [write(APPROVED, 'rejected')]);
  await platform.temporal.respondHuman((await humanOf(tasks.rejected!)).requestId, { responseKey: 'reject', outcome: 'reject', content: 'no' }, HUMAN);
  await run('rejected', [complete('not approved')], false);
  await run('pending', [write(APPROVED, 'pending')]);
  // The agent hands off (its summary is agent-authored text).
  await run('handed', [handoff('Necesito ayuda: correo cliente@example.org SECRETO-RESUMEN')]);
  requests.agentHandoff = (await humanOf(tasks.handed!)).requestId;
  // A platform hold (as ADR-041 opens it), accepted by an operator with a note.
  tasks.held = await createActionTask(platform);
  requests.platformHandoff = randomUUID();
  await platform.pool.query(
    `insert into human_requests (request_id, task_id, kind, status, payload, created_at, updated_at, correlation_id)
     values ($1, $2, 'handoff', 'requested', $3::jsonb, clock_timestamp(), clock_timestamp(), 'insights-test')`,
    [requests.platformHandoff, tasks.held, JSON.stringify({ summary: 'platform summary SECRETO-PLATAFORMA', contextRefs: [], initiatedBy: 'platform', reason: 'non_retryable_model_failure' })],
  );
  await platform.temporal.respondHuman(requests.platformHandoff, { responseKey: 'accept', outcome: 'accept', content: 'Lo tomo yo' }, HUMAN);
  // Ended conversations: idle close, operator cancel, failure.
  for (const [name, status, reason] of [['idle', 'cancelled', 'idle_timeout'], ['cancelled', 'cancelled', 'cancelled'], ['failed', 'failed', 'run_failed']] as const) {
    tasks[name] = await createActionTask(platform);
    await platform.pool.query('update agent_tasks set status = $2, status_reason = $3 where task_id = $1', [tasks[name], status, reason]);
  }

  // v2 of the same agent: one task that reads.
  const [v1] = await loadAgentDefinitionsFromDirectory(ACTION_AGENTS_DIR);
  await platform.agents.sync([{ ...v1!.definition, version: 2 }]);
  await run('v2', [fact(), complete('v2 done')]);
}, 180_000);

afterAll(async () => {
  await later?.close();
  await platform?.close();
  await db?.drop();
});

function assertion(path: string, body: string, scopes: string[]): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ v: 1, iss: ISS, sub: SUB, scopes, method: 'POST', path, bodySha256: createHash('sha256').update(body).digest('hex'), iat, exp: iat + 60, jti: randomUUID() }),
  ).toString('base64url');
  return `v1.${payload}.${createHmac('sha256', Buffer.from(KEY, 'base64url')).update(`v1.${payload}`).digest('base64url')}`;
}
const post = (path: string, body: object, scopes: string[], headers?: Record<string, string>) => {
  const payload = JSON.stringify(body);
  return platform.app.inject({ method: 'POST', url: path, payload, headers: { 'content-type': 'application/json', ...(headers ?? { 'x-r4-console-assertion': assertion(path, payload, scopes) }) } });
};
async function get<T>(url: string, on: Platform = platform): Promise<T> {
  const res = await on.app.inject({ method: 'GET', url, headers: BEARER });
  expect(res.statusCode, res.body).toBe(200);
  if (!url.startsWith('/v1/learning')) expect(res.body).not.toMatch(/SECRETO|@example|operator-one/);
  return res.json<T>();
}

const READS = ['/v1/production/versions', '/v1/quality/funnel?stage=platform_test', '/v1/learning/gaps', '/v1/learning/knowledge', '/v1/autonomy'];

describe('ADR-052 access and validation', () => {
  it.each(READS)('GET %s opens with the service token and refuses without it', async (url) => {
    await get(url);
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}-wrong` }]) {
      const res = await platform.app.inject({ method: 'GET', url, headers });
      expect([res.statusCode, code(res)]).toEqual([422, 'trusted_human_required']);
    }
  });

  it.each([
    '/v1/production/versions?days=0', '/v1/production/versions?days=32', '/v1/production/versions?other=1',
    '/v1/quality/funnel', '/v1/quality/funnel?stage=', '/v1/quality/funnel?stage=Platform', '/v1/quality/funnel?stage=a%25', `/v1/quality/funnel?stage=${'a'.repeat(65)}`,
    `/v1/quality/funnel?${Array.from({ length: 7 }, (_, i) => `stage=s${i}`).join('&')}`, '/v1/quality/funnel?stage=a&days=0',
    '/v1/learning/gaps?days=32', '/v1/autonomy?days=0', '/v1/autonomy?days=abc', '/v1/learning/knowledge?days=1',
  ])('GET %s is a 400', async (url) => {
    const res = await platform.app.inject({ method: 'GET', url, headers: BEARER });
    expect([res.statusCode, code(res)]).toEqual([400, 'validation_failed']);
  });

  it('windows: defaults 14/14/14/30, and a window that ends before the data is empty', async () => {
    const at = async (url: string, on = platform) => (await get<{ windowDays: number }>(url, on)).windowDays;
    expect([await at('/v1/production/versions'), await at('/v1/quality/funnel?stage=a'), await at('/v1/learning/gaps'), await at('/v1/autonomy')]).toEqual([14, 14, 14, 30]);
    expect(await at('/v1/autonomy?days=31')).toBe(31);
    // Two days from now, a one-day window holds nothing created today.
    expect((await get<{ versions: unknown[] }>('/v1/production/versions?days=1', later)).versions).toEqual([]);
    expect((await get<{ versions: unknown[] }>('/v1/quality/funnel?stage=a&days=1', later)).versions).toEqual([]);
    expect((await get<{ gaps: unknown[] }>('/v1/learning/gaps?days=1', later)).gaps).toEqual([]);
    expect((await get<{ capabilities: unknown[] }>('/v1/autonomy?days=1', later)).capabilities).toEqual([]);
    expect((await get<{ versions: unknown[] }>('/v1/production/versions?days=3', later)).versions).toHaveLength(2);
  });
});

interface Versions { windowDays: number; generatedAt: string; versions: Record<string, unknown>[] }

describe('ADR-052 GET /v1/production/versions', () => {
  it('one row per agent version, newest version first; counts from tasks, runs, handoffs and receipts', async () => {
    const v = await get<Versions>('/v1/production/versions');
    expect(Date.parse(v.generatedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(v.versions.map((r) => [r.agentId, r.agentVersion])).toEqual([['action-probe', 2], ['action-probe', 1]]);
    const [v2, v1] = v.versions as [Record<string, unknown>, Record<string, unknown>];
    for (const r of v.versions) {
      expect(Object.keys(r).sort()).toEqual(['actionsSucceeded', 'agentHandoffs', 'agentId', 'agentVersion', 'capabilityCalls', 'customerTurn', 'failedRuns', 'firstSeen', 'incidents', 'inputTokens', 'lastSeen', 'modelCalls', 'outputTokens', 'platformHandoffs', 'runs', 'tasks'].sort());
      expect(Object.keys(r.incidents as object).sort()).toEqual(['critical', 'high', 'info', 'low', 'medium']);
      expect(Date.parse(r.firstSeen as string)).toBeLessThanOrEqual(Date.parse(r.lastSeen as string));
    }
    const runs = await platform.pool.query<{ agent_version: number; n: string; model_calls: string }>('select agent_version, count(*) as n, sum(model_calls) as model_calls from agent_runs group by 1');
    const db = Object.fromEntries(runs.rows.map((r) => [r.agent_version, r]));
    expect(v2).toMatchObject({ tasks: 1, runs: 1, failedRuns: 0, agentHandoffs: 0, platformHandoffs: 0, actionsSucceeded: {}, customerTurn: { p50Ms: null, p95Ms: null, n: 0 } });
    // full, consulted, denied, approved, rejected, pending, handed, held, idle, cancelled, failed.
    expect(v1).toMatchObject({ tasks: 11, runs: Number(db[1]!.n), modelCalls: Number(db[1]!.model_calls), agentHandoffs: 1, platformHandoffs: 1 });
    expect(v1.actionsSucceeded).toEqual({ [SET_TEST_RECORD_ID]: 1, [APPROVED]: 1 });
    expect(v1.capabilityCalls).toBeGreaterThanOrEqual(5);
  });

  it('incidents are the ADR-051 occurrence counts of that version', async () => {
    const v = await get<Versions>('/v1/production/versions');
    const incidents = (await get<{ incidents: { agentId: string; agentVersion: number; severity: string; count: number }[] }>('/v1/incidents?days=14')).incidents;
    for (const r of v.versions) {
      const expected = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<string, number>;
      for (const i of incidents) if (i.agentId === r.agentId && i.agentVersion === r.agentVersion) expected[i.severity]! += i.count;
      expect(r.incidents).toEqual(expected);
    }
  });
});

interface Funnel { windowDays: number; generatedAt: string; stages: string[]; versions: { agentId: string; agentVersion: number; conversations: number; reached: number[]; handedOff: number; idleClosed: number; cancelled: number; failed: number; repeatedReads: number }[] }

describe('ADR-052 GET /v1/quality/funnel', () => {
  it('generic stages, in the order given: a read with a succeeded observation, or a succeeded receipt', async () => {
    const f = await get<Funnel>('/v1/quality/funnel?stage=platform_test.get&stage=platform_test.set&stage=platform_test.approved&stage=platform_test.privileged&stage=platform_test&stage=other');
    expect(f.stages).toEqual(['platform_test.get', 'platform_test.set', 'platform_test.approved', 'platform_test.privileged', 'platform_test', 'other']);
    expect(f.versions.map((r) => r.agentVersion)).toEqual([2, 1]);
    const [v2, v1] = f.versions;
    expect(v2).toEqual({ agentId: 'action-probe', agentVersion: 2, conversations: 1, reached: [1, 0, 0, 0, 1, 0], handedOff: 0, idleClosed: 0, cancelled: 0, failed: 0, repeatedReads: 0 });
    // get: full + consulted; set: full; approved: only the executed one (rejected/pending have no receipt); privileged: denied (no receipt).
    expect(v1).toEqual({ agentId: 'action-probe', agentVersion: 1, conversations: 11, reached: [2, 1, 1, 0, 3, 0], handedOff: 2, idleClosed: 1, cancelled: 1, failed: 1, repeatedReads: 1 });
  });

  it('a single stage', async () => {
    const f = await get<Funnel>('/v1/quality/funnel?stage=platform_test.set');
    expect(f.stages).toEqual(['platform_test.set']);
    expect(f.versions.find((r) => r.agentVersion === 1)!.reached).toEqual([1]);
  });

  it('`_` in a stage is a literal character, not a pattern', async () => {
    const f = await get<Funnel>('/v1/quality/funnel?stage=platform_tes_&stage=platform');
    expect(f.versions.find((r) => r.agentVersion === 1)!.reached).toEqual([0, 3]);
  });
});

interface Gaps { windowDays: number; generatedAt: string; gaps: Record<string, unknown>[] }

describe('ADR-052 GET /v1/learning/gaps', () => {
  it('consultations and agent/platform handoffs, newest first, with masked text and the human answer', async () => {
    const res = await platform.app.inject({ method: 'GET', url: '/v1/learning/gaps', headers: BEARER });
    expect(res.body).not.toMatch(/ana@example|cliente@example|1234 5678|56987654321|SECRETO-PLATAFORMA|operator-one/);
    const { gaps } = res.json<Gaps>();
    expect(gaps.map((g) => g.requestId)).toEqual([requests.platformHandoff, requests.agentHandoff, requests.consultation]);
    for (const g of gaps) expect(Object.keys(g).sort()).toEqual(['answer', 'createdAt', 'kind', 'reason', 'requestId', 'status', 'taskId', 'text']);
    expect(gaps[0]).toMatchObject({ taskId: tasks.held, kind: 'platform_handoff', status: 'active', text: null, reason: 'non_retryable_model_failure', answer: 'Lo tomo yo' });
    expect(gaps[1]).toMatchObject({ taskId: tasks.handed, kind: 'agent_handoff', status: 'requested', text: 'Necesito ayuda: correo [masked] SECRETO-RESUMEN', reason: null, answer: null });
    expect(gaps[2]).toMatchObject({
      taskId: tasks.consulted, kind: 'consultation', status: 'answered', reason: null,
      text: '¿Puedo escribir a [masked] o al [masked]? SECRETO-PREGUNTA', answer: 'Sí, al [masked] SECRETO-RESPUESTA',
    });
  });
});

interface Autonomy { windowDays: number; generatedAt: string; capabilities: Record<string, unknown>[] }

describe('ADR-052 GET /v1/autonomy', () => {
  it('per agent version and capability: policy outcomes, deny reasons, approvals and receipts', async () => {
    const { capabilities } = await get<Autonomy>('/v1/autonomy');
    expect(capabilities.map((c) => [c.agentVersion, c.capabilityId])).toEqual([[1, APPROVED], [1, PRIVILEGED], [1, SET_TEST_RECORD_ID]]);
    for (const c of capabilities) expect(Object.keys(c).sort()).toEqual(['agentId', 'agentVersion', 'approvals', 'capabilityId', 'decisions', 'denyReasons', 'lastDecisionAt', 'receipts', 'riskClass']);
    const [approved, privileged, set] = capabilities;
    // Three require approval; the approved one is evaluated again (allow, human_approved) and executes.
    expect(approved).toMatchObject({ agentId: 'action-probe', riskClass: 'REVERSIBLE_WRITE', decisions: { allow: 1, deny: 0, requireApproval: 3 }, denyReasons: {}, approvals: { approved: 1, rejected: 1, pending: 1 }, receipts: { succeeded: 1, rejected: 0, failed: 0 } });
    const deny = await platform.pool.query<{ reason_code: string }>(`select reason_code from policy_decisions where capability_id = $1`, [PRIVILEGED]);
    expect(privileged).toMatchObject({ riskClass: 'PRIVILEGED', decisions: { allow: 0, deny: 1, requireApproval: 0 }, denyReasons: { [deny.rows[0]!.reason_code]: 1 }, approvals: { approved: 0, rejected: 0, pending: 0 }, receipts: { succeeded: 0, rejected: 0, failed: 0 } });
    expect(set).toMatchObject({ riskClass: 'REVERSIBLE_WRITE', decisions: { allow: 1, deny: 0, requireApproval: 0 }, receipts: { succeeded: 1, rejected: 0, failed: 0 } });
    const last = await platform.pool.query<{ at: Date }>(`select max(evaluated_at) as at from policy_decisions where capability_id = $1`, [APPROVED]);
    expect(approved!.lastDecisionAt).toBe(last.rows[0]!.at.toISOString());
  });
});

interface Entry { entryId: string; topic: string; statement: string; source: string; sourceRef: string | null; state: string; createdBy: string; createdAt: string; verifiedBy: string | null; verifiedAt: string | null; signedBy: string | null; signedAt: string | null; retiredBy: string | null; retiredAt: string | null; expiresAt: string | null }

describe('ADR-052 knowledge entries', () => {
  const ENTRY = { topic: 'Despacho', statement: 'El armado se agenda después de la entrega.', source: 'respuesta de operador', sourceRef: 'request-123', expiresAt: '2027-01-31' };
  const create = (body: object, scopes = ['knowledge.curate'], headers?: Record<string, string>) => post('/v1/learning/knowledge', body, scopes, headers);
  const move = (body: object, scopes: string[]) => post('/v1/learning/knowledge/transition', body, scopes);

  it('writes need a signed operator with the scope; the service token is refused', async () => {
    for (const [scopes, headers] of [[[], BEARER], [[], {}]] as const) {
      const res = await create(ENTRY, [...scopes], headers);
      expect([res.statusCode, code(res)]).toEqual([422, 'trusted_human_required']);
    }
    const noScope = await create(ENTRY, ['knowledge.sign']);
    expect([noScope.statusCode, code(noScope)]).toEqual([422, 'human_scope_denied']);
    expect((await platform.pool.query('select * from knowledge_entries')).rows).toEqual([]);
  });

  it.each([
    ['empty topic', { ...ENTRY, topic: ' ' }],
    ['long topic', { ...ENTRY, topic: 'x'.repeat(121) }],
    ['long statement', { ...ENTRY, statement: 'x'.repeat(2001) }],
    ['long source', { ...ENTRY, source: 'x'.repeat(301) }],
    ['bad date', { ...ENTRY, expiresAt: '2027-02-30' }],
    ['date with time', { ...ENTRY, expiresAt: '2027-01-31T00:00:00Z' }],
    ['state given', { ...ENTRY, state: 'signed' }],
  ])('create: %s is a 400', async (_name, body) => {
    const res = await create(body);
    expect([res.statusCode, code(res)]).toEqual([400, 'validation_failed']);
  });

  it('proposed → verified → signed → retired, each with its scope; invalid transitions are 409; history is immutable', async () => {
    const created = await create(ENTRY);
    expect(created.statusCode).toBe(201);
    const { entry } = created.json<{ entry: Entry }>();
    expect(entry).toMatchObject({ ...ENTRY, state: 'proposed', createdBy: 'oidc:felipe', verifiedBy: null, verifiedAt: null, signedBy: null, signedAt: null, retiredBy: null, retiredAt: null });
    expect(Object.keys(entry).sort()).toEqual(['createdAt', 'createdBy', 'entryId', 'expiresAt', 'retiredAt', 'retiredBy', 'signedAt', 'signedBy', 'source', 'sourceRef', 'state', 'statement', 'topic', 'verifiedAt', 'verifiedBy']);
    const minimal = (await create({ topic: 'Otro', statement: 'Sin fuente externa', source: 'owner' })).json<{ entry: Entry }>().entry;
    expect(minimal).toMatchObject({ sourceRef: null, expiresAt: null });

    const id = entry.entryId;
    // Signing a proposed entry does not exist; verifying needs curate, not sign.
    expect(code(await move({ entryId: id, to: 'signed', note: 'firma' }, ['knowledge.sign']))).toBe('invalid_transition');
    expect((await move({ entryId: id, to: 'signed', note: 'firma' }, ['knowledge.sign'])).statusCode).toBe(409);
    expect(code(await move({ entryId: id, to: 'verified', note: 'ok' }, ['knowledge.sign']))).toBe('human_scope_denied');
    const verified = await move({ entryId: id, to: 'verified', note: 'revisado' }, ['knowledge.curate']);
    expect(verified.statusCode).toBe(200);
    expect(verified.json<{ entry: Entry }>().entry).toMatchObject({ state: 'verified', verifiedBy: 'oidc:felipe' });
    expect(code(await move({ entryId: id, to: 'verified', note: 'otra vez' }, ['knowledge.curate']))).toBe('invalid_transition');
    expect(code(await move({ entryId: id, to: 'signed', note: 'firma' }, ['knowledge.curate']))).toBe('human_scope_denied');
    const signed = (await move({ entryId: id, to: 'signed', note: 'firmado' }, ['knowledge.sign'])).json<{ entry: Entry }>().entry;
    expect(signed).toMatchObject({ state: 'signed', signedBy: 'oidc:felipe', verifiedAt: expect.any(String) });
    expect(Date.parse(signed.signedAt!)).toBeGreaterThanOrEqual(Date.parse(signed.verifiedAt!));
    const retired = (await move({ entryId: id, to: 'retired', note: 'ya no aplica' }, ['knowledge.curate'])).json<{ entry: Entry }>().entry;
    expect(retired).toMatchObject({ state: 'retired', retiredBy: 'oidc:felipe', signedBy: 'oidc:felipe' });
    expect(code(await move({ entryId: id, to: 'retired', note: 'otra vez' }, ['knowledge.curate']))).toBe('invalid_transition');
    const missing = await move({ entryId: randomUUID(), to: 'verified', note: 'x' }, ['knowledge.curate']);
    expect([missing.statusCode, code(missing)]).toEqual([404, 'knowledge_entry_not_found']);
    for (const body of [{ entryId: id, to: 'proposed', note: 'x' }, { entryId: id, to: 'verified', note: '' }, { entryId: id, to: 'verified', note: 'x'.repeat(501) }, { entryId: 'nope', to: 'verified', note: 'x' }]) {
      expect(code(await move(body, ['knowledge.curate']))).toBe('validation_failed');
    }

    const listed = (await get<{ entries: Entry[] }>('/v1/learning/knowledge')).entries;
    expect(listed.map((e) => e.entryId)).toEqual([minimal.entryId, id]);
    expect(listed[1]).toEqual(retired);

    const history = await platform.pool.query<{ from_state: string | null; to_state: string; note: string | null; decided_by: string }>(
      'select from_state, to_state, note, decided_by from knowledge_entry_events where entry_id = $1 order by decided_at', [id],
    );
    expect(history.rows).toEqual([
      { from_state: null, to_state: 'proposed', note: null, decided_by: 'oidc:felipe' },
      { from_state: 'proposed', to_state: 'verified', note: 'revisado', decided_by: 'oidc:felipe' },
      { from_state: 'verified', to_state: 'signed', note: 'firmado', decided_by: 'oidc:felipe' },
      { from_state: 'signed', to_state: 'retired', note: 'ya no aplica', decided_by: 'oidc:felipe' },
    ]);
    await expect(platform.pool.query(`update knowledge_entry_events set note = 'rewritten'`)).rejects.toThrow(/immutable/);
    await expect(platform.pool.query('delete from knowledge_entry_events')).rejects.toThrow(/immutable/);
  });
});

describe('ADR-052 versions on a live conversation: reply latency and incidents', () => {
  const CUSTOMER = '56944445555';
  let bed: LiveOpsTestbed;
  beforeAll(async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    bed.next(invalid(), say('Claro SECRETO-SALIDA'));
    await bed.customer(CUSTOMER, 'wamid.insights.1', 'Hola SECRETO-ENTRADA');
    await bed.runAgent();
    await bed.deliver();
  }, 120_000);
  afterAll(async () => {
    await bed?.close();
  });

  it('customerTurn from the console turn definition; incidents attributed to the version', async () => {
    const res = await bed.api.app.inject({ method: 'GET', url: '/v1/production/versions' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/SECRETO|56944445555/);
    const [row, ...others] = res.json<Versions>().versions;
    expect(others).toEqual([]);
    const turn = row!.customerTurn as { p50Ms: number; p95Ms: number; n: number };
    expect(turn.n).toBe(1);
    expect(turn.p50Ms).toBe(turn.p95Ms);
    expect(turn.p50Ms).toBeGreaterThanOrEqual(0);
    // The invalid answer: a failed run (medium) and an invalid step (low).
    expect(row).toMatchObject({ tasks: 1, failedRuns: 1, incidents: { critical: 0, high: 0, medium: 1, low: 1, info: 0 } });
  });
});
