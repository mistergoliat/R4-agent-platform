import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping } from '@r4-adapters/domains';
import { FakeModelProvider, type FakeModelScript, type FakeModelStep, type ModelRequest } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresExecutionStore, PostgresProductionStore, migrate, type Pool } from '@r4/persistence-postgres';
import { ExecutionRuntime, TemporalRuntime } from '@r4/task-runtime';
import { systemClock, uuidV7Generator, type TrustedHumanContext } from '@r4/contracts';
import { CAPABILITY_IDS, ContextView, add, read, respond, update, type ScriptedStep } from '@r4-sales/agent';
import { runProductionControl } from '@r4-sales/agent/production';
import {
  CanaryAdmission,
  SYNTHETIC_CHANNEL,
  assertIsolatedCanaryDatabase,
  canaryStatus,
  initCanary,
  loadCanaryEnvironment,
  openCanaryApprovals,
  readCanaryDatabase,
  sendSynthetic,
  startCanaryRuntime,
  syntheticConversationKey,
  type CanaryEnvironment,
  type CanaryRuntime,
} from '@r4-sales/agent/canary';
import { runCanary } from '../../agents/sales/src/cli/canary/command.js';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { LiveOpsTestbed, say } from '../support/live-ops.js';

/**
 * R4-J3D-R: the isolated Sales canary and the read-only approval inspection.
 *
 * "production" here is a LiveOpsTestbed database (gateway + worker of a
 * production composition, a WhatsApp conversation with a runnable task);
 * the canary runs sales-production@4 on its own marked database with a
 * scripted stand-in model and fixture owners bound as HTTP-kind ports.
 * Every scenario asserts the production database is untouched.
 *
 * The approval decision itself is made ONLY by a test-only operator
 * context, through `TemporalRuntime.respondHuman` (as every other
 * integration test of approvals does) — never by the canary or control
 * CLIs, which refuse it.
 */
const logger = createSilentLogger();
const IDENTITY_KEY = 'r4-test-canary-identity-key-0123456789abcdef';
const TEST_ONLY_OPERATOR: TrustedHumanContext = { humanRef: 'test-only-operator', scopes: ['approval.decide'], correlationId: 'sales-canary-test' };

let production: LiveOpsTestbed;
let canaryDb: TestDatabase;
let captureDir: string;

/** A fixture owner presented as the HTTP-kind binding @4 requires (methods stay bound to the fixture: private state intact). */
const http = <T extends object>(port: T): T & { bindingKind: string } =>
  new Proxy(port, { get: (target, key) => (key === 'bindingKind' ? 'http' : typeof Reflect.get(target, key) === 'function' ? (Reflect.get(target, key) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key)) }) as T & { bindingKind: string };

function canaryEnv(db: TestDatabase, allowlist: readonly string[] = [], extra: Record<string, string> = {}): Record<string, string> {
  const base = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@4', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY,
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: db.url, R4_LOG_LEVEL: 'silent',
  };
  const keys = allowlist.map((c) => syntheticConversationKey(loadCanaryEnvironment(base), c));
  return { ...base, R4_PROD_ROLLOUT_ALLOWLIST: keys.join(','), ...extra };
}

/** Durable state of a database that the canary must never change (counts + migration ledger + marker). */
async function fingerprintOf(pool: Pool): Promise<unknown> {
  const q = async (sql: string): Promise<unknown[]> => (await pool.query(sql)).rows as unknown[];
  return {
    marker: (await readCanaryDatabase(pool)).canaryId,
    migrations: await q('select id, checksum from r4_schema_migrations order by id'),
    tasks: await q('select task_id, status, updated_at from agent_tasks order by task_id'),
    runs: await q('select run_id, status from agent_runs order by run_id'),
    bindings: await q('select binding_id, channel, status from channel_conversation_bindings order by binding_id'),
    inbound: await q('select inbound_id, status from inbound_events order by inbound_id'),
    outbound: await q('select outbound_id, status from outbound_messages order by outbound_id'),
    controls: await q('select scope, autonomy_enabled, version from autonomy_controls order by scope'),
  };
}

