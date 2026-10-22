import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping } from '@r4-adapters/domains';
import { PLATFORM_MARKERS } from '@r4-adapters/identity-verification';
import { FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { createPool, type Pool } from '@r4/persistence-postgres';
import { CAPABILITY_IDS, ContextView, read, respond, type ScriptedStep } from '@r4-sales/agent';
import {
  CANARY_GATEWAY_LOCK,
  canaryRollbackStatus,
  connectedGateways,
  initCanary,
  loadCanaryEnvironment,
  purgeCanary,
  sendSynthetic,
  startCanaryGateway,
  startCanaryRuntime,
  syntheticConversationKey,
  type CanaryEnvironment,
  type CanaryGateway,
  type CanaryRuntime,
} from '@r4-sales/agent/canary';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * R4-J4-R5 preparation: the isolated canary tooling of sales-production@8 against PostgreSQL. Synthetic only:
 * the CIA and Customer Profile are in-process stubs (no network), Catalog, Shipping and Quote are fixtures, the
 * model is scripted. Nothing is deployed and J4-R5 is NOT run: these tests prove the tooling's guarantees.
 */
const logger = createSilentLogger();
const IDENTITY_KEY = 'r4-test-canary-identity-key-j4-r5-tooling-0001';
const KEYRING = `k1:${Buffer.alloc(32, 5).toString('base64')}`;
const CIA = 'http://127.0.0.1:8787';
const CUSTOMER_ENV = {
  R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BASE_URL: CIA, R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'synthetic-r4-sales-agent-token-0001', R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '1500',
  R4_CUSTOMER_PROFILE_BASE_URL: 'http://127.0.0.1:3010', R4_CUSTOMER_PROFILE_BEARER_TOKEN: 'synthetic-r4-sales-cp-token-0123456789abcdefghij', R4_CUSTOMER_PROFILE_TIMEOUT_MS: '3000',
};
/** The gateway-role environment: the keyring and the channel-integration credential (never the worker's). */
const GATEWAY_ENV = { R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BASE_URL: CIA, R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: 'synthetic-channel-confirm-token-0001', R4_PROD_VERIFICATION_CODE_KEYS: KEYRING };
const LIMITS = {
  R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '500000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '3', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '5', R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: '5',
  R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '1', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '20', R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '900',
};
const CONVERSATIONS = ['otp', 'after-rollback', 'other'];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const utc = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
/** The worker side of the CIA (agent credential): start answers 202; resolve answers not_verified. */
const workerCia = (url: string): Promise<Response> => {
  if (url === `${CIA}/v1/identity/verifications`) return Promise.resolve(json(202, { schemaVersion: 1, verificationId: 'VfSyntheticCanaryJ4R5x', status: 'challenge_issued', expiresAt: utc(Date.now() + 600_000), resendAvailableAt: utc(Date.now() + 60_000) }));
  if (url === `${CIA}/v1/identity/resolve`) return Promise.resolve(json(200, { schemaVersion: 1, status: 'not_verified', resolvedAt: utc(Date.now() - 1_000) }));
  return Promise.reject(new Error(`unexpected worker call ${url}`));
};
/** The gateway side of the CIA (confirm): records every request; answers what the test decides. */
function confirmStub(answer: () => Response) {
  const calls: { key: string | null; body: string }[] = [];
  const transport = (url: string, init: RequestInit): Promise<Response> => {
    if (url !== `${CIA}/v1/identity/verifications/confirm`) return Promise.reject(new Error(`unexpected gateway call ${url}`));
    calls.push({ key: new Headers(init.headers).get('idempotency-key'), body: init.body as string });
    return Promise.resolve(answer());
  };
  return { calls, transport };
}

const http = <T extends object>(port: T): T & { bindingKind: string } =>
  new Proxy(port, { get: (target, key) => (key === 'bindingKind' ? 'http' : typeof Reflect.get(target, key) === 'function' ? (Reflect.get(target, key) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key)) }) as T & { bindingKind: string };

class Router {
  readonly #routes = new Map<string, { steps: readonly ScriptedStep[]; next: number }>();
  readonly script: FakeModelScript = (request) => {
    const taskId = (request.context!.sections.task.find((i) => i.kind === 'task')!.content as { taskId: string }).taskId;
    const route = this.#routes.get(taskId);
    const step = route?.steps[route.next++];
    if (!step) return { type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'end of the scenario' } };
    return { type: 'structured', data: step(new ContextView(request)) };
  };

  route(taskId: string, steps: readonly ScriptedStep[]): void {
    this.#routes.set(taskId, { steps, next: 0 });
  }
}

