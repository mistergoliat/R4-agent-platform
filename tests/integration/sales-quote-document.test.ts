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
import { quoteDocumentCaption } from '@r4-sales/agent';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { RECONCILIATION_POLICY } from '../support/temporal.js';

/**
 * (Quote PDF delivery, «F1 canary continuation and quote delivery») @18 = @17 plus the issued quote's own PDF to the
 * conversation: quote.create@5 settlement queues ONE platform notice carrying the bytes it read from the Quote owner and
 * verified against the owner's SHA-256 (never regenerated); an unverified document is never sent and the quote stays
 * issued; @17 sends none. Isolated canary (real ingress, worker, Policy Engine, ActionExecutor, delivery owner);
 * scripted model; fixture owners.
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
    R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'r4-test-canary-identity-key-quote-doc-01',
    R4_PROD_ALLOW_NETWORK: 'false', R4_PROD_HOLD_RECHECK_MS: '10', R4_CANARY_DATABASE_URL: url, R4_LOG_LEVEL: 'silent',
    R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP: String(L.maxGrossClp), R4_AUTONOMOUS_QUOTE_MAX_LINES: String(L.maxLines), R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE: String(L.maxUnitsPerLine),
    R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS: String(L.maxTotalUnits), R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION: String(L.maxQuotesPerConversation),
    R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR: String(L.maxQuotesPerHour), R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS: String(L.confirmationWindowSeconds),
  };
  return { ...base, R4_PROD_ROLLOUT_ALLOWLIST: syntheticConversationKey(loadCanaryEnvironment(base), 'quote-doc') };
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

/** One confirmed issuance under `profile`; what the owner issued, the R4 rows and what the delivery owner captured. */
async function issueOnce(profile: string, quotes: FixtureQuoteV2Service) {
  db = await createTestDatabase('r4_it_qdoc_canary');
  const dir = mkdtempSync(join(tmpdir(), 'r4-qdoc-'));
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
      databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 3, workerId: 'qdoc', leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000, pollIntervalMs: 20, maxRunRecoveries: 3, maxRunFailureRecoveries: 1,
      execution: { maxIterations: 20, maxModelCalls: 20, maxReadCapabilityCalls: 20, maxRunDurationMs: 60_000, modelCallTimeoutMs: 10_000, maxWriteActions: 6 },
      context: { budget: { mode: 'unbounded' } },
    },
    scheduler: { databaseUrl: db.url, logLevel: 'silent', dbPoolMax: 2, owner: 'qdoc:scheduler', leaseMs: 30_000, pollMs: 25, reconciliationPolicy: RECONCILIATION_POLICY },
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
    const first = (await sendSynthetic(canary, { conversation: 'quote-doc', text: 'Quiero 2 barras Z, sin despacho' }, logger)) as { taskId: string };
    router.route(first.taskId, STEPS);
    await drain();
    await sendSynthetic(canary, { conversation: 'quote-doc', text: 'Sí, emítela.' }, logger);
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
    return { ownerCalls, issued, documents, captured, delivery };
  } finally {
    await pool.end();
  }
}

describe('quote PDF delivery (@18)', { timeout: 150_000 }, () => {
  it('@18: one issuance sends exactly one document, the owner\'s verified bytes, to the conversation', async () => {
    const r = await issueOnce('sales-production@18', new FixtureQuoteV2Service());
    expect(r.ownerCalls).toBe(1);
    expect(r.issued).toHaveLength(1);
    const q = r.issued[0]!;
    expect(q.document_verification).toBe('verified');
    expect(r.documents).toEqual([{ notice_key: `sales.quote-document:${q.quote_id.toLowerCase()}`, status: 'accepted', sha256: q.pdf_sha256, filename: `Cotizacion-${q.quote_number}.pdf`, purged: true }]);
    const sentDocs = r.captured.filter((c) => c.document);
    expect(r.delivery).toEqual(['queued']);
    expect(sentDocs).toEqual([expect.objectContaining({ text: quoteDocumentCaption(q.quote_number, new Date(q.valid_until_exclusive).toISOString()), document: expect.objectContaining({ sha256: q.pdf_sha256 }) })]);
  });

  it('@18: a document that does not match the owner manifest is never sent; the quote stays issued, once', async () => {
    const quotes = new FixtureQuoteV2Service();
    quotes.faults.document = () => 'corrupt';
    const r = await issueOnce('sales-production@18', quotes);
    expect(r.ownerCalls).toBe(1);
    expect(r.issued.map((q) => q.document_verification)).toEqual(['mismatch']);
    // The agent is told: the PDF will not come (definition v17 then never announces it).
    expect(r.delivery).toEqual(['not_queued']);
    expect(r.documents).toEqual([]);
    expect(r.captured.filter((c) => c.document)).toEqual([]);
  });

  it('@17, the deployed profile, sends no document', async () => {
    const r = await issueOnce('sales-production@17', new FixtureQuoteV2Service());
    expect(r.ownerCalls).toBe(1);
    expect(r.issued.map((q) => q.document_verification)).toEqual(['verified']);
    expect(r.delivery).toEqual([null]);
    expect(r.documents).toEqual([]);
    expect(r.captured.filter((c) => c.document)).toEqual([]);
  });
});
