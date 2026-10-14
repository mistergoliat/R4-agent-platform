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
 * R4-J3E: the AUTONOMOUS governed path of sales-production@5, end to end
 * through the isolated canary (real ingress, the production worker
 * composition, Policy Engine, ActionExecutor, persistence, delivery owner
 * capturing locally), with a scripted stand-in model and fixture owners bound
 * as HTTP-kind ports. Nothing here calls a capability directly: every effect
 * is a model proposal decided by the platform. No human approval exists.
 */
const logger = createSilentLogger();
const IDENTITY_KEY = 'r4-test-canary-identity-key-autonomous-0123456789';
let canaryDb: TestDatabase;
let captureDir: string;

const http = <T extends object>(port: T): T & { bindingKind: string } =>
  new Proxy(port, { get: (target, key) => (key === 'bindingKind' ? 'http' : typeof Reflect.get(target, key) === 'function' ? (Reflect.get(target, key) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key)) }) as T & { bindingKind: string };

const LIMITS = { R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: '500000', R4_AUTONOMOUS_QUOTE_MAX_LINES: '5', R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: '10', R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: '2', R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: '20' };

function canaryEnv(allowlist: readonly string[], extra: Record<string, string> = {}): Record<string, string> {
  const base = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@5', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY,
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: canaryDb.url, R4_LOG_LEVEL: 'silent', ...LIMITS,
  };
  const keys = allowlist.map((c) => syntheticConversationKey(loadCanaryEnvironment(base), c));
  return { ...base, R4_PROD_ROLLOUT_ALLOWLIST: keys.join(','), ...extra };
}

/** Scripted stand-in model, routed per task (unrouted tasks wait for the customer). */
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
  const catalog = new FixtureCatalog();
  const shipping = new FixtureShipping();
  const quotes = new FixtureQuoteV2Service();
  return { catalog, shipping, quotes };
}

async function canaryRuntime(canary: CanaryEnvironment, router: Router, owned: ReturnType<typeof owners>, workerId: string): Promise<CanaryRuntime> {
  return startCanaryRuntime(canary, {
    modelProvider: new FakeModelProvider(router.script), catalog: http(owned.catalog), shipping: http(owned.shipping), quotes: http(owned.quotes),
    worker: workerConfig(workerId), scheduler: null, captureFile: join(captureDir, `${workerId.replace(/[^a-z0-9]/gi, '_')}.jsonl`), logger, isolationCheckMs: 50,
  });
}

async function drain(runtime: CanaryRuntime, maxCycles = 30): Promise<void> {
  for (let i = 0; i < maxCycles; i += 1) {
    const cycle = await runtime.worker.worker.runOnce();
    if (cycle.kind === 'idle') break;
  }
  await runtime.delivery.tick();
}

// The model's moves. Every commercial number comes from an owner observation; none is written by the "model".
const workspace = (operations: (v: ContextView) => unknown[]): ScriptedStep => (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate, arguments: { operations: operations(v) } });
const ORDER = [{ productId: 'BAR-OLY20', quantity: 1 }, { productId: 'BAR-EZ', quantity: 2 }];
const latest = (v: ContextView, capabilityId: string) => v.observations(capabilityId).filter((o) => o.outcome === 'succeeded').at(-1)!;
const courier = (v: ContextView) => (latest(v, CAPABILITY_IDS.shippingQuote).payload as { offers: { carrierName: string; serviceType: string; price: { ownerNet: { amount: number } } }[] }).offers.find((o) => o.carrierName === 'Fixture Courier')!;
const preview = (v: ContextView) => latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).payload as { previewId: string; status: string; issuable: boolean; snapshot: { totals: { gross: number } } };
const issued = (v: ContextView) => (latest(v, CAPABILITY_IDS.quoteCreate).payload as { result: { quoteNumber: string; totals: { gross: number } } }).result;