let db: TestDatabase | null = null;
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c.close().catch(() => undefined);
  await db?.drop();
  db = null;
});

function canaryFor(profile: string, overrides: Record<string, string> = {}): CanaryEnvironment {
  const base = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY, R4_PROD_ALLOW_NETWORK: 'false',
    R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: db!.url, R4_LOG_LEVEL: 'silent', R4_CANARY_CONTEXT_EXPIRED_EVIDENCE: 'exclude', ...LIMITS, ...overrides,
  };
  const keys = CONVERSATIONS.map((c) => syntheticConversationKey(loadCanaryEnvironment({ ...base, R4_PROD_POLICY_PROFILE: 'sales-production@7', R4_CANARY_TEST_HOSTS: '' }), c));
  return loadCanaryEnvironment({ ...base, R4_PROD_ROLLOUT_ALLOWLIST: keys.join(',') });
}

const poolFor = (name: string): Pool => createPool({ connectionString: db!.url, logger, applicationName: `r4-sales-canary:${name}`, max: 2 });

async function gateway(canary: CanaryEnvironment, transport: (url: string, init: RequestInit) => Promise<Response>, requested: 'full' | 'protect_only' = 'full'): Promise<CanaryGateway> {
  const g = await startCanaryGateway(canary, { env: GATEWAY_ENV, logger, openPool: poolFor, requested, transport });
  open.push(g);
  return g;
}

async function runtime(canary: CanaryEnvironment, router: Router, name: string, options: { expiredEvidence?: 'include' | 'exclude'; customer?: boolean } = {}): Promise<CanaryRuntime> {
  const r = await startCanaryRuntime(canary, {
    modelProvider: new FakeModelProvider(router.script), catalog: http(new FixtureCatalog()), shipping: http(new FixtureShipping()), quotes: http(new FixtureQuoteV2Service()),
    worker: {
      databaseUrl: db!.url, logLevel: 'silent', dbPoolMax: 3, workerId: `canary-j4:${name}`, leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
      execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 50 },
      context: { budget: { mode: 'unbounded' }, expiredEvidence: options.expiredEvidence ?? 'exclude' },
    },
    scheduler: null, captureFile: join(mkdtempSync(join(tmpdir(), 'r4-canary-j4-')), `${name}.jsonl`), logger, isolationCheckMs: 60_000,
    ...(options.customer === false ? {} : { customer: { env: CUSTOMER_ENV, fetch: workerCia } }),
  });
  open.push(r);
  return r;
}

async function drain(r: CanaryRuntime): Promise<void> {
  for (let i = 0; i < 30; i += 1) if ((await r.worker.worker.runOnce()).kind === 'idle') break;
  await r.delivery.tick();
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * TEST ONLY: simulates the passage of the protection grace (≤ 20 min) instead of waiting for it. The schema forbids
 * shrinking a window (trigger protection_cannot_shrink), so this one transaction disables triggers locally.
 */
async function elapseProtectionWindows(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    // The whole timeline moves back together (the window still covers the challenge: protection_covers_challenge).
    await client.query(
      `update identity_verification.expectations
          set created_at = least(created_at, clock_timestamp() - interval '2 hours'),
              challenge_expires_at = case when challenge_expires_at is null then null else clock_timestamp() - interval '1 hour' end,
              protect_until = clock_timestamp() - interval '1 second'
        where protect_until > clock_timestamp()`,
    );
    await client.query('commit');
  } finally {
    client.release();
  }
}

const EMAIL = 'ana.canary@synthetic.test';
const CODE = '481920';

