import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
 * (sales-production@19, owner decision «Activación @18, cierre @19 y decisiones R4-L», 2026-11-10) The customer's
 * acceptance of the offer is interpreted by the agent in natural language (quote.create@6, offer template v2); the
 * platform's guard still refuses a question, a negation, a hesitation or a change. @18 keeps the closed grammar.
 * Isolated canary (real ingress, worker, Policy Engine, ActionExecutor, delivery owner); scripted model; fixture owners.
 */
const logger = createSilentLogger();
let db: TestDatabase | null = null;
afterEach(async () => {
  await db?.drop();
  db = null;
});

const http = <T extends object>(port: T): T & { bindingKind: string } =>
  new Proxy(port, { get: (target, key) => (key === 'bindingKind' ? 'http' : typeof Reflect.get(target, key) === 'function' ? (Reflect.get(target, key) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key)) }) as T & { bindingKind: string };
const L = SALES_F1_CANARY_LIMITS;
function canaryEnv(url: string, profile: string): Record<string, string> {
  const base = {
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'r4-test-canary-identity-key-intent-01',
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: url, R4_LOG_LEVEL: 'silent',
    R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: String(L.maxGrossClp), R4_AUTONOMOUS_QUOTE_MAX_LINES: String(L.maxLines), R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: String(L.maxUnitsPerLine),
    R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: String(L.maxTotalUnits), R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: String(L.maxQuotesPerConversation),
    R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: String(L.maxQuotesPerHour), R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: String(L.confirmationWindowSeconds),
  };
  return { ...base, R4_PROD_ROLLOUT_ALLOWLIST: syntheticConversationKey(loadCanaryEnvironment(base), 'intent') };
}

class Router {
  readonly #routes = new Map<string, { steps: readonly ScriptedStep[]; next: number }>();
  readonly script: FakeModelScript = (request) => {
    const taskId = (request.context!.sections.task.find((i) => i.kind === 'task')!.content as { taskId: string }).taskId;
    const route = this.#routes.get(taskId);
    const step = route?.steps[route.next++];
    if (!step) return Promise.resolve({ type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, reason: 'script done' } });
    return Promise.resolve({ type: 'structured', data: step(new ContextView(request)) });
  };
  route(taskId: string, steps: readonly ScriptedStep[]): void {
    this.#routes.set(taskId, { steps, next: 0 });
  }
}

const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('not used here')) };
const ws = (operations: unknown[]): ScriptedStep => () => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate, arguments: { operations } });
const latest = (v: ContextView, id: string) => v.observations(id).filter((o) => o.outcome === 'succeeded').at(-1)!;
const preview = (v: ContextView) => latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).payload as { previewId: string; presentation: { offerMessage: string } };
const propose: ScriptedStep = (v) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.quoteCreate, arguments: { previewId: preview(v).previewId }, evidenceRefs: [latest(v, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).observationId] });
const STEPS = [ws([{ op: 'add_item', productId: 'BAR-EZ', quantity: 2 }]), ws([{ op: 'exclude_shipping' }]), read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}), respond((v) => preview(v).presentation.offerMessage), propose, respond('ok')];
/** (F1 policy v2, @19) The customer chooses a delivery offer the Shipping owner returns; it is quoted at that price. */
const ITEMS = [{ productId: 'BAR-EZ', quantity: 2 }];
const courier = (v: ContextView) => (latest(v, CAPABILITY_IDS.shippingQuote).payload as { offers: { carrierName: string; serviceType: string; price: { ownerNet: { amount: number } } }[] }).offers.find((o) => o.carrierName === 'Fixture Courier')!;
const SHIPPING_STEPS = [
  ws([{ op: 'add_item', productId: 'BAR-EZ', quantity: 2 }, { op: 'set_delivery_destination', commune: 'Ñuñoa' }]),
  read(CAPABILITY_IDS.shippingQuote, { destination: { commune: 'Ñuñoa' }, basis: 'order', items: ITEMS }),
  (v: ContextView) => ({ type: 'propose_action', capabilityId: CAPABILITY_IDS.workspaceUpdate, arguments: { operations: [{ op: 'select_shipping_offer', carrierName: courier(v).carrierName, serviceType: courier(v).serviceType, ownerNetClp: courier(v).price.ownerNet.amount }] } }),
  read(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, {}),
  respond((v) => preview(v).presentation.offerMessage),
  propose,
  respond('ok'),
] as ScriptedStep[];

