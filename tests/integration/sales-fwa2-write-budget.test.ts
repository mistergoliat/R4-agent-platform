import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS, ContextView, read, respond, type ScriptedStep } from '@r4-sales/agent';
import { initCanary, loadCanaryEnvironment, sendSynthetic, startCanaryRuntime, syntheticConversationKey, type CanaryEnvironment, type CanaryRuntime } from '@r4-sales/agent/canary';
import { SALES_F1_CANARY_LIMITS } from '@r4-sales/agent/production';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { RECONCILIATION_POLICY } from '../support/temporal.js';

/**
 * F-WA-2 (owner decision, 2026-11-09): the F1 quote canary runs with a budget of 6 writes per task. A conversation
 * that changes its product (4 workspace updates, as the real DeepSeek run E8 did) exhausted a budget of 4 before
 * quote.create; with 6 it issues exactly one quote. The budget is the existing per-task ceiling (no kernel change); every
 * other control stays independent of it: one quote per conversation, the F1 limits, the confirmation of the exact offer,
 * the quote.create authorization. sales-production@16 end to end through the isolated canary (real ingress, worker,
 * Policy Engine, ActionExecutor, delivery owner); scripted model; fixture owners as HTTP-kind ports.
 */
const logger = createSilentLogger();
const IDENTITY_KEY = 'r4-test-canary-identity-key-fwa2-write-budget-01';
const CONVERSATIONS = ['fwa2-budget-4', 'fwa2-budget-6'];
let db: TestDatabase;
let dir: string;

const http = <T extends object>(port: T): T & { bindingKind: string } =>
  new Proxy(port, { get: (target, key) => (key === 'bindingKind' ? 'http' : typeof Reflect.get(target, key) === 'function' ? (Reflect.get(target, key) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key)) }) as T & { bindingKind: string };
const F1 = {
  R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: String(SALES_F1_CANARY_LIMITS.maxGrossClp), R4_AUTONOMOUS_QUOTE_MAX_LINES: String(SALES_F1_CANARY_LIMITS.maxLines),
  R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: String(SALES_F1_CANARY_LIMITS.maxUnitsPerLine), R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: String(SALES_F1_CANARY_LIMITS.maxTotalUnits),
  R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: String(SALES_F1_CANARY_LIMITS.maxQuotesPerConversation), R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: String(SALES_F1_CANARY_LIMITS.maxQuotesPerHour),
  R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: String(SALES_F1_CANARY_LIMITS.confirmationWindowSeconds),
};

function canaryEnv(): Record<string, string> {
  const parity = join(dir, 'parity.json');
  const at = new Date().toISOString();
  writeFileSync(parity, JSON.stringify({ schemaVersion: 1, items: [
    { itemKey: 'BAR-EZ', productRef: '107', variantRef: null, sku: 'SC-EZ120', finalGross: 39_990, availableQuantity: 20, verifiedAt: at, source: 'fwa2-test' },
    { itemKey: 'BAR-OLY15', productRef: '106', variantRef: null, sku: 'SC-BO15-25', finalGross: 109_990, availableQuantity: 4, verifiedAt: at, source: 'fwa2-test' },
  ] }));
  const base = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@16', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY,
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: db.url, R4_LOG_LEVEL: 'silent',
    R4_QUOTE_PARITY_EVIDENCE_FILE: parity, R4_QUOTE_PARITY_MAX_AGE_SECONDS: '3600', ...F1,
  };
  const keys = CONVERSATIONS.map((c) => syntheticConversationKey(loadCanaryEnvironment(base), c));
  return { ...base, R4_PROD_ROLLOUT_ALLOWLIST: keys.join(',') };
}

class Router {
  readonly #routes = new Map<string, { steps: readonly ScriptedStep[]; next: number }>();
  readonly script: FakeModelScript = (request) => {
    const taskId = (request.context!.sections.task.find((i) => i.kind === 'task')!.content as { taskId: string }).taskId;
    const route = this.#routes.get(taskId);
    if (!route) return Promise.resolve({ type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'not part of this scenario' } });
    const step = route.steps[route.next++];
    if (!step) return Promise.resolve({ type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'script done' } });
    return Promise.resolve({ type: 'structured', data: step(new ContextView(request)) });
  };
  route(taskId: string, steps: readonly ScriptedStep[]): void {
    this.#routes.set(taskId, { steps, next: 0 });
  }
}

