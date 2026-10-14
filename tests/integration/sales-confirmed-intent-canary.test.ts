import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping } from '@r4-adapters/domains';
import { FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS, ContextView, read, respond, type ScriptedStep } from '@r4-sales/agent';
import { initCanary, loadCanaryEnvironment, sendSynthetic, startCanaryRuntime, syntheticConversationKey, type CanaryEnvironment, type CanaryRuntime } from '@r4-sales/agent/canary';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * R4-J3E-B: sales-production@6 end to end through the isolated canary — real
 * ChannelIngress (synthetic channel), the production worker composition,
 * Policy Engine, ActionExecutor, the real delivery owner capturing locally,
 * and quote.create@4 reading the customer's confirmation through the REAL
 * ProductionStore.thread of the canary database. Scripted stand-in model;
 * fixture owners bound as HTTP-kind ports. The model never states the
 * customer's intent: it only proposes quote.create { previewId }.
 */
const logger = createSilentLogger();
const IDENTITY_KEY = 'r4-test-canary-identity-key-confirmed-intent-01234';
let canaryDb: TestDatabase;
let captureDir: string;

const http = <T extends object>(port: T): T & { bindingKind: string } =>
  new Proxy(port, { get: (target, key) => (key === 'bindingKind' ? 'http' : typeof Reflect.get(target, key) === 'function' ? (Reflect.get(target, key) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key)) }) as T & { bindingKind: string };

const LIMITS = {
  R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '500000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '3', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '5', R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: '5',
  R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '1', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '20', R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: '900',
};
const CONVERSATIONS = ['ci-natural', 'ci-ambiguous', 'ci-negation', 'ci-replay'];

function canaryEnv(allowlist: readonly string[] = CONVERSATIONS, extra: Record<string, string> = {}): Record<string, string> {
  const base = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@6', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY,
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: canaryDb.url, R4_LOG_LEVEL: 'silent', ...LIMITS,
  };
  const keys = allowlist.map((c) => syntheticConversationKey(loadCanaryEnvironment(base), c));
  return { ...base, R4_PROD_ROLLOUT_ALLOWLIST: keys.join(','), ...extra };
}

class Router {
  readonly #routes = new Map<string, { steps: readonly ScriptedStep[]; next: number }>();
  readonly script: FakeModelScript = (request) => {
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

function owners() {
  return { catalog: new FixtureCatalog(), shipping: new FixtureShipping(), quotes: new FixtureQuoteV2Service() };
}

async function canaryRuntime(canary: CanaryEnvironment, router: Router, owned: ReturnType<typeof owners>, workerId: string): Promise<CanaryRuntime> {
  return startCanaryRuntime(canary, {
    modelProvider: new FakeModelProvider(router.script), catalog: http(owned.catalog), shipping: http(owned.shipping), quotes: http(owned.quotes),
    worker: workerConfig(workerId), scheduler: null, captureFile: join(captureDir, `${workerId.replace(/[^a-z0-9]/gi, '_')}.jsonl`), logger, isolationCheckMs: 50,
  });
}

/** Runs the worker until idle, then delivers (captures) every pending outbound — the offer is `accepted` before the customer answers. */
async function drain(runtime: CanaryRuntime, maxCycles = 30): Promise<void> {
  for (let i = 0; i < maxCycles; i += 1) {
    const cycle = await runtime.worker.worker.runOnce();
    if (cycle.kind === 'idle') break;
  }
  await runtime.delivery.tick();
}

const workspace = (operations: (v: ContextView) => unknown[]): ScriptedStep => (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate, arguments: { operations: operations(v) } });
const ORDER = [{ productId: 'BAR-OLY20', quantity: 1 }, { productId: 'BAR-EZ', quantity: 2 }];
const latest = (v: ContextView, capabilityId: string) => v.observations(capabilityId).filter((o) => o.outcome === 'succeeded').at(-1)!;
const courier = (v: ContextView) => (latest(v, CAPABILITY_IDS.shippingQuote).payload as { offers: { carrierName: string; serviceType: string; price: { ownerNet: { amount: number } } }[] }).offers.find((o) => o.carrierName === 'Fixture Courier')!;
const preview = (v: ContextView) => latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).payload as { previewId: string; presentation: { reference: string; totalText: string } };
const lastQuote = (v: ContextView) => v.observations(CAPABILITY_IDS.quoteCreate).at(-1)!;
const propose: ScriptedStep = (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.quoteCreate, arguments: { previewId: preview(v).previewId }, evidenceRefs: [latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).observationId] });
const outcome = respond((v) => {
  const o = lastQuote(v);
  return o.outcome === 'succeeded' ? `Cotización ${(o.payload as { result: { quoteNumber: string } }).result.quoteNumber} emitida.` : `No se emitió: ${o.error?.code ?? (o.payload as { code?: string } | null)?.code ?? o.outcome}`;
});

