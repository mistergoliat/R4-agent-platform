import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort } from '@r4-adapters/domains';
import { AutonomyControls } from '@r4/live-ops';
import { FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresProductionStore, type Pool } from '@r4/persistence-postgres';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS, ContextView, read, respond, type ScriptedStep } from '@r4-sales/agent';
import { initCanary, loadCanaryEnvironment, sendSynthetic, startCanaryRuntime, syntheticConversationKey, type CanaryEnvironment, type CanaryRuntime } from '@r4-sales/agent/canary';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { RECONCILIATION_POLICY, freezeTemporalClock } from '../support/temporal.js';

/**
 * R4-J3E-C1: sales-production@7 end to end through the isolated canary — real
 * ChannelIngress (synthetic channel), the production worker composition,
 * Policy Engine, ActionExecutor, the real delivery owner capturing locally,
 * the REAL ProductionStore.thread and the REAL durable kill switch of the
 * canary database. Scripted stand-in model; fixture owners as HTTP-kind ports.
 */
const logger = createSilentLogger();
const IDENTITY_KEY = 'r4-test-canary-identity-key-deterministic-offer-01';
let canaryDb: TestDatabase;
let captureDir: string;

const http = <T extends object>(port: T): T & { bindingKind: string } =>
  new Proxy(port, { get: (target, key) => (key === 'bindingKind' ? 'http' : typeof Reflect.get(target, key) === 'function' ? (Reflect.get(target, key) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key)) }) as T & { bindingKind: string };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const LIMITS = {
  R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '500000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '3', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '5', R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: '5',
  R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '1', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '20', R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '900',
};
const CONVERSATIONS = ['do-exact', 'do-own-summary', 'do-kill-switch', 'do-held-customer-writes', 'do-held-resume', 'do-held-budget'];

function canaryEnv(): Record<string, string> {
  const base = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@7', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY,
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: canaryDb.url, R4_LOG_LEVEL: 'silent', ...LIMITS,
  };
  const keys = CONVERSATIONS.map((c) => syntheticConversationKey(loadCanaryEnvironment(base), c));
  return { ...base, R4_PROD_ROLLOUT_ALLOWLIST: keys.join(',') };
}

class Router {
  readonly #routes = new Map<string, { steps: readonly ScriptedStep[]; next: number }>();
  /** Runs once, inside the next model call (mid-run: after the worker's admission). */
  beforeModel: null | (() => Promise<void>) = null;
  readonly script: FakeModelScript = async (request) => {
    const hook = this.beforeModel;
    this.beforeModel = null;
    if (hook) await hook();
    const taskId = (request.context!.sections.task.find((i) => i.kind === 'task')!.content as { taskId: string }).taskId;
    const route = this.#routes.get(taskId);
    if (!route) return { type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'not part of this scenario' } };
    const step = route.steps[route.next++];
    if (!step) return { type: 'provider_error', message: `no scripted step ${route.next} for this task` };
    return { type: 'structured', data: step(new ContextView(request)) };
  };

  route(taskId: string, steps: readonly ScriptedStep[]): string {
    this.#routes.set(taskId, { steps, next: 0 });
    return taskId;
  }
}

const workerConfig = (workerId: string) => ({
  databaseUrl: canaryDb.url, logLevel: 'silent' as const, dbPoolMax: 3, workerId, leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
  execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 50 },
  context: { budget: { mode: 'unbounded' as const } },
});

/** Owners; `onCatalogRead` lets a scenario act while issuance is deciding (it reads Catalog). */
function owners() {
  const base = new FixtureCatalog();
  const hooks = { onCatalogRead: null as null | (() => Promise<void>) };
  const catalog: CatalogPort = {
    search: (...a) => base.search(...a),
    getProductContext: (...a) => base.getProductContext(...a),
    getItemContext: async (...a) => {
      const hook = hooks.onCatalogRead;
      hooks.onCatalogRead = null;
      if (hook) await hook();
      return base.getItemContext(...a);
    },
  };
  return { catalog, hooks, shipping: new FixtureShipping(), quotes: new FixtureQuoteV2Service() };
}