/** One confirmed issuance under `profile`; what the owner issued, the R4 rows and what the delivery owner captured. */
async function issueOnce(profile: string, quotes: FixtureQuoteV2Service, reply = 'Sí, emítela.', steps: readonly ScriptedStep[] = STEPS) {
  db = await createTestDatabase('r4_it_intent_canary');
  const dir = mkdtempSync(join(tmpdir(), 'r4-intent-'));
  const capture = join(dir, 'capture.jsonl');
  const canary: CanaryEnvironment = loadCanaryEnvironment(canaryEnv(db.url, profile));
  await initCanary(canary, logger);
  const router = new Router();
  let ownerCalls = 0;
  const issue = quotes.createAndIssue.bind(quotes);
  quotes.createAndIssue = (...a: Parameters<typeof issue>) => ((ownerCalls += 1), issue(...a));
  const runtime: CanaryRuntime = await startCanaryRuntime(canary, {
    modelProvider: new FakeModelProvider(router.script), catalog: http(new FixtureCatalog()), catalogDiscover: discover, shipping: http(new FixtureShipping()), quotes: http(quotes),
    worker: {
      databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 3, workerId: 'intent', leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
      execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 6 },
      context: { budget: { mode: 'unbounded' } },
    },
    scheduler: { databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 2, owner: 'intent:scheduler', leaseMs: 30_000, pollMs: 25, reconciliationPolicy: RECONCILIATION_POLICY },
    captureFile: capture, logger, isolationCheckMs: 50,
  });
  const drain = async () => {
    for (let i = 0; i < 40; i += 1) {
      const fired = (await runtime.scheduler?.scheduler.runOnce())?.kind === 'fired';
      if ((await runtime.worker.worker.runOnce()).kind === 'idle' && !fired) break;
    }
    await runtime.delivery.tick();
    await runtime.delivery.tick();
  };
  try {
    const first = (await sendSynthetic(canary, { conversation: 'intent', text: 'Quiero 2 barras Z, sin despacho' }, logger)) as { taskId: string };
    router.route(first.taskId, steps);
    await drain();
    await sendSynthetic(canary, { conversation: 'intent', text: reply }, logger);
    await drain();
  } finally {
    await runtime.close();
  }
  const pool = openPool(db.url);
  try {
    const issued = (await pool.query('select quote_id, quote_number, pdf_sha256, document_verification, valid_until_exclusive from sales.quote_v2_issued')).rows as { quote_id: string; quote_number: string; pdf_sha256: string; document_verification: string; valid_until_exclusive: Date }[];
    const documents = (await pool.query(`select o.notice_key, o.status, d.sha256, d.filename, d.bytes is null as purged from outbound_documents d join outbound_messages o using (outbound_id)`)).rows as { notice_key: string; status: string; sha256: string; filename: string; purged: boolean }[];
    const delivery = (await pool.query(`select result->'document'->>'delivery' as delivery from action_receipts where capability_id = 'quote.create' and status = 'succeeded'`)).rows.map((r: { delivery: string | null }) => r.delivery);
    const captured = readFileSync(capture, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { text: string; document?: { filename: string; sha256: string } });
    const decisions = (await pool.query('select outcome, reason_code from sales.quote_autonomous_decisions')).rows as { outcome: string; reason_code: string }[];
    const refusals = (await pool.query(`select error_code, error_details->>'reason' as reason from action_receipts where capability_id = 'quote.create' and status = 'rejected'`)).rows as { error_code: string; reason: string | null }[];
    const grammar = (await pool.query('select grammar_version from sales.quote_intent_evidence')).rows.map((r: { grammar_version: string }) => r.grammar_version);
    const offers = captured.filter((c) => c.text.startsWith('Cotización lista para emitir')).map((c) => c.text.split('\n').at(-1));
    return { ownerCalls, issued, documents, captured, delivery, decisions, refusals, grammar, offers };
  } finally {
    await pool.end();
  }
}

describe('acceptance interpreted in natural language (@19)', { timeout: 150_000 }, () => {
  it.each(['si dale', 'oka, me parece', 'sí, emítelas', '👍'])('@19 issues exactly one quote when the customer answers the offer with %j', async (reply) => {
    const r = await issueOnce('sales-production@19', new FixtureQuoteV2Service(), reply);
    expect(r.ownerCalls).toBe(1);
    expect(r.issued).toHaveLength(1);
    expect(r.grammar).toEqual(['r4-sales-intent-guard-es-v1']);
    // Offer template v2: a natural closing question, no phrase to copy.
    expect(r.offers).toEqual(['¿Te emito esta cotización? Si quieres cambiar algo, dímelo.']);
    expect(r.captured.filter((c) => c.document)).toHaveLength(1);
  });

  it('@19 (F1 policy v2) issues a quote with the delivery offer the customer chose, at the Shipping owner price', async () => {
    const r = await issueOnce('sales-production@19', new FixtureQuoteV2Service(), 'dale', SHIPPING_STEPS);
    expect(r.ownerCalls).toBe(1);
    expect(r.issued).toHaveLength(1);
    const offer = r.captured.find((c) => c.text.startsWith('Cotización lista para emitir'))!.text;
    expect(offer).toMatch(/^Despacho: Fixture Courier, NORMAL, a Ñuñoa.*: \$[\d.]+$/m);
    expect(offer).not.toMatch(/Despacho: no incluido/);
    expect(r.captured.filter((c) => c.document)).toHaveLength(1);
  });

  it('@19 never issues when the reply is a question, even if the agent proposes it', async () => {
    const r = await issueOnce('sales-production@19', new FixtureQuoteV2Service(), '¿incluye despacho?');
    expect(r.ownerCalls).toBe(0);
    expect(r.issued).toEqual([]);
    expect(r.refusals).toEqual([{ error_code: 'customer_confirmation_not_explicit', reason: 'disqualified' }]);
  });

  it('@19 never issues the presented quote when an acceptance word comes with a change ("sí, la de 16 kg")', async () => {
    const r = await issueOnce('sales-production@19', new FixtureQuoteV2Service(), 'sí, la de 16 kg');
    expect(r.ownerCalls).toBe(0);
    expect(r.issued).toEqual([]);
    expect(r.refusals).toEqual([{ error_code: 'customer_confirmation_not_explicit', reason: 'disqualified' }]);
  });

  it('@18 keeps the closed grammar: a bare "si" is not a confirmation there', async () => {
    const r = await issueOnce('sales-production@18', new FixtureQuoteV2Service(), 'si');
    expect(r.ownerCalls).toBe(0);
    expect(r.refusals).toEqual([{ error_code: 'customer_confirmation_not_explicit', reason: 'not_a_confirmation' }]);
    expect(r.offers).toEqual(['¿Emito esta cotización? Puedes responder: Sí, emítela.']);
  });
});