const TURN_1: ScriptedStep[] = [
  workspace(() => [...ORDER.map((i) => ({ op: 'add_item', ...i })), { op: 'set_delivery_destination', commune: 'Ñuñoa' }]),
  read(CAPABILITY_IDS.shippingQuote, { destination: { commune: 'Ñuñoa' }, basis: 'order', items: ORDER }),
  respond((v) => `Despacho a Ñuñoa: ${courier(v).carrierName} ${courier(v).serviceType}. ¿Cuál prefieres?`),
];
const TURN_2: ScriptedStep[] = [
  workspace((v) => [{ op: 'select_shipping_offer', carrierName: courier(v).carrierName, serviceType: courier(v).serviceType, ownerNetClp: courier(v).price.ownerNet.amount }]),
  read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}),
  respond((v) => `Barra olímpica ×1 y Barra Z ×2 con despacho. ${preview(v).presentation.totalText} · Ref. ${preview(v).presentation.reference}. ¿Emito la cotización?`),
];
const REOFFER = respond((v) => `Necesito tu confirmación explícita. ${preview(v).presentation.totalText} · Ref. ${preview(v).presentation.reference}. Si estás de acuerdo responde CONFIRMO.`);

beforeAll(async () => {
  captureDir = mkdtempSync(join(tmpdir(), 'r4-confirmed-intent-canary-'));
  canaryDb = await createTestDatabase('r4_it_confirmed_intent_canary');
  const init = await initCanary(loadCanaryEnvironment(canaryEnv()), logger);
  expect(init.migrations.sales).toEqual(['0006_sales_reference_application', '0007_sales_quote_v2_issuance', '0008_sales_autonomous_quote_decisions', '0009_sales_quote_intent_evidence']);
  expect(init.definitions.registered).toEqual(expect.arrayContaining(['sales@5', 'sales@6']));
});

afterAll(async () => {
  await canaryDb?.drop();
});

/** One conversation: sends each customer text in turn and drains the canary after each. */
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