function owners() {
  const catalog = new FixtureCatalog();
  const shipping = new FixtureShipping();
  const quotes = new FixtureQuoteV2Service();
  return { catalog, shipping, quotes, bindings: { catalog: http(catalog), shipping: http(shipping), quotes: http(quotes) } };
}

/**
 * The scripted stand-in model, routed per task: the canary database is shared by the scenarios, so a
 * runtime may claim tasks of earlier scenarios first. Unrouted tasks just wait for the customer.
 */
type RawStep = (request: ModelRequest) => FakeModelStep;
const RAW = new WeakSet<object>();
const raw = (fn: RawStep): RawStep => {
  RAW.add(fn);
  return fn;
};
type Step = ScriptedStep | RawStep;
class Router {
  readonly #routes = new Map<string, { steps: readonly Step[]; next: number }>();
  readonly script: FakeModelScript = (request) => {
    const taskId = (request.context!.sections.task.find((i) => i.kind === 'task')!.content as { taskId: string }).taskId;
    const route = this.#routes.get(taskId);
    if (!route) return { type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'not part of this scenario' } };
    const step = route.steps[route.next++];
    if (!step) return { type: 'provider_error', message: `no scripted step ${route.next} for this task` };
    return RAW.has(step) ? (step as RawStep)(request) : { type: 'structured', data: (step as ScriptedStep)(new ContextView(request)) };
  };

  route(taskId: string, steps: readonly Step[]): string {
    this.#routes.set(taskId, { steps, next: 0 });
    return taskId;
  }
}

const workerConfig = (db: TestDatabase, workerId: string) => ({
  databaseUrl: db.url, logLevel: 'silent' as const, dbPoolMax: 3, workerId, leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
  execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 50 },
  context: { budget: { mode: 'unbounded' as const } },
});

async function canaryRuntime(canary: CanaryEnvironment, db: TestDatabase, router: Router, owned = owners(), workerId = 'sales-canary:test:1'): Promise<{ runtime: CanaryRuntime; owned: ReturnType<typeof owners> }> {
  const runtime = await startCanaryRuntime(canary, {
    modelProvider: new FakeModelProvider(router.script), ...owned.bindings, worker: workerConfig(db, workerId), scheduler: null, captureFile: join(captureDir, `${workerId.replace(/[^a-z0-9]/gi, '_')}.jsonl`), logger, isolationCheckMs: 50,
  });
  return { runtime, owned };
}

async function drain(runtime: CanaryRuntime, maxCycles = 20): Promise<string[]> {
  const cycles: string[] = [];
  for (let i = 0; i < maxCycles; i += 1) {
    const cycle = await runtime.worker.worker.runOnce();
    if (cycle.kind === 'idle') break;
    cycles.push(cycle.kind);
  }
  await runtime.delivery.tick();
  return cycles;
}

