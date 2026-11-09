import { mkdtempSync } from 'node:fs';
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
 * F1 commercial policy (owner decision «F1 simplified commercial canary», 2026-11-09): the F1 candidate @17 quotes what
 * Catalog V2 backs, with NO static P-1 file (Catalog V2 is the commercial authority, Quote V2 the issuance authority):
 * preview → the exact Sales-rendered offer → explicit confirmation → exactly one issuance. Through the isolated canary
 * (real ingress, worker, Policy Engine, ActionExecutor, single-flight port); scripted model; fixture owners.
 */
const logger = createSilentLogger();
const IDENTITY_KEY = 'r4-test-canary-identity-key-f1-policy-01';
const CONVERSATIONS = ['f1-policy'];
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
  const base = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@17', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY,
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: db.url, R4_LOG_LEVEL: 'silent',
    ...F1,
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
  databaseUrl: db.url, logLevel: 'silent' as const, dbPoolMax: 3, workerId: `f1p-${maxWriteActions}`, leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
  execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions },
  context: { budget: { mode: 'unbounded' as const } },
});
const runtimeOf = (canary: CanaryEnvironment, router: Router, maxWriteActions: number, quotes: FixtureQuoteV2Service) =>
  startCanaryRuntime(canary, {
    modelProvider: new FakeModelProvider(router.script), catalog: http(new FixtureCatalog()), catalogDiscover: discover, shipping: http(new FixtureShipping()), quotes: http(quotes),
    worker: worker(maxWriteActions),
    scheduler: { databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 2, owner: `f1p-${maxWriteActions}:scheduler`, leaseMs: 30_000, pollMs: 25, reconciliationPolicy: RECONCILIATION_POLICY },
    captureFile: join(dir, `f1p-${maxWriteActions}.jsonl`), logger, isolationCheckMs: 50,
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
const TURN_1 = [ws([{ op: 'add_item', productId: 'BAR-EZ', quantity: 2 }]), ws([{ op: 'exclude_shipping' }]), read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}), offer];
const TURN_2 = [propose, respond('ok')];

beforeAll(async () => {
  db = await createTestDatabase('r4_it_f1p_canary');
  dir = mkdtempSync(join(tmpdir(), 'r4-f1p-'));
});
afterAll(async () => {
  await db?.drop();
});

describe('@17 quotes what Catalog V2 backs, without a static P-1 file', { timeout: 120_000 }, () => {
  it('preview → exact offer → explicit confirmation → exactly one issuance of the confirmed lines', async () => {
    const env = canaryEnv();
    expect(Object.keys(env).filter((k) => k.startsWith('R4_QUOTE_PARITY'))).toEqual([]);
    const canary = loadCanaryEnvironment(env);
    await initCanary(canary, logger);
    const router = new Router();
    const quotes = new FixtureQuoteV2Service();
    let ownerCalls = 0;
    const issue = quotes.createAndIssue.bind(quotes);
    quotes.createAndIssue = (...a: Parameters<typeof issue>) => ((ownerCalls += 1), issue(...a));
    const runtime = await runtimeOf(canary, router, 6, quotes);
    try {
      const taskId = await converse(canary, runtime, router, 'f1-policy', [...TURN_1, ...TURN_2], ['Quiero 2 barras Z, sin despacho', 'Sí, emítela.']);
      expect(taskId).toBeTruthy();
      const pool = openPool(db.url);
      try {
        const decisions = (await pool.query('select outcome, reason_code, snapshot from sales.quote_autonomous_decisions')).rows as { outcome: string; reason_code: string; snapshot: { lines: { itemKey: string; quantity: number }[]; shipping: { kind: string } } }[];
        expect(decisions.map((d) => [d.outcome, d.reason_code])).toEqual([['authorized', 'eligible']]);
        expect(decisions[0]!.snapshot.lines.map((l) => [l.itemKey, l.quantity])).toEqual([['BAR-EZ', 2]]);
        expect(decisions[0]!.snapshot.shipping.kind).toBe('excluded');
      } finally {
        await pool.end();
      }
      expect(ownerCalls).toBe(1);
    } finally {
      await runtime.close();
    }
  });
});