describe('sales-production@6 in the isolated canary: issuance on the customer\'s own confirmation', () => {
  it('refuses to load @6 without the total-units limit or the confirmation window', () => {
    for (const name of ['R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS', 'R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS']) {
      const env = canaryEnv();
      delete (env as Record<string, string | undefined>)[name];
      expect(() => loadCanaryEnvironment(env), name).toThrow(new RegExp(`${name} is required`));
    }
  });

  it('natural confirmation "Sí, emítela." → Policy allow/autonomous → quote.create@4 → one quote; the evidence points at the real input and offer', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    const router = new Router();
    const owned = owners();
    const runtime = await canaryRuntime(canary, router, owned, 'sales-canary:test:ci-natural');
    const pool = openPool(canaryDb.url);
    try {
      const taskId = await converse(canary, runtime, router, 'ci-natural', [...TURN_1, ...TURN_2, propose, outcome], ['Quiero una barra olímpica y dos barras Z, despacho a Ñuñoa', 'Fixture Courier normal', 'Sí, emítela.']);
      expect(owned.quotes.quotes).toHaveLength(1);
      expect(owned.quotes.createCalls).toBe(1);
      expect((await pool.query("select capability_version, outcome, reason_code, policy_id from policy_decisions where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows).toEqual([{ capability_version: 4, outcome: 'allow', reason_code: 'autonomous', policy_id: 'sales-production-autonomous-policy' }]);
      expect((await pool.query("select status, capability_version from action_receipts where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows).toEqual([{ status: 'succeeded', capability_version: 4 }]);
      expect((await pool.query('select count(*)::int as n from human_requests where task_id = $1', [taskId])).rows[0]).toEqual({ n: 0 });
      // The confirming input is the customer's LAST real input; the offer is the agent's real, delivered response.
      const lastInput = (await pool.query<{ input_id: string }>('select input_id from task_inputs where task_id = $1 order by received_at desc limit 1', [taskId])).rows[0]!.input_id;
      const evidence = (await pool.query('select confirmation_input_id, offer_delivery_status, offer_outbound_id, grammar_rule from sales.quote_intent_evidence where task_id = $1', [taskId])).rows;
      expect(evidence).toEqual([{ confirmation_input_id: lastInput, offer_delivery_status: 'accepted', offer_outbound_id: expect.any(String), grammar_rule: 'affirmation=si;courtesy=none' }]);
      expect((await pool.query('select status, channel from outbound_messages where outbound_id = $1', [evidence[0].offer_outbound_id])).rows).toEqual([{ status: 'accepted', channel: 'r4-synthetic' }]);
      const captured = readFileSync(runtime.capture.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { text: string });
      expect(captured.at(-1)!.text).toBe('Cotización PC-000001 emitida.');
      expect((await pool.query("select count(*)::int as n from outbound_messages where channel <> 'r4-synthetic'")).rows[0]).toEqual({ n: 0 });
    } finally {
      await pool.end();
      await runtime.close();
    }
  });

  it('ambiguous "Sí" is refused by the platform; after the re-presented offer, "CONFIRMO" issues exactly once', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    const router = new Router();
    const owned = owners();
    const runtime = await canaryRuntime(canary, router, owned, 'sales-canary:test:ci-ambiguous');
    const pool = openPool(canaryDb.url);
    try {
      const taskId = await converse(canary, runtime, router, 'ci-ambiguous', [...TURN_1, ...TURN_2, propose, REOFFER, propose, outcome], ['Quiero una barra olímpica y dos barras Z, despacho a Ñuñoa', 'Fixture Courier normal', 'Sí', 'CONFIRMO']);
      expect(owned.quotes.quotes).toHaveLength(1);
      expect((await pool.query<{ outcome: string; reason_code: string }>('select outcome, reason_code from sales.quote_autonomous_decisions where task_id = $1 order by decided_at', [taskId])).rows.map((r) => `${r.outcome}:${r.reason_code}`)).toEqual(['rejected:customer_confirmation_not_explicit', 'authorized:eligible']);
      expect((await pool.query<{ status: string }>("select status from action_receipts where task_id = $1 and capability_id = 'quote.create' order by recorded_at", [taskId])).rows.map((r) => r.status)).toEqual(['rejected', 'succeeded']);
      expect((await pool.query('select grammar_rule from sales.quote_intent_evidence where task_id = $1', [taskId])).rows).toEqual([{ grammar_rule: 'affirmation=none;courtesy=none' }]);
    } finally {
      await pool.end();
      await runtime.close();
    }
  });

  it('a negation the model tries to push through anyway: the platform refuses, nothing is issued', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    const router = new Router();
    const owned = owners();
    const runtime = await canaryRuntime(canary, router, owned, 'sales-canary:test:ci-negation');
    const pool = openPool(canaryDb.url);
    try {
      const taskId = await converse(canary, runtime, router, 'ci-negation', [...TURN_1, ...TURN_2, propose, outcome], ['Quiero una barra olímpica y dos barras Z, despacho a Ñuñoa', 'Fixture Courier normal', 'No confirmo, todavía lo estoy pensando']);
      expect(owned.quotes.createCalls).toBe(0);
      expect((await pool.query('select outcome, reason_code from sales.quote_autonomous_decisions where task_id = $1', [taskId])).rows).toEqual([{ outcome: 'rejected', reason_code: 'customer_confirmation_not_explicit' }]);
      const captured = readFileSync(runtime.capture.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { text: string });
      expect(captured.at(-1)!.text).toBe('No se emitió: action_rejected');
      // What the agent observed carries Sales' reason, from the receipt (the agent can explain it to the customer).
      const observed = (await pool.query<{ error_code: string; details: string }>("select error_code, coalesce(error_details::text, '') || coalesce(payload::text, '') as details from observations where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows;
      expect(observed).toHaveLength(1);
      expect(observed[0]!.details).toMatch(/customer_confirmation_not_explicit/);
    } finally {
      await pool.end();
      await runtime.close();
    }
  });

  it('an inbound replay (same provider event) adds no input and authorizes nothing new', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    const router = new Router();
    const owned = owners();
    const runtime = await canaryRuntime(canary, router, owned, 'sales-canary:test:ci-replay');
    const pool = openPool(canaryDb.url);
    try {
      const taskId = await converse(canary, runtime, router, 'ci-replay', [...TURN_1, ...TURN_2, propose, outcome], ['Quiero una barra olímpica y dos barras Z, despacho a Ñuñoa', 'Fixture Courier normal']);
      const eventId = 'synthetic:ci-replay-confirmation';
      expect(await sendSynthetic(canary, { conversation: 'ci-replay', text: 'Sí, emítela.', eventId }, logger)).toMatchObject({ kind: 'ingested' });
      await drain(runtime);
      expect(await sendSynthetic(canary, { conversation: 'ci-replay', text: 'Sí, emítela.', eventId }, logger)).toMatchObject({ kind: 'duplicate' });
      await drain(runtime);
      expect(owned.quotes.quotes).toHaveLength(1);
      expect((await pool.query('select count(*)::int as n from task_inputs where task_id = $1', [taskId])).rows[0]).toEqual({ n: 3 });
      expect((await pool.query('select count(*)::int as n from sales.quote_intent_evidence where task_id = $1', [taskId])).rows[0]).toEqual({ n: 1 });
    } finally {
      await pool.end();
      await runtime.close();
    }
  });
});