describe('the single canary gateway of sales-production@8', () => {
  it('refuses a second gateway and a platform gateway; @8 refuses to run or ingest without its gateway', async () => {
    db = await createTestDatabase('r4_it_canary_j4_gateway');
    const canary = canaryFor('sales-production@8');
    await initCanary(canary, logger);
    const router = new Router();
    await expect(runtime(canary, router, 'no-gateway')).rejects.toMatchObject({ code: 'canary_gateway_not_running' });
    await expect(sendSynthetic(canary, { conversation: 'other', text: 'hola' }, logger, undefined, GATEWAY_ENV)).rejects.toMatchObject({ code: 'canary_gateway_not_running' });
    const g1 = await gateway(canary, confirmStub(() => json(503, { error: 'unavailable' })).transport);
    expect(g1.mode).toBe('full');
    await expect(gateway(canary, confirmStub(() => json(503, {})).transport)).rejects.toMatchObject({ code: 'canary_gateway_replica' });
    await g1.close();
    const platformGateway = createPool({ connectionString: db.url, logger, applicationName: 'r4-gateway:intruder', max: 1 });
    try {
      await platformGateway.query('select 1');
      await expect(gateway(canary, confirmStub(() => json(503, {})).transport)).rejects.toMatchObject({ code: 'canary_gateway_replica' });
    } finally {
      await platformGateway.end();
    }
  }, 120_000);

  it('singleton: of concurrent starts exactly one wins; it holds while every other connection of the winner is gone', async () => {
    db = await createTestDatabase('r4_it_canary_j4_singleton');
    const canary = canaryFor('sales-production@8');
    await initCanary(canary, logger);
    const starts = await Promise.allSettled([1, 2, 3, 4].map(() => gateway(canary, confirmStub(() => json(503, {})).transport)));
    expect(starts.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of starts) if (s.status === 'rejected') expect(s.reason).toMatchObject({ code: 'canary_gateway_replica' });
    const pool = openPool(db.url);
    try {
      // What a reaped idle pool looks like: the idle connections of the winner go; its lock connection stays.
      await pool.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = current_database() and application_name like 'r4-sales-canary:gateway:%' and state = 'idle'
            and pid not in (select pid from pg_locks where locktype = 'advisory' and classid = $1::oid and objid = $2::oid)`,
        [...CANARY_GATEWAY_LOCK],
      );
      expect(await connectedGateways(pool)).toEqual({ canary: 1, platform: 0 });
      await expect(gateway(canary, confirmStub(() => json(503, {})).transport)).rejects.toMatchObject({ code: 'canary_gateway_replica' });
    } finally {
      await pool.end();
    }
  }, 120_000);

  it('crash recovery: a killed gateway process releases the lock; a gateway whose lock connection dies stops (fail closed)', async () => {
    db = await createTestDatabase('r4_it_canary_j4_crash');
    const canary = canaryFor('sales-production@8');
    await initCanary(canary, logger);
    const pool = openPool(db.url);
    try {
      // A separate process holds the singleton, then dies without any cleanup (SIGKILL).
      const holder = `const pg = require('pg'); const c = new pg.Client({ connectionString: process.argv[1], application_name: 'r4-sales-canary:gateway:crashed' });
        c.connect().then(() => c.query('select pg_try_advisory_lock($1::int, $2::int) as won', [Number(process.argv[2]), Number(process.argv[3])]))
         .then((r) => { process.stdout.write(r.rows[0].won ? 'locked\\n' : 'refused\\n'); setInterval(() => undefined, 60_000); });`;
      const child = spawn(process.execPath, ['-e', holder, db.url, ...CANARY_GATEWAY_LOCK.map(String)], { cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: ['ignore', 'pipe', 'inherit'] });
      const said = await new Promise<string>((done) => child.stdout.once('data', (b: Buffer) => done(b.toString().trim())));
      expect(said).toBe('locked');
      await expect(gateway(canary, confirmStub(() => json(503, {})).transport)).rejects.toMatchObject({ code: 'canary_gateway_replica' });
      child.kill('SIGKILL');
      expect(await until(() => connectedGateways(pool), (g) => g.canary === 0)).toEqual({ canary: 0, platform: 0 });
      const g = await gateway(canary, confirmStub(() => json(503, {})).transport);

      // The server side of a crash (or a network loss): the lock connection dies. The gateway stops itself.
      await pool.query(`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and classid = $1::oid and objid = $2::oid`, [...CANARY_GATEWAY_LOCK]);
      await expect(g.lost).resolves.toBe('canary_gateway_lock_lost');
      expect(await canaryRollbackStatus(pool)).toMatchObject({ liveGateways: 0 });
      await expect(runtime(canary, new Router(), 'after-lost')).rejects.toMatchObject({ code: 'canary_gateway_not_running' });
      const next = await gateway(canary, confirmStub(() => json(503, {})).transport);
      expect(next.mode).toBe('full');
    } finally {
      await pool.end();
    }
  }, 120_000);
});

describe('sales-production@8 OTP flow in the canary: inspected ingest, dispatcher restart and recovery', () => {
  it('the code never reaches the conversation; a confirm interrupted by a gateway restart resumes with the same key and links the account', async () => {
    db = await createTestDatabase('r4_it_canary_j4_otp');
    const canary = canaryFor('sales-production@8');
    await initCanary(canary, logger);
    const down = confirmStub(() => json(503, { error: 'temporarily_unavailable' }));
    let g = await gateway(canary, down.transport);
    const router = new Router();
    const r = await runtime(canary, router, 'otp');
    const pool = openPool(db.url);
    try {
      const { taskId } = (await sendSynthetic(canary, { conversation: 'otp', text: `Quiero ver mi historial de compras, mi correo es ${EMAIL}` }, logger, undefined, GATEWAY_ENV)) as { taskId: string };
      router.route(taskId, [
        () => ({ type: 'propose_action', capabilityId: 'identity.start_verification', arguments: { email: EMAIL } }),
        respond('Te envié un código de 6 dígitos. Respóndeme solo con el código.'),
        read('identity.verification_status', {}),
        respond((v: ContextView) => `Estado: ${(v.observations('identity.verification_status').at(-1)!.payload as { status: string }).status}`),
      ]);
      await drain(r);
      expect((await pool.query("select status from action_receipts where task_id = $1 and capability_id = 'identity.start_verification'", [taskId])).rows).toEqual([{ status: 'succeeded' }]);

      await sendSynthetic(canary, { conversation: 'otp', text: CODE }, logger, undefined, GATEWAY_ENV);
      // The gateway's dispatcher tries the CIA (503: retry). Then the gateway restarts with the CIA back.
      await until(() => Promise.resolve(down.calls.length), (n) => n >= 1);
      await g.close();
      const up = confirmStub(() => json(200, { schemaVersion: 1, outcome: 'linked' }));
      g = await gateway(canary, up.transport);
      const state = await until(async () => (await pool.query<{ state: string; cia_outcome: string | null }>('select state, cia_outcome from identity_verification.expectations where task_id = $1', [taskId])).rows[0], (row) => row?.state === 'confirmed');
      expect(state).toEqual({ state: 'confirmed', cia_outcome: 'linked' });
      // Same idempotency key and identical body before and after the restart (plan §4.4).
      expect(new Set([...down.calls, ...up.calls].map((c) => `${c.key}|${c.body}`)).size).toBe(1);

      // The dispatcher resumed the task with a marker that carries no outcome; the model reads the platform state.
      await until(async () => (await pool.query('select count(*)::int as n from task_inputs where task_id = $1', [taskId])).rows[0]!.n as number, (n) => n >= 3);
      await drain(r);
      expect((await pool.query("select payload from observations where task_id = $1 and capability_id = 'identity.verification_status'", [taskId])).rows).toEqual([{ payload: { status: 'account_linked' } }]);

      // The code reached no persisted text: the inbound holds the platform marker, never the digits.
      const texts = (await pool.query<{ t: string }>('select x::text as t from inbound_events x union all select y::text from task_inputs y union all select z::text from outbound_messages z union all select w::text from identity_verification.responses w')).rows.map((x) => x.t).join('\n');
      expect(texts).not.toContain(CODE);
      // The canonical text is cleared once durable; its hash proves what was persisted for the code message: the marker.
      const hashes = (await pool.query<{ h: string }>('select content_sha256 as h from inbound_events')).rows.map((x) => x.h);
      expect(hashes).toContain(createHash('sha256').update(PLATFORM_MARKERS.codeReceived).digest('hex'));
      expect(hashes).not.toContain(createHash('sha256').update(CODE).digest('hex'));
    } finally {
      await pool.end();
    }
  }, 180_000);
});

describe('rollback @8 → @7 (full → protect_only → absent), the @7 known limitation and the verifiable purge', () => {
  it('@7 is refused until protect_only, every window expired and no gateway; then it runs, and a Customer request fails unknown_capability and recovers', async () => {
    db = await createTestDatabase('r4_it_canary_j4_rollback');
    const at8 = canaryFor('sales-production@8');
    await initCanary(at8, logger);
    const g = await gateway(at8, confirmStub(() => json(503, {})).transport);
    const router = new Router();
    const r8 = await runtime(at8, router, 'rollback-8');
    const pool = openPool(db.url);
    try {
      const { taskId } = (await sendSynthetic(at8, { conversation: 'otp', text: `Revisa mis compras, mi correo es ${EMAIL}` }, logger, undefined, GATEWAY_ENV)) as { taskId: string };
      router.route(taskId, [() => ({ type: 'propose_action', capabilityId: 'identity.start_verification', arguments: { email: EMAIL } }), respond('Código enviado.')]);
      await drain(r8);
      await r8.close();

      const at7 = canaryFor('sales-production@7');
      const statusOf = () => canaryRollbackStatus(pool);
      expect(await statusOf()).toMatchObject({ mode: 'full', liveGateways: 1, ready: false });
      expect((await statusOf()).openProtections).toBeGreaterThan(0);
      await expect(runtime(at7, router, 'rollback-7-early', { customer: false })).rejects.toMatchObject({ code: 'canary_rollback_not_ready' });
      await expect(sendSynthetic(at7, { conversation: 'after-rollback', text: 'hola' }, logger)).rejects.toMatchObject({ code: 'canary_rollback_not_ready' });

      // Step 1: protect_only (no keyring, no confirm). Step 2: the windows expire (simulated). Step 3: the gateway stops.
      await g.close();
      const protect = await gateway(at8, confirmStub(() => json(503, {})).transport, 'protect_only');
      expect(protect.mode).toBe('protect_only');
      expect(await statusOf()).toMatchObject({ mode: 'protect_only', liveGateways: 1, ready: false });
      // Redaction holds in protect_only: a code sent inside the open window reaches no persisted text (the marker does).
      await sendSynthetic(at8, { conversation: 'otp', text: CODE }, logger, undefined, {});
      const texts = (await pool.query<{ t: string }>('select x::text as t from inbound_events x union all select y::text from task_inputs y union all select z::text from outbound_messages z union all select w::text from identity_verification.responses w')).rows.map((x) => x.t).join('\n');
      expect(texts).not.toContain(CODE);
      const hashes = (await pool.query<{ h: string }>('select content_sha256 as h from inbound_events')).rows.map((x) => x.h);
      expect(hashes).not.toContain(createHash('sha256').update(CODE).digest('hex'));
      // Gateway stopped, but a protection window is still open: still refused (no ingest without the inspector).
      await protect.close();
      const waiting = await statusOf();
      expect(waiting).toMatchObject({ mode: 'protect_only', liveGateways: 0, ready: false });
      expect(waiting.openProtections).toBeGreaterThan(0);
      await expect(runtime(at7, router, 'rollback-7-window', { customer: false })).rejects.toMatchObject({ code: 'canary_rollback_not_ready' });
      await expect(sendSynthetic(at7, { conversation: 'after-rollback', text: CODE }, logger)).rejects.toMatchObject({ code: 'canary_rollback_not_ready' });
      await expect(sendSynthetic(at8, { conversation: 'otp', text: CODE }, logger, undefined, GATEWAY_ENV)).rejects.toMatchObject({ code: 'canary_gateway_not_running' });
      await elapseProtectionWindows(pool);
      expect(await statusOf()).toEqual({ mode: 'protect_only', openProtections: 0, openStarts: 0, liveGateways: 0, ready: true });

      // @7 now runs. Its known limitation (v7 names customer.get_context without registering it): the run fails
      // unknown_capability and ADR-028 recovers it with a new run; the task is not lost.
      const r7 = await runtime(at7, router, 'rollback-7', { customer: false });
      const after = (await sendSynthetic(at7, { conversation: 'after-rollback', text: '¿Qué compré la última vez?' }, logger)) as { taskId: string };
      router.route(after.taskId, [read(CAPABILITY_IDS.customerContext, {}), respond('No tengo acceso a tu historial; te ayudo con el catálogo.')]);
      await drain(r7);
      expect((await pool.query('select agent_version from agent_tasks where task_id = $1', [after.taskId])).rows).toEqual([{ agent_version: 7 }]);
      expect((await pool.query<{ r: string }>("select status || ':' || coalesce(termination_code, '') as r from agent_runs where task_id = $1 order by created_at", [after.taskId])).rows.map((x) => x.r)).toEqual(['failed:unknown_capability', 'suspended:waiting']);
      await r7.close();

      // Purge: refused with the wrong id or while a component is connected; then every data table is empty.
      const busy = poolFor('worker-straggler');
      await busy.query('select 1');
      const canaryId = (await pool.query<{ c: string }>("select substr(shobj_description(oid, 'pg_database'), length('r4-sales-canary:v1:') + 1) as c from pg_database where datname = current_database()")).rows[0]!.c;
      const purgePool = createPool({ connectionString: db.url, logger, applicationName: 'r4-sales-canary-purge', max: 1 });
      try {
        await expect(purgeCanary(purgePool, 'not-this-one')).rejects.toMatchObject({ code: 'canary_purge_not_confirmed' });
        await expect(purgeCanary(purgePool, canaryId)).rejects.toMatchObject({ code: 'canary_purge_busy' });
        await busy.end();
        await pool.end();
        const evidence = await purgeCanary(purgePool, canaryId);
        expect(evidence.rowsRemaining).toBe(0);
        expect(Object.values(evidence.after).every((n) => n === 0)).toBe(true);
        expect(evidence.before['public.agent_tasks']).toBeGreaterThan(0);
        expect(evidence.before['identity_verification.expectations']).toBeGreaterThan(0);
        expect(evidence.realCustomers).toEqual({ foreignTraffic: { bindings: 0, inbound: 0, outbound: 0 }, nonCanaryAccounts: 0 });
        expect(evidence.preserved).toEqual(['public.r4_schema_migrations', 'public.agent_definitions']);
        expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
        // The marker, the ledger and the definitions remain: the database is still a provable, current canary.
        expect((await purgePool.query<{ n: number }>('select count(*)::int as n from agent_definitions')).rows[0]!.n).toBeGreaterThan(0);
        expect((await purgePool.query<{ m: string }>("select shobj_description(oid, 'pg_database') as m from pg_database where datname = current_database()")).rows[0]!.m).toBe(`r4-sales-canary:v1:${canaryId}`);
      } finally {
        await purgePool.end();
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
  }, 180_000);
});

describe('no real identities, no production routes; one expired-evidence policy for every arm', () => {
  it('@8 refuses real mode, non-synthetic credentials and hosts outside the closed allowlist; a paired @7 arm must run the same policy', async () => {
    db = await createTestDatabase('r4_it_canary_j4_guards');
    const canary = canaryFor('sales-production@8');
    await initCanary(canary, logger);
    await gateway(canary, confirmStub(() => json(503, {})).transport);
    const router = new Router();
    const compose = (env: Record<string, string>) =>
      startCanaryRuntime(canary, {
        modelProvider: new FakeModelProvider(router.script), catalog: http(new FixtureCatalog()), shipping: http(new FixtureShipping()), quotes: http(new FixtureQuoteV2Service()),
        worker: { databaseUrl: db!.url, logLevel: 'silent', dbPoolMax: 2, workerId: 'guards', leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1, execution: { maxIterations: 5, maxModelCalls: 5, maxReadCapabilityCalls: 5, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 5 }, context: { budget: { mode: 'unbounded' }, expiredEvidence: 'exclude' } },
        scheduler: null, captureFile: join(tmpdir(), 'r4-canary-j4-guards.jsonl'), logger, customer: { env },
      });
    await expect(compose({ ...CUSTOMER_ENV, R4_CUSTOMER_MODE: 'real' })).rejects.toThrow(/R4_CUSTOMER_MODE=real is refused/);
    await expect(compose({ ...CUSTOMER_ENV, R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'prod-r4-sales-agent-token-000000000001' })).rejects.toThrow(/synthetic credential/);
    await expect(compose({ ...CUSTOMER_ENV, R4_CUSTOMER_IDENTITY_BASE_URL: 'https://cia.unlisted.example' })).rejects.toThrow(/explicitly allowed synthetic test host/);
    await expect(compose({ ...CUSTOMER_ENV, ...GATEWAY_ENV })).rejects.toThrow(/belong to the channel gateway only/);
    await expect(runtime(canary, router, 'include', { expiredEvidence: 'include' })).rejects.toMatchObject({ code: 'canary_expired_evidence_mismatch' });
  }, 120_000);
});