/** `scheduler`: the generic scheduler (action_retry release, reconciliation dispatch), stepped by `drain`. */
async function canaryRuntime(canary: CanaryEnvironment, router: Router, owned: ReturnType<typeof owners>, workerId: string, options: { scheduler?: boolean; maxRunDurationMs?: number } = {}): Promise<CanaryRuntime> {
  const worker = workerConfig(workerId);
  return startCanaryRuntime(canary, {
    modelProvider: new FakeModelProvider(router.script), catalog: http(owned.catalog), shipping: http(owned.shipping), quotes: http(owned.quotes),
    worker: options.maxRunDurationMs ? { ...worker, execution: { ...worker.execution, maxRunDurationMs: options.maxRunDurationMs } } : worker,
    scheduler: options.scheduler ? { databaseUrl: canaryDb.url, logLevel: 'silent', dbPoolMax: 2, owner: `${workerId}:scheduler`, leaseMs: 30_000, pollMs: 25, reconciliationPolicy: RECONCILIATION_POLICY } : null,
    captureFile: join(captureDir, `${workerId.replace(/[^a-z0-9]/gi, '_')}.jsonl`), logger, isolationCheckMs: 50,
  });
}

async function drain(runtime: CanaryRuntime, maxCycles = 30): Promise<void> {
  for (let i = 0; i < maxCycles; i += 1) {
    const fired = (await runtime.scheduler?.scheduler.runOnce())?.kind === 'fired';
    const cycle = await runtime.worker.worker.runOnce();
    if (cycle.kind === 'idle' && !fired) break;
  }
  await runtime.delivery.tick();
}

const workspace = (operations: (v: ContextView) => unknown[]): ScriptedStep => (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate, arguments: { operations: operations(v) } });
const ORDER = [{ productId: 'BAR-OLY20', quantity: 1 }, { productId: 'BAR-EZ', quantity: 2 }];
const latest = (v: ContextView, capabilityId: string) => v.observations(capabilityId).filter((o) => o.outcome === 'succeeded').at(-1)!;
const courier = (v: ContextView) => (latest(v, CAPABILITY_IDS.shippingQuote).payload as { offers: { carrierName: string; serviceType: string; price: { ownerNet: { amount: number } } }[] }).offers.find((o) => o.carrierName === 'Fixture Courier')!;
const preview = (v: ContextView) => latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).payload as { previewId: string; presentation: { reference: string; totalText: string; offerMessage: string; offerMessageSha256: string } };
const lastQuote = (v: ContextView) => v.observations(CAPABILITY_IDS.quoteCreate).at(-1)!;
const propose: ScriptedStep = (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.quoteCreate, arguments: { previewId: preview(v).previewId }, evidenceRefs: [latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).observationId] });
const outcome = respond((v) => {
  const o = lastQuote(v);
  return o.outcome === 'succeeded' ? `Cotización ${(o.payload as { result: { quoteNumber: string } }).result.quoteNumber} emitida.` : `No se emitió: ${o.error?.code ?? o.outcome}`;
});
const TURN_1: ScriptedStep[] = [
  workspace(() => [...ORDER.map((i) => ({ op: 'add_item', ...i })), { op: 'set_delivery_destination', commune: 'Ñuñoa' }]),
  read(CAPABILITY_IDS.shippingQuote, { destination: { commune: 'Ñuñoa' }, basis: 'order', items: ORDER }),
  respond((v) => `Despacho a Ñuñoa: ${courier(v).carrierName} ${courier(v).serviceType}. ¿Cuál prefieres?`),
];
const CHOOSE_AND_PREVIEW: ScriptedStep[] = [
  workspace((v) => [{ op: 'select_shipping_offer', carrierName: courier(v).carrierName, serviceType: courier(v).serviceType, ownerNetClp: courier(v).price.ownerNet.amount }]),
  read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}),
];
const EXACT_OFFER = respond((v) => preview(v).presentation.offerMessage);
/** What a model that ignores the v7 instruction writes: its own summary, with the reference and the total (enough for @6). */
const OWN_SUMMARY = respond((v) => `Barra olímpica ×1 y Barra Z ×2 con despacho. ${preview(v).presentation.totalText} · Ref. ${preview(v).presentation.reference}. ¿Emito la cotización?`);