const TURN_1: ScriptedStep[] = [
  workspace(() => [...ORDER.map((i) => ({ op: 'add_item', ...i })), { op: 'set_delivery_destination', commune: 'Ñuñoa' }]),
  read(CAPABILITY_IDS.shippingQuote, { destination: { commune: 'Ñuñoa' }, basis: 'order', items: ORDER }),
  respond((v) => `Despacho a Ñuñoa: ${courier(v).carrierName} ${courier(v).serviceType}. ¿Cuál prefieres?`),
];
const TURN_2: ScriptedStep[] = [
  workspace((v) => [{ op: 'select_shipping_offer', carrierName: courier(v).carrierName, serviceType: courier(v).serviceType, ownerNetClp: courier(v).price.ownerNet.amount }]),
  read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}),
  respond((v) => `Total ${preview(v).snapshot.totals.gross} CLP con IVA y despacho. ¿Emito la cotización?`),
];
const TURN_3: ScriptedStep[] = [
  workspace((v) => [{ op: 'record_quote_request', previewId: preview(v).previewId, customerWords: 'Sí, emite la cotización' }]),
  (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.quoteCreate, arguments: { previewId: preview(v).previewId }, evidenceRefs: [latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).observationId] }),
  respond((v) => `Cotización ${issued(v).quoteNumber} emitida por ${issued(v).totals.gross} CLP.`),
];

beforeAll(async () => {
  captureDir = mkdtempSync(join(tmpdir(), 'r4-autonomous-canary-'));
  canaryDb = await createTestDatabase('r4_it_autonomous_canary');
  const init = await initCanary(loadCanaryEnvironment(canaryEnv([])), logger);
  expect(init.migrations.sales).toEqual(['0006_sales_reference_application', '0007_sales_quote_v2_issuance', '0008_sales_autonomous_quote_decisions', '0009_sales_quote_intent_evidence']);
  expect(init.definitions.registered).toContain('sales@5');
});

afterAll(async () => {
  await canaryDb?.drop();
});