const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('not used here')) };
const worker = (maxWriteActions: number) => ({
  databaseUrl: db.url, logLevel: 'silent' as const, dbPoolMax: 3, workerId: `fwa2-${maxWriteActions}`, leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
  execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions },
  context: { budget: { mode: 'unbounded' as const } },
});
const runtimeOf = (canary: CanaryEnvironment, router: Router, maxWriteActions: number, quotes: FixtureQuoteV2Service) =>
  startCanaryRuntime(canary, {
    modelProvider: new FakeModelProvider(router.script), catalog: http(new FixtureCatalog()), catalogDiscover: discover, shipping: http(new FixtureShipping()), quotes: http(quotes),
    worker: worker(maxWriteActions),
    scheduler: { databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 2, owner: `fwa2-${maxWriteActions}:scheduler`, leaseMs: 30_000, pollMs: 25, reconciliationPolicy: RECONCILIATION_POLICY },
    captureFile: join(dir, `fwa2-${maxWriteActions}.jsonl`), logger, isolationCheckMs: 50,
  });
async function drain(runtime: CanaryRuntime): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const fired = (await runtime.scheduler?.scheduler.runOnce())?.kind === 'fired';
    if ((await runtime.worker.worker.runOnce()).kind === 'idle' && !fired) break;
  }
  await runtime.delivery.tick();
}

const ws = (operations: unknown[]): ScriptedStep => () => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate, arguments: { operations } });
const latest = (v: ContextView, id: string) => v.observations(id).filter((o) => o.outcome === 'succeeded').at(-1)!;
const preview = (v: ContextView) => latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).payload as { previewId: string; presentation: { offerMessage: string } };
const propose: ScriptedStep = (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.quoteCreate, arguments: { previewId: preview(v).previewId }, evidenceRefs: [latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).observationId] });
const offer = respond((v) => preview(v).presentation.offerMessage);
// The product change of the real E8 run: two workspace writes per turn, then the deterministic offer.
const TURN_1 = [ws([{ op: 'add_item', productId: 'BAR-EZ', quantity: 2 }]), ws([{ op: 'exclude_shipping' }]), read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}), offer];
const TURN_2 = [ws([{ op: 'replace_item', productId: 'BAR-EZ', withProductId: 'BAR-OLY15', quantity: 1 }]), ws([{ op: 'exclude_shipping' }]), read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}), offer];
const TURN_3 = [propose, respond('ok')];
const TEXTS = ['Quiero 2 barras Z, sin despacho', 'Mejor cámbialas por 1 barra olímpica técnica de 15 kg', 'Sí, emítela.'];

async function converse(canary: CanaryEnvironment, runtime: CanaryRuntime, router: Router, conversation: string, steps: ScriptedStep[], texts: string[]): Promise<string> {
  const first = (await sendSynthetic(canary, { conversation, text: texts[0]! }, logger)) as { taskId: string };
  router.route(first.taskId, steps);
  await drain(runtime);
  for (const text of texts.slice(1)) {
    await sendSynthetic(canary, { conversation, text }, logger);
    await drain(runtime);
  }
  return first.taskId;
}
const refusals = async (taskId: string) => {
  const pool = openPool(db.url);
  try {
    return (await pool.query<{ cap: string; outcome: string; code: string | null }>("select decision->>'capabilityId' as cap, outcome, error_code as code from agent_run_steps where task_id = $1 and decision_type = 'propose_action' order by created_at", [taskId])).rows;
  } finally {
    await pool.end();
  }
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'r4-fwa2-'));
  db = await createTestDatabase('r4_it_fwa2_canary');
  const init = await initCanary(loadCanaryEnvironment(canaryEnv()), logger);
  expect(init.autonomy).toBeDefined();
});
afterAll(async () => {
  await db?.drop();
});