beforeAll(async () => {
  captureDir = mkdtempSync(join(tmpdir(), 'r4-deterministic-offer-canary-'));
  canaryDb = await createTestDatabase('r4_it_det_offer_canary');
  const init = await initCanary(loadCanaryEnvironment(canaryEnv()), logger);
  expect(init.definitions.registered).toEqual(expect.arrayContaining(['sales@7']));
});

afterAll(async () => {
  await canaryDb?.drop();
});

async function converse(canary: CanaryEnvironment, runtime: CanaryRuntime, router: Router, conversation: string, steps: ScriptedStep[], texts: string[]): Promise<string> {
  const first = (await sendSynthetic(canary, { conversation, text: texts[0]! }, logger)) as { taskId: string };
  const taskId = router.route(first.taskId, steps);
  await drain(runtime);
  for (const text of texts.slice(1)) {
    await sendSynthetic(canary, { conversation, text }, logger);
    await drain(runtime);
  }
  return taskId;
}

const captured = (runtime: CanaryRuntime) => readFileSync(runtime.capture.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { text: string });

describe('sales-production@7 in the isolated canary: the customer confirms the exact offer Sales wrote', () => {
  it('the delivered offer IS the Sales rendering; "Sí, emítela." → quote.create@5 allow/autonomous → one quote; the evidence hash equals the delivered text', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    const router = new Router();
    const owned = owners();
    const runtime = await canaryRuntime(canary, router, owned, 'sales-canary:test:do-exact');
    const pool = openPool(canaryDb.url);
    try {
      const taskId = await converse(canary, runtime, router, 'do-exact', [...TURN_1, ...CHOOSE_AND_PREVIEW, EXACT_OFFER, propose, outcome], ['Quiero una barra olímpica y dos barras Z, despacho a Ñuñoa', 'Fixture Courier normal', 'Sí, emítela.']);
      expect(owned.quotes.quotes).toHaveLength(1);
      expect((await pool.query("select capability_version, outcome, reason_code, policy_id from policy_decisions where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows).toEqual([{ capability_version: 5, outcome: 'allow', reason_code: 'autonomous', policy_id: 'sales-production-autonomous-policy' }]);
      expect((await pool.query("select status, capability_version from action_receipts where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows).toEqual([{ status: 'succeeded', capability_version: 5 }]);
      expect((await pool.query('select count(*)::int as n from human_requests where task_id = $1', [taskId])).rows[0]).toEqual({ n: 0 });
      // The offer the provider took is byte for byte the message Sales rendered, and the evidence binds its hash.
      const offerText = captured(runtime).find((m) => m.text.startsWith('Cotización lista para emitir'))!.text;
      const decision = (await pool.query<{ quote_request: { offerTemplate: string; offerMessageSha256: string } }>('select quote_request from sales.quote_autonomous_decisions where task_id = $1', [taskId])).rows[0]!;
      const evidence = (await pool.query<{ offer_text_sha256: string; offer_delivery_status: string }>('select offer_text_sha256, offer_delivery_status from sales.quote_intent_evidence where task_id = $1', [taskId])).rows[0]!;
      expect(decision.quote_request.offerTemplate).toBe('r4-sales-offer-es-v1');
      expect([evidence.offer_text_sha256, decision.quote_request.offerMessageSha256]).toEqual([sha256(offerText), sha256(offerText)]);
      expect(evidence.offer_delivery_status).toBe('accepted');
      expect(captured(runtime).at(-1)!.text).toBe('Cotización PC-000001 emitida.');
      expect((await pool.query("select count(*)::int as n from outbound_messages where channel <> 'r4-synthetic'")).rows[0]).toEqual({ n: 0 });
    } finally {
      await pool.end();
      await runtime.close();
    }
  });

  it('a model that writes its own summary is refused (offer_not_presented); after the exact offer, the confirmation issues once', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    const router = new Router();
    const owned = owners();
    const runtime = await canaryRuntime(canary, router, owned, 'sales-canary:test:do-own-summary');
    const pool = openPool(canaryDb.url);
    try {
      const taskId = await converse(canary, runtime, router, 'do-own-summary', [...TURN_1, ...CHOOSE_AND_PREVIEW, OWN_SUMMARY, propose, EXACT_OFFER, propose, outcome], ['Quiero una barra olímpica y dos barras Z, despacho a Ñuñoa', 'Fixture Courier normal', 'Sí, emítela.', 'Sí, emítela.']);
      expect(owned.quotes.quotes).toHaveLength(1);
      expect((await pool.query<{ outcome: string; reason_code: string }>('select outcome, reason_code from sales.quote_autonomous_decisions where task_id = $1 order by decided_at', [taskId])).rows.map((r) => `${r.outcome}:${r.reason_code}`)).toEqual(['rejected:offer_not_presented', 'authorized:eligible']);
      expect((await pool.query<{ status: string }>("select status from action_receipts where task_id = $1 and capability_id = 'quote.create' order by recorded_at", [taskId])).rows.map((r) => r.status)).toEqual(['rejected', 'succeeded']);
    } finally {
      await pool.end();
      await runtime.close();
    }
  });

});

/** The canary's REAL durable kill switch (autonomy_controls of the canary database). */
function killSwitch(pool: Pool): (enabled: boolean) => Promise<void> {
  const controls = new AutonomyControls({ store: new PostgresProductionStore(pool), logger });
  return (enabled) => controls.set({ scope: 'global', autonomyEnabled: enabled, reason: enabled ? 'test: release' : 'test: kill switch', changedBy: 'it-deterministic-offer-canary', correlationId: `ks-${enabled}` }).then(() => undefined);
}

/** The task's quote.create command as PostgreSQL holds it: execution, attempt log, receipt, retry schedules, Sales decisions and sends. */
async function quoteLedger(pool: Pool, taskId: string) {
  const q = async <T extends object>(sql: string) => (await pool.query<T>(sql, [taskId])).rows;
  const executions = await q<{ execution_key: string; status: string; initial_backoff_ms: number }>("select execution_key, status, initial_backoff_ms from action_executions where task_id = $1 and capability_id = 'quote.create'");
  const key = executions[0]?.execution_key ?? null;
  return {
    key,
    executions: executions.map((e) => e.status),
    attempts: (await q<{ a: string }>("select a.attempt_number || ':' || a.kind || ':' || coalesce(a.outcome, 'open') || ':' || coalesce(a.error_code, '-') as a from action_execution_attempts a join action_executions e using (execution_id) where e.task_id = $1 and e.capability_id = 'quote.create' order by a.attempt_number")).map((r) => r.a),
    receipts: await q<{ status: string; error_code: string | null; execution_key: string }>("select status, error_code, execution_key from action_receipts where task_id = $1 and capability_id = 'quote.create'"),
    retries: (await q<{ status: string }>("select status from schedules where task_id = $1 and kind = 'action_retry' order by created_at")).map((r) => r.status),
    decisions: (await q<{ d: string }>("select outcome || ':' || reason_code as d from sales.quote_autonomous_decisions where task_id = $1 order by decided_at")).map((r) => r.d),
    sends: (await q<{ n: number }>('select count(*)::int as n from sales.quote_v2_sends s join sales.quote_v2_requests r using (execution_key) where r.task_id = $1'))[0]!.n,
  };
}

const latestRetryDue = async (pool: Pool, taskId: string) => (await pool.query<{ due_at: Date }>("select due_at from schedules where task_id = $1 and kind = 'action_retry' order by created_at desc limit 1", [taskId])).rows[0]!.due_at;
const restoreTemporalClock = (pool: Pool) => pool.query('create or replace function r4_now() returns timestamptz language sql volatile as $$ select clock_timestamp() $$');
const OFFER_TURNS = ['Quiero una barra olímpica y dos barras Z, despacho a Ñuñoa', 'Fixture Courier normal'];

/**
 * R4-J3E-C1 (pre-commit correction A): the kill switch over quote.create@5 through the platform lifecycle —
 * worker admission, kernel, ActionRuntime + ActionExecutor, durable action_retry backoff, the generic scheduler
 * and the worker's dispatched reconciliation — never by calling the handler. "Held" is engaged after the
 * authorization (while quote.create@5 reads Catalog to decide); "before the decision" is engaged inside the
 * model call that proposes it (the run was admitted before).
 */
describe('sales-production@7 kill switch: what happens to the issuance, lifecycle end to end', () => {
  it('engaged mid-run before the issuance decides: refused before any decision (failed/autonomy_disabled), nothing authorized; the reply is held and delivered on release', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    const router = new Router();
    const owned = owners();
    const runtime = await canaryRuntime(canary, router, owned, 'sales-canary:test:do-kill-switch');
    const pool = openPool(canaryDb.url);
    const set = killSwitch(pool);
    try {
      const taskId = await converse(canary, runtime, router, 'do-kill-switch', [...TURN_1, ...CHOOSE_AND_PREVIEW, EXACT_OFFER, propose, outcome], OFFER_TURNS);
      router.beforeModel = () => set(false);
      await sendSynthetic(canary, { conversation: 'do-kill-switch', text: 'Sí, emítela.' }, logger);
      await drain(runtime);
      expect(owned.quotes.createCalls).toBe(0);
      const ledger = await quoteLedger(pool, taskId);
      expect(ledger).toMatchObject({ executions: ['failed'], attempts: ['1:execute:failed:autonomy_disabled'], receipts: [{ status: 'failed', error_code: 'autonomy_disabled' }], decisions: [], sends: 0 });
      // The run finished (a run is never interrupted mid-run); its reply is held, not sent, while autonomy is disabled.
      const reply = (await pool.query<{ status: string; hold_reason: string | null }>('select status, hold_reason from outbound_messages where task_id = $1 order by created_at desc limit 1', [taskId])).rows[0]!;
      expect(reply).toEqual({ status: 'pending', hold_reason: 'autonomy_disabled' });
      await set(true);
      await runtime.delivery.tick();
      expect(captured(runtime).at(-1)!.text).toBe('No se emitió: write_execution_failure');
      const observed = (await pool.query<{ details: string }>("select coalesce(error_details::text, '') || coalesce(payload::text, '') as details from observations where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows;
      expect(observed).toHaveLength(1);
      expect(observed[0]!.details).toMatch(/autonomy_disabled/);
      expect(owned.quotes.quotes).toHaveLength(0);
    } finally {
      await set(true);
      await pool.end();
      await runtime.close();
    }
  });

  it('held, and the customer writes while engaged: the task is handed to humans, the run ends, and the reconciliation — a read, while still engaged — settles the command as not applied; it is never sent', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    const router = new Router();
    const owned = owners();
    const runtime = await canaryRuntime(canary, router, owned, 'sales-canary:test:do-held-customer-writes', { scheduler: true });
    const pool = openPool(canaryDb.url);
    const set = killSwitch(pool);
    try {
      const taskId = await converse(canary, runtime, router, 'do-held-customer-writes', [...TURN_1, ...CHOOSE_AND_PREVIEW, EXACT_OFFER, propose, outcome], OFFER_TURNS);
      owned.hooks.onCatalogRead = () => set(false);
      await sendSynthetic(canary, { conversation: 'do-held-customer-writes', text: 'Sí, emítela.' }, logger);
      await drain(runtime);
      expect(await quoteLedger(pool, taskId)).toMatchObject({ executions: ['executing'], attempts: ['1:execute:unknown:domain_unknown'], receipts: [], retries: ['pending'], decisions: ['authorized:eligible'], sends: 0 });

      await sendSynthetic(canary, { conversation: 'do-held-customer-writes', text: '¿Pudiste emitirla?' }, logger);
      await drain(runtime);
      const ledger = await quoteLedger(pool, taskId);
      expect(ledger).toMatchObject({ executions: ['failed'], attempts: ['1:execute:unknown:domain_unknown', '2:reconcile:not_applied:-'], receipts: [{ status: 'failed', error_code: 'write_not_applied', execution_key: ledger.key }], decisions: ['authorized:eligible'], sends: 0 });
      expect((await pool.query("select kind, status, payload->>'reason' as reason from human_requests where task_id = $1", [taskId])).rows).toEqual([{ kind: 'handoff', status: 'requested', reason: 'autonomy_disabled' }]);
      expect((await pool.query('select status from agent_tasks where task_id = $1', [taskId])).rows).toEqual([{ status: 'blocked' }]);
      expect(owned.quotes.createCalls).toBe(0);

      // Released: the task is human-owned, so nothing autonomous resumes and nothing is sent.
      await set(true);
      await drain(runtime);
      expect(owned.quotes.createCalls).toBe(0);
      expect(owned.quotes.quotes).toHaveLength(0);
    } finally {
      await set(true);
      await pool.end();
      await runtime.close();
    }
  });

  it('held on its key while engaged (no receipt, no reply, not resumed when the retry falls due); released, the platform reconciles (not applied) and replays the SAME key once; the reply carries the quote', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    const router = new Router();
    const owned = owners();
    const runtime = await canaryRuntime(canary, router, owned, 'sales-canary:test:do-held-resume', { scheduler: true });
    const pool = openPool(canaryDb.url);
    const set = killSwitch(pool);
    try {
      const taskId = await converse(canary, runtime, router, 'do-held-resume', [...TURN_1, ...CHOOSE_AND_PREVIEW, EXACT_OFFER, propose, outcome], OFFER_TURNS);
      const repliesBefore = captured(runtime).length;
      owned.hooks.onCatalogRead = () => set(false);
      await sendSynthetic(canary, { conversation: 'do-held-resume', text: 'Sí, emítela.' }, logger);
      await drain(runtime);
      const held = await quoteLedger(pool, taskId);
      expect(held).toMatchObject({ executions: ['executing'], attempts: ['1:execute:unknown:domain_unknown'], receipts: [], retries: ['pending'], decisions: ['authorized:eligible'], sends: 0 });
      expect((await pool.query('select initial_backoff_ms from action_executions where execution_key = $1', [held.key])).rows).toEqual([{ initial_backoff_ms: 20_000 }]);
      // The run keeps its place with no lease (no recovery is consumed), and nothing was said to the customer.
      expect((await pool.query("select t.status, t.lease_owner, r.status as run from agent_tasks t join agent_runs r on r.task_id = t.task_id and r.status = 'running' where t.task_id = $1", [taskId])).rows).toEqual([{ status: 'running', lease_owner: null, run: 'running' }]);
      expect(captured(runtime)).toHaveLength(repliesBefore);
      expect(owned.quotes.createCalls).toBe(0);

      // Temporal time moves only when the test moves it (r4_now, kept ahead of the real clock).
      await freezeTemporalClock(pool, new Date((await latestRetryDue(pool, taskId)).getTime() + 1_000));
      await drain(runtime);
      // The retry fell due and was fired, but worker admission refuses every claim while engaged.
      expect(await quoteLedger(pool, taskId)).toMatchObject({ attempts: ['1:execute:unknown:domain_unknown'], retries: ['fired'], receipts: [] });
      expect(owned.quotes.createCalls).toBe(0);

      await set(true);
      await drain(runtime);
      // Resumed: the reconciliation (a lookup by the same key) establishes "not applied"; the replay waits for its backoff.
      expect(await quoteLedger(pool, taskId)).toMatchObject({ attempts: ['1:execute:unknown:domain_unknown', '2:reconcile:not_applied:-'], retries: ['fired', 'pending'], receipts: [] });
      expect(owned.quotes.createCalls).toBe(0);

      await freezeTemporalClock(pool, new Date((await latestRetryDue(pool, taskId)).getTime() + 1_000));
      await drain(runtime);
      const issued = await quoteLedger(pool, taskId);
      expect(issued).toEqual({
        key: held.key,
        executions: ['succeeded'],
        attempts: ['1:execute:unknown:domain_unknown', '2:reconcile:not_applied:-', '3:replay:applied:-'],
        receipts: [{ status: 'succeeded', error_code: null, execution_key: held.key }],
        retries: ['fired', 'fired'],
        decisions: ['authorized:eligible'],
        sends: 1,
      });
      // One owner call, under the command's own key, with the frozen body: one quote.
      expect(owned.quotes.createCalls).toBe(1);
      expect(owned.quotes.quotes).toHaveLength(1);
      expect((await owned.quotes.lookupIdempotency(held.key!))?.quoteId).toBe(owned.quotes.quotes[0]!.quoteId);
      expect(captured(runtime).at(-1)!.text).toBe('Cotización PC-000001 emitida.');
    } finally {
      await restoreTemporalClock(pool);
      await set(true);
      await pool.end();
      await runtime.close();
    }
  });

  it('held longer than the run budget: on release the SAME key issues once, but the resumed run ends budget_exhausted before replying — the customer must be told by an operator', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    const router = new Router();
    const owned = owners();
    const maxRunDurationMs = 4_000;
    const runtime = await canaryRuntime(canary, router, owned, 'sales-canary:test:do-held-budget', { scheduler: true, maxRunDurationMs });
    const pool = openPool(canaryDb.url);
    const set = killSwitch(pool);
    try {
      const taskId = await converse(canary, runtime, router, 'do-held-budget', [...TURN_1, ...CHOOSE_AND_PREVIEW, EXACT_OFFER, propose, outcome], OFFER_TURNS);
      const repliesBefore = captured(runtime).length;
      owned.hooks.onCatalogRead = () => set(false);
      await sendSynthetic(canary, { conversation: 'do-held-budget', text: 'Sí, emítela.' }, logger);
      await drain(runtime);
      const held = await quoteLedger(pool, taskId);
      expect(held).toMatchObject({ executions: ['executing'], attempts: ['1:execute:unknown:domain_unknown'] });
      // The run's duration budget counts from its start, held time included.
      await new Promise((resolve) => setTimeout(resolve, maxRunDurationMs + 500));
      await set(true);
      await freezeTemporalClock(pool, new Date((await latestRetryDue(pool, taskId)).getTime() + 1_000));
      await drain(runtime);
      await freezeTemporalClock(pool, new Date((await latestRetryDue(pool, taskId)).getTime() + 1_000));
      await drain(runtime);
      expect(await quoteLedger(pool, taskId)).toMatchObject({ key: held.key, executions: ['succeeded'], receipts: [{ status: 'succeeded', execution_key: held.key }], sends: 1 });
      expect(owned.quotes.quotes).toHaveLength(1);
      expect((await pool.query("select r.termination_reason, r.termination_code, t.status from agent_runs r join agent_tasks t using (task_id) where r.task_id = $1 order by r.sequence desc limit 1", [taskId])).rows).toEqual([{ termination_reason: 'budget_exhausted', termination_code: 'max_run_duration_ms', status: 'failed' }]);
      expect(captured(runtime)).toHaveLength(repliesBefore);
    } finally {
      await restoreTemporalClock(pool);
      await set(true);
      await pool.end();
      await runtime.close();
    }
  });
});