/** A test-only Temporal Runtime over the canary database (for the test-only operator decision). */
function temporalOver(pool: Pool): TemporalRuntime {
  const ids = uuidV7Generator(systemClock);
  const store = new PostgresExecutionStore(pool);
  return new TemporalRuntime({ store, execution: new ExecutionRuntime({ store, ids, clock: systemClock, logger, maxRunRecoveries: 0 }), ids, logger });
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

// The governed quote path of sales-production@4: catalog evidence → selection → quote.create@2 proposal (REQUIRE_APPROVAL).
const BAR = { itemKey: 'BAR-OLY20', quantity: 1, unitPrice: { amount: 129_990, taxBasis: 'included', taxRate: '0.19' } };
const proposeQuoteV2: ScriptedStep = (v: ContextView) => ({
  type: 'propose_action',
  capabilityId: CAPABILITY_IDS.quoteCreate,
  arguments: { workspaceVersion: v.workspace.workspaceVersion, customer: { kind: 'guest' }, lines: [BAR], shipping: null, expectedTotals: { net: 109_235, tax: 20_755, gross: 129_990 }, currency: 'CLP' },
  evidenceRefs: v.quoteEvidence(),
});
const toApproval: ScriptedStep[] = [read(CAPABILITY_IDS.productContext, { productKey: 'BAR-OLY20' }), update([add('BAR-OLY20')]), proposeQuoteV2];

beforeAll(async () => {
  captureDir = mkdtempSync(join(tmpdir(), 'r4-canary-'));
  production = await LiveOpsTestbed.start({ allowlist: ['56911111111'], autonomy: true });
  // A real production conversation with a runnable task the canary must never see.
  expect((await production.customer('56911111111', 'wamid.prod-1', 'Hola')).status).toBe(200);
  canaryDb = await createTestDatabase('r4_it_canary');
});

afterAll(async () => {
  await production?.close();
  await canaryDb?.drop();
});

describe('canary environment and database guards (nothing is changed on a refused database)', () => {
  it('runs sales-production@4 only, needs its own database URL, and never the production one', () => {
    expect(() => loadCanaryEnvironment({ ...canaryEnv(canaryDb), R4_PROD_POLICY_PROFILE: 'sales-production@3' })).toThrow(/runs sales-production@4 only/);
    expect(() => loadCanaryEnvironment({ ...canaryEnv(canaryDb), R4_CANARY_DATABASE_URL: '' })).toThrow(/R4_CANARY_DATABASE_URL/);
    expect(() => loadCanaryEnvironment({ ...canaryEnv(canaryDb), R4_DATABASE_URL: canaryDb.url })).toThrow(expect.objectContaining({ code: 'canary_shares_production_database' }));
    expect(() => loadCanaryEnvironment({ ...canaryEnv(canaryDb), R4_EXECUTION_MODE: '' })).toThrow(expect.objectContaining({ code: 'production_mode_not_declared' }));
  });

  it('refuses the production database (name, then marker) and a non-empty unmarked canary-named database, leaving both untouched', async () => {
    const before = await fingerprintOf(production.pool);
    const prod = loadCanaryEnvironment({ ...canaryEnv(canaryDb), R4_CANARY_DATABASE_URL: production.db.url });
    await expect(initCanary(prod, logger)).rejects.toMatchObject({ code: 'canary_database_name' });
    await expect(sendSynthetic(prod, { conversation: 'c0', text: 'hola' }, logger)).rejects.toMatchObject({ code: 'canary_database_name' });
    expect(await runCanary(['status'], { ...canaryEnv(canaryDb), R4_CANARY_DATABASE_URL: production.db.url }, io().io)).toBe(0);
    expect(await fingerprintOf(production.pool)).toEqual(before);

    // A database whose name says canary but that already holds an R4 schema without the marker.
    const lookalike = await createTestDatabase('r4_it_canary_lookalike');
    const pool = openPool(lookalike.url);
    try {
      await migrate(pool);
      const env = loadCanaryEnvironment(canaryEnv(lookalike));
      await expect(initCanary(env, logger)).rejects.toMatchObject({ code: 'not_a_canary_database' });
      await expect(sendSynthetic(env, { conversation: 'c0', text: 'hola' }, logger)).rejects.toMatchObject({ code: 'canary_marker_missing' });
      expect((await readCanaryDatabase(pool)).canaryId).toBeNull();
    } finally {
      await pool.end();
      await lookalike.drop();
    }
  });
});

describe('canary init and synthetic ingress', () => {
  it('marks, migrates, registers Sales and enables autonomy only in the canary database; re-init is a no-op', async () => {
    const canary = loadCanaryEnvironment(canaryEnv(canaryDb));
    const first = await initCanary(canary, logger);
    expect(first).toMatchObject({ markerCreated: true, autonomy: 'enabled', migrations: { sales: ['0006_sales_reference_application', '0007_sales_quote_v2_issuance'] } });
    expect(first.definitions.registered.length).toBeGreaterThan(0);
    expect(first.migrations.core.length).toBeGreaterThan(0);
    const again = await initCanary(canary, logger);
    expect(again).toMatchObject({ canaryId: first.canaryId, markerCreated: false, migrations: { core: [], sales: [] }, definitions: { registered: [] }, autonomy: 'already_enabled' });
    const pool = openPool(canaryDb.url);
    try {
      expect((await pool.query("select changed_by, reason from autonomy_control_events order by occurred_at desc limit 1")).rows[0]).toEqual({ changed_by: 'platform:sales-canary', reason: 'isolated Sales canary database (synthetic traffic only)' });
    } finally {
      await pool.end();
    }
  });

  it('a synthetic conversation outside the canary rollout is refused; inside it opens a provisional Sales@4 task through the real ingress', async () => {
    await expect(sendSynthetic(loadCanaryEnvironment(canaryEnv(canaryDb)), { conversation: 'c1', text: 'Hola' }, logger)).rejects.toMatchObject({ code: 'synthetic_conversation_not_eligible' });
    const canary = loadCanaryEnvironment(canaryEnv(canaryDb, ['c1']));
    const outcome = await sendSynthetic(canary, { conversation: 'c1', text: 'Quiero una barra olímpica' }, logger);
    expect(outcome).toMatchObject({ kind: 'ingested', taskCreated: true, disposition: 'autonomous' });
    const pool = openPool(canaryDb.url);
    try {
      const store = new PostgresProductionStore(pool);
      const binding = (await store.bindingByTask((outcome as { taskId: string }).taskId))!;
      expect(binding).toMatchObject({ channel: SYNTHETIC_CHANNEL, accountRef: 'sales-canary', recipientRef: 'synthetic:c1', autonomy: 'autonomous', profile: 'sales-production@4' });
      const task = (await pool.query('select agent_version, requested_by_kind, requested_by_ref from agent_tasks where task_id = $1', [binding.taskId])).rows[0];
      expect(task).toEqual({ agent_version: 4, requested_by_kind: 'service', requested_by_ref: 'sales-channel-ingress' });
      // Replaying the same synthetic event identity is a duplicate, never a second input.
      const replay = await sendSynthetic(canary, { conversation: 'c1', text: 'otra', eventId: 'fixed-1' }, logger);
      expect((await sendSynthetic(canary, { conversation: 'c1', text: 'otra', eventId: 'fixed-1' }, logger)).kind).toBe('duplicate');
      expect(replay.kind).toBe('ingested');
    } finally {
      await pool.end();
    }
  });
});

describe('governed sales-production@4 path in the canary, up to and through the approval', () => {
  it('reaches REQUIRE_APPROVAL; the inspection shows the exact arguments; both CLIs refuse to decide; nothing executes', async () => {
    const canary = loadCanaryEnvironment(canaryEnv(canaryDb, ['q1']));
    const prodBefore = await fingerprintOf(production.pool);
    const router = new Router();
    const { runtime, owned } = await canaryRuntime(canary, canaryDb, router);
    try {
      const sent = await sendSynthetic(canary, { conversation: 'q1', text: 'Cotízame una barra olímpica' }, logger);
      const taskId = router.route((sent as { taskId: string }).taskId, toApproval);
      await drain(runtime);
      const { inspection, close } = await openCanaryApprovals(canary, logger);
      let requestId: string;
      try {
        const approvals = (await inspection.list()).filter((a) => a.task.taskId === taskId);
        expect(approvals).toHaveLength(1);
        const approval = approvals[0]!;
        requestId = approval.requestId;
        expect(approval).toMatchObject({
          status: 'requested', task: { status: 'requires_approval' }, conversation: { channel: SYNTHETIC_CHANNEL, profile: 'sales-production@4' },
          action: { capabilityId: 'quote.create', capabilityVersion: 2 },
          arguments: { hashVerified: true, validated: { customer: { kind: 'guest' }, lines: [BAR], shipping: null, expectedTotals: { net: 109_235, tax: 20_755, gross: 129_990 } } },
        });
        expect(await inspection.show(requestId)).toEqual(approval);
      } finally {
        await close();
      }
      // Read-only output through the canary CLI (exact arguments and the decision blocker).
      const shown = io();
      expect(await runCanary(['approvals', 'show', '--request', requestId], canaryEnv(canaryDb, ['q1']), shown.io)).toBe(0);
      expect(JSON.parse(shown.out.join('\n'))).toMatchObject({ approval: { requestId, arguments: { hashVerified: true } }, decision: expect.stringMatching(/trusted human identity/) });
      // Neither CLI can decide: refused before reading configuration or the database.
      for (const verb of ['approve', 'reject']) {
        const c = io();
        expect(await runCanary(['approvals', verb, '--request', requestId, '--reason', 'test'], canaryEnv(canaryDb, ['q1']), c.io)).toBe(1);
        expect(c.err.join('\n')).toMatch(/^error: trusted_human_required:/);
        const p = io();
        expect(await runProductionControl(['approvals', verb, '--request', requestId, '--reason', 'test'], {}, p.io)).toBe(1);
        expect(p.err.join('\n')).toMatch(/^error: trusted_human_required:/);
        expect(p.out).toEqual([]);
      }
      const pool = openPool(canaryDb.url);
      try {
        expect((await pool.query('select status from human_requests where request_id = $1', [requestId])).rows[0]).toEqual({ status: 'requested' });
        expect((await pool.query("select count(*)::int as n from temporal_events where entity_id = $1 and event_type in ('approval.approved', 'approval.rejected', 'approval.cancelled')", [requestId])).rows[0]).toEqual({ n: 0 });
      } finally {
        await pool.end();
      }
      expect(owned.quotes.createCalls).toBe(0);
      expect(await fingerprintOf(production.pool)).toEqual(prodBefore);
    } finally {
      await runtime.close();
    }
  });

  it('with a TEST-ONLY operator: approve → Policy Engine re-evaluation → ActionExecutor → Quote V2 issued → reply captured locally', async () => {
    const canary = loadCanaryEnvironment(canaryEnv(canaryDb, ['q2']));
    const prodBefore = await fingerprintOf(production.pool);
    const quoted = (v: ContextView) => (v.observations(CAPABILITY_IDS.quoteCreate).filter((o) => o.outcome === 'succeeded').at(-1)!.payload as { result: { quoteNumber: string } }).result.quoteNumber;
    const router = new Router();
    const { runtime, owned } = await canaryRuntime(canary, canaryDb, router, owners(), 'sales-canary:test:approve');
    const pool = openPool(canaryDb.url);
    try {
      const taskId = router.route(((await sendSynthetic(canary, { conversation: 'q2', text: 'Cotízame una barra olímpica' }, logger)) as { taskId: string }).taskId, [...toApproval, respond((v) => `Cotización ${quoted(v)} emitida.`)]);
      await drain(runtime);
      const request = (await temporalOver(pool).attention()).requests.find((r) => r.taskId === taskId && r.kind === 'approval')!;
      await temporalOver(pool).respondHuman(request.requestId, { responseKey: 'test-approve-1', outcome: 'approve', content: 'test-only approval' }, TEST_ONLY_OPERATOR);
      await drain(runtime);
      expect(owned.quotes.quotes).toHaveLength(1);
      expect((await pool.query("select status from action_receipts where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows).toEqual([{ status: 'succeeded' }]);
      const captured = readFileSync(runtime.capture.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { recipientRef: string; text: string });
      expect(captured).toEqual([expect.objectContaining({ recipientRef: 'synthetic:q2', text: 'Cotización PC-000001 emitida.' })]);
      expect((await pool.query('select status, provider_message_id from outbound_messages where task_id = $1', [taskId])).rows).toEqual([{ status: 'accepted', provider_message_id: expect.stringMatching(/^capture:/) }]);
      expect(await fingerprintOf(production.pool)).toEqual(prodBefore);
    } finally {
      await pool.end();
      await runtime.close();
    }
  });

  it('with a TEST-ONLY operator: reject → the agent observes approval_rejected; nothing is issued', async () => {
    const canary = loadCanaryEnvironment(canaryEnv(canaryDb, ['q3']));
    const router = new Router();
    const { runtime, owned } = await canaryRuntime(canary, canaryDb, router, owners(), 'sales-canary:test:reject');
    const pool = openPool(canaryDb.url);
    try {
      const taskId = router.route(((await sendSynthetic(canary, { conversation: 'q3', text: 'Cotízame una barra olímpica' }, logger)) as { taskId: string }).taskId, [...toApproval, respond('No pude emitir la cotización.')]);
      await drain(runtime);
      const request = (await temporalOver(pool).attention()).requests.find((r) => r.taskId === taskId && r.kind === 'approval')!;
      await temporalOver(pool).respondHuman(request.requestId, { responseKey: 'test-reject-1', outcome: 'reject', content: 'test-only rejection' }, TEST_ONLY_OPERATOR);
      await drain(runtime);
      expect(owned.quotes.createCalls).toBe(0);
      const observed = (await pool.query("select error_code from observations where task_id = $1 and capability_id = 'quote.create' order by created_at desc limit 1", [taskId])).rows[0];
      expect(observed).toEqual({ error_code: 'approval_rejected' });
      expect(readFileSync(runtime.capture.file, 'utf8')).toMatch(/No pude emitir la cotización/);
    } finally {
      await pool.end();
      await runtime.close();
    }
  });
});

describe('isolation under errors, restarts and recovery', () => {
  it('a model failure is recovered by a new run inside the canary database; production is never claimed', async () => {
    const canary = loadCanaryEnvironment(canaryEnv(canaryDb, ['e1']));
    const prodBefore = await fingerprintOf(production.pool);
    const router = new Router();
    const { runtime } = await canaryRuntime(canary, canaryDb, router, owners(), 'sales-canary:test:error');
    try {
      const taskId = router.route(((await sendSynthetic(canary, { conversation: 'e1', text: 'Hola' }, logger)) as { taskId: string }).taskId, [raw(() => ({ type: 'provider_error', message: 'transient outage', retryable: true })), respond('Recuperado.')]);
      await drain(runtime);
      const pool = openPool(canaryDb.url);
      try {
        expect((await pool.query('select status from agent_runs where task_id = $1 order by sequence', [taskId])).rows.map((r: { status: string }) => r.status)).toEqual(['failed', expect.not.stringMatching(/failed/)]);
      } finally {
        await pool.end();
      }
      expect(readFileSync(runtime.capture.file, 'utf8')).toMatch(/Recuperado\./);
      // The canary worker never ran anything in production; production's runnable task is still there.
      expect(await fingerprintOf(production.pool)).toEqual(prodBefore);
    } finally {
      await runtime.close();
    }
  });

  it('inbound that arrives while the canary is down is served after a restart; production and canary workers never see each other\'s tasks', async () => {
    const canary = loadCanaryEnvironment(canaryEnv(canaryDb, ['r1']));
    const router = new Router();
    const first = await canaryRuntime(canary, canaryDb, router, owners(), 'sales-canary:test:restart-a');
    await first.runtime.close();
    const taskId = router.route(((await sendSynthetic(canary, { conversation: 'r1', text: 'Hola' }, logger)) as { taskId: string }).taskId, [respond('Después del reinicio.')]);
    const second = await canaryRuntime(canary, canaryDb, router, owners(), 'sales-canary:test:restart-b');
    try {
      await drain(second.runtime);
      expect(readFileSync(second.runtime.capture.file, 'utf8')).toMatch(/Después del reinicio\./);
      const canaryPool = openPool(canaryDb.url);
      try {
        expect((await canaryPool.query('select count(*)::int as n from agent_runs where task_id = $1', [taskId])).rows[0]).toEqual({ n: 1 });
        const canaryBefore = await fingerprintOf(canaryPool);
        // The production worker serves production's own conversation and nothing of the canary.
        production.next(say('Hola desde producción'));
        await production.runAgent();
        expect((await production.rows<{ status: string }>("select t.status from agent_tasks t join channel_conversation_bindings b on b.task_id = t.task_id where b.channel = 'whatsapp'")).map((r) => r.status)).not.toContain('pending');
        expect((await production.rows('select count(*)::int as n from channel_conversation_bindings where channel = $1', [SYNTHETIC_CHANNEL]))[0]).toEqual({ n: 0 });
        expect(await fingerprintOf(canaryPool)).toEqual(canaryBefore);
      } finally {
        await canaryPool.end();
      }
    } finally {
      await second.runtime.close();
    }
  });

  it('foreign channel traffic in the canary database stops admission, refuses every command and stops a running canary', async () => {
    const db = await createTestDatabase('r4_it_canary_foreign');
    const canary = loadCanaryEnvironment(canaryEnv(db, ['f1']));
    try {
      await initCanary(canary, logger);
      const router = new Router();
      const { runtime } = await canaryRuntime(canary, db, router, owners(), 'sales-canary:test:foreign');
      const pool = openPool(db.url);
      try {
        const taskId = router.route(((await sendSynthetic(canary, { conversation: 'f1', text: 'Hola' }, logger)) as { taskId: string }).taskId, [respond('no debería correr')]);
        // Real-channel traffic appears in the canary database (e.g. a production gateway pointed at it by mistake).
        const store = new PostgresProductionStore(pool);
        await store.openBinding({ bindingId: '00000000-0000-7000-8000-00000000f001', channel: 'whatsapp', conversationKey: 'a'.repeat(64), accountRef: 'x', recipientRef: 'y', autonomy: 'autonomous', eligibilityReason: 'allowlisted', rolloutFingerprint: 'r', profile: 'sales-production@4', profileFingerprint: 'p' });
        await expect(assertIsolatedCanaryDatabase(pool)).rejects.toMatchObject({ code: 'canary_isolation_violated' });
        expect(await new CanaryAdmission(pool, { admit: () => Promise.resolve({ admitted: true, reason: 'autonomy_enabled' }) }).admit()).toEqual({ admitted: false, reason: 'canary_isolation_violated' });
        expect((await runtime.worker.worker.runOnce()).kind).toBe('idle');
        expect((await pool.query('select count(*)::int as n from agent_runs where task_id = $1', [taskId])).rows[0]).toEqual({ n: 0 });
        await expect(sendSynthetic(canary, { conversation: 'f1', text: 'otra' }, logger)).rejects.toMatchObject({ code: 'canary_isolation_violated' });
        await expect(openCanaryApprovals(canary, logger)).rejects.toMatchObject({ code: 'canary_isolation_violated' });
        expect(await canaryStatus(canary, logger)).toMatchObject({ isolation: 'canary_isolation_violated', foreignTraffic: { bindings: 1 } });
        runtime.start();
        await expect(runtime.violation).resolves.toBe('canary_isolation_violated');
        expect(existsSync(runtime.capture.file)).toBe(false);
      } finally {
        await pool.end();
        await runtime.close();
      }
    } finally {
      await db.drop();
    }
  });
});