describe('F-WA-2: the F1 quote canary (@16) with a budget of 6 writes per task', () => {
  it('a budget of 4 is exhausted by the product change (4 workspace writes): quote.create is refused, nothing is issued', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    const router = new Router();
    const quotes = new FixtureQuoteV2Service();
    const runtime = await runtimeOf(canary, router, 4, quotes);
    try {
      const taskId = await converse(canary, runtime, router, 'fwa2-budget-4', [...TURN_1, ...TURN_2, ...TURN_3], TEXTS);
      const steps = await refusals(taskId);
      expect(steps.filter((s) => s.cap === CAPABILITY_IDS.workspaceUpdate && s.outcome !== 'refused')).toHaveLength(4);
      expect(steps.find((s) => s.cap === CAPABILITY_IDS.quoteCreate)).toMatchObject({ outcome: 'refused', code: 'budget_exhausted' });
      expect(quotes.quotes).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('with 6: the same conversation issues exactly one quote of the product changed into; a 6th write that tries to issue again is refused by the one-quote-per-conversation control, and a 7th by the budget', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    const router = new Router();
    const quotes = new FixtureQuoteV2Service();
    const runtime = await runtimeOf(canary, router, 6, quotes);
    const pool = openPool(db.url);
    try {
      const taskId = await converse(canary, runtime, router, 'fwa2-budget-6', [...TURN_1, ...TURN_2, ...TURN_3, ...TURN_2.slice(2), propose, respond('again'), ws([{ op: 'exclude_shipping' }]), respond('more')], [...TEXTS, 'Sí, emítela.', 'Sí, emítela.', 'Una cosa más'] );
      expect(quotes.quotes).toHaveLength(1);
      const issued = (await pool.query<{ snapshot: { lines: { itemKey: string; quantity: number }[] } }>('select snapshot from sales.quote_autonomous_decisions where task_id = $1 and outcome = $2', [taskId, 'authorized'])).rows;
      expect(issued).toHaveLength(1);
      expect(issued[0]!.snapshot.lines.map((l) => [l.itemKey, Number(l.quantity)])).toEqual([['BAR-OLY15', 1]]);
      // Policy Engine: quote.create is still decided (allow/autonomous) on its own; the budget is not an authorization.
      expect((await pool.query("select outcome, reason_code from policy_decisions where task_id = $1 and capability_id = 'quote.create' order by evaluated_at", [taskId])).rows[0]).toEqual({ outcome: 'allow', reason_code: 'autonomous' });
      const decisions = (await pool.query<{ outcome: string; reason_code: string }>('select outcome, reason_code from sales.quote_autonomous_decisions where task_id = $1 order by decided_at', [taskId])).rows;
      expect(decisions[0]).toEqual({ outcome: 'authorized', reason_code: 'eligible' });
      // The 6th write (a second issuance) fits the budget but is refused by the independent per-conversation control.
      expect(decisions.slice(1).every((d) => d.outcome !== 'authorized')).toBe(true);
      const steps = await refusals(taskId);
      expect(steps.filter((s) => s.outcome !== 'refused')).toHaveLength(6);
      // The 7th write is refused by the budget itself.
      expect(steps.at(-1)).toMatchObject({ cap: CAPABILITY_IDS.workspaceUpdate, outcome: 'refused', code: 'budget_exhausted' });
    } finally {
      await pool.end();
      await runtime.close();
    }
  });

  it('6 is the ceiling (7 is refused before the canary starts), and the F1 commercial limits are the approved ones, unchanged by the budget', async () => {
    const canary = loadCanaryEnvironment(canaryEnv());
    await expect(runtimeOf(canary, new Router(), 7, new FixtureQuoteV2Service())).rejects.toThrow(/sales-production@16 runs with maxWriteActions between 1 and 6/);
    expect(canary.autonomousQuoteLimits).toEqual(SALES_F1_CANARY_LIMITS);
  });
});