describe('sales-production@5 in the isolated canary: autonomous governed quote issuance', () => {
  it('refuses to load @5 without configured limits', () => {
    const env = canaryEnv([]);
    delete (env as Record<string, string | undefined>).R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR;
    expect(() => loadCanaryEnvironment(env)).toThrow(/R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR is required/);
  });

  it('Agent → proposal → Policy Engine (allow, autonomous) → ActionExecutor → Quote V2 → PDF → persisted execution; no human, no duplicate, no channel', async () => {
    const canary = loadCanaryEnvironment(canaryEnv(['auto-1']));
    const router = new Router();
    const owned = owners();
    const runtime = await canaryRuntime(canary, router, owned, 'sales-canary:test:autonomous');
    const pool = openPool(canaryDb.url);
    try {
      const first = (await sendSynthetic(canary, { conversation: 'auto-1', text: 'Quiero una barra olímpica y dos barras Z, despacho a Ñuñoa' }, logger)) as { taskId: string };
      const taskId = router.route(first.taskId, [...TURN_1, ...TURN_2, ...TURN_3]);
      await drain(runtime);
      await sendSynthetic(canary, { conversation: 'auto-1', text: 'Fixture Courier normal' }, logger);
      await drain(runtime);
      expect(owned.quotes.createCalls).toBe(0);
      await sendSynthetic(canary, { conversation: 'auto-1', text: 'Sí, emite la cotización' }, logger);
      await drain(runtime);

      // The quote, once.
      expect(owned.quotes.quotes).toHaveLength(1);
      expect(owned.quotes.createCalls).toBe(1);
      expect(owned.quotes.quotes[0]).toMatchObject({ status: 'issued', quoteNumber: 'PC-000001', totals: { net: 189_119, tax: 35_933, gross: 225_052 } });
      // The Sales task runs definition v5 on the @5 binding.
      expect((await pool.query('select agent_version from agent_tasks where task_id = $1', [taskId])).rows).toEqual([{ agent_version: 5 }]);
      // Governed: the platform's own policy decision says autonomous, under the @5 policy; no human request exists.
      const decisions = (await pool.query("select capability_version, outcome, reason_code, policy_id from policy_decisions where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows;
      expect(decisions).toEqual([{ capability_version: 3, outcome: 'allow', reason_code: 'autonomous', policy_id: 'sales-production-autonomous-policy' }]);
      expect((await pool.query('select count(*)::int as n from human_requests where task_id = $1', [taskId])).rows[0]).toEqual({ n: 0 });
      // Persisted ActionExecution and receipt; the Sales decision ledger and the issued pointer with a verified PDF.
      expect((await pool.query("select status from action_executions where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows).toEqual([{ status: 'succeeded' }]);
      expect((await pool.query("select status, capability_version from action_receipts where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows).toEqual([{ status: 'succeeded', capability_version: 3 }]);
      expect((await pool.query('select outcome, reason_code from sales.quote_autonomous_decisions where task_id = $1', [taskId])).rows).toEqual([{ outcome: 'authorized', reason_code: 'eligible' }]);
      expect((await pool.query('select quote_number, document_verification from sales.quote_v2_issued where task_id = $1', [taskId])).rows).toEqual([{ quote_number: 'PC-000001', document_verification: 'verified' }]);
      // Replies only to the local capture (synthetic channel), the last one stating the owner's number and total.
      const captured = readFileSync(runtime.capture.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { recipientRef: string; text: string });
      expect(captured.map((c) => c.recipientRef)).toEqual(['synthetic:auto-1', 'synthetic:auto-1', 'synthetic:auto-1']);
      expect(captured.at(-1)!.text).toBe('Cotización PC-000001 emitida por 225052 CLP.');
      expect((await pool.query("select count(*)::int as n from outbound_messages where channel <> 'r4-synthetic'")).rows[0]).toEqual({ n: 0 });
    } finally {
      await pool.end();
      await runtime.close();
    }
  });

  it('a changed owner price after the preview: the platform allows the proposal, the commercial decision refuses it; nothing issued, the agent is told why', async () => {
    const canary = loadCanaryEnvironment(canaryEnv(['auto-2']));
    const router = new Router();
    const owned = owners();
    const runtime = await canaryRuntime(canary, router, owned, 'sales-canary:test:stale');
    const pool = openPool(canaryDb.url);
    try {
      const first = (await sendSynthetic(canary, { conversation: 'auto-2', text: 'Quiero una barra olímpica y dos barras Z, despacho a Ñuñoa' }, logger)) as { taskId: string };
      const refusal = (v: ContextView) => v.observations(CAPABILITY_IDS.quoteCreate).at(-1)!;
      const taskId = router.route(first.taskId, [...TURN_1, ...TURN_2, TURN_3[0]!, TURN_3[1]!, respond((v) => `No se emitió: ${(refusal(v).payload as { code?: string } | null)?.code ?? refusal(v).outcome}`)]);
      await drain(runtime);
      await sendSynthetic(canary, { conversation: 'auto-2', text: 'Fixture Courier normal' }, logger);
      await drain(runtime);
      // The Catalog owner raises a price before the customer confirms.
      const original = owned.catalog.getItemContext.bind(owned.catalog);
      owned.catalog.getItemContext = async (request, options) => {
        const item = await original(request, options);
        return item.status === 'found' && item.parentProduct.productKey === 'BAR-EZ' && item.pricing.status === 'available' ? { ...item, pricing: { ...item.pricing, finalGross: { ...item.pricing.finalGross, amount: 42_990 } } } : item;
      };
      await sendSynthetic(canary, { conversation: 'auto-2', text: 'Sí, emite la cotización' }, logger);
      await drain(runtime);
      expect(owned.quotes.createCalls).toBe(0);
      expect((await pool.query('select outcome, reason_code from sales.quote_autonomous_decisions where task_id = $1', [taskId])).rows).toEqual([{ outcome: 'rejected', reason_code: 'preview_stale' }]);
      expect((await pool.query("select status from action_receipts where task_id = $1 and capability_id = 'quote.create'", [taskId])).rows).toEqual([{ status: 'rejected' }]);
      const captured = readFileSync(runtime.capture.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { text: string });
      expect(captured.at(-1)!.text).toMatch(/^No se emitió: /);
      expect((await pool.query('select count(*)::int as n from human_requests where task_id = $1', [taskId])).rows[0]).toEqual({ n: 0 });
    } finally {
      await pool.end();
      await runtime.close();
    }
  });
});
