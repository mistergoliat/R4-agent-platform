import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogItemContext, type CatalogPort, type QuoteV2Quote, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CapabilityHandlerContext, WriteHandlerContext } from '@r4/capability-runtime';
import { AutonomyControls, type ProductionStore } from '@r4/live-ops';
import { createSilentLogger } from '@r4/observability';
import { PostgresProductionStore, type Pool } from '@r4/persistence-postgres';
import {
  PostgresSalesStore,
  migrateSales,
  quoteCreateV3Input,
  quoteCreateV4Capability,
  quoteCreateV5Capability,
  quotePreviewV3Capability,
  renderOfferMessage,
  resolveOrderBasis,
  workspaceCapabilityV2,
  workspaceUpdateV2InputSchema,
  type AutonomousQuoteLimitsV6,
  type ConversationThreadEntry,
  type QuotePreviewV3Output,
} from '@r4-sales/agent';
import { killSwitchGuardedQuotes } from '@r4-sales/agent/production';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * R4-J3E-C1 offline matrix of quote.create@5: the offer the customer confirms
 * is the message Sales rendered (r4-sales-offer-es-v1), compared byte for byte
 * with the rendering of the snapshot recomputed at issuance; the owner's
 * answer is settled strictly; Quote V2 writes stop with the REAL durable kill
 * switch (autonomy_controls of this database, read at every call). Real
 * PostgreSQL (`sales` 0006–0009), fixture owners, a controllable stand-in of
 * ProductionStore.thread (the real port runs in sales-deterministic-offer-canary).
 */
let db: TestDatabase;
let pool: Pool;
let controls: AutonomyControls;

const logger = createSilentLogger();
const setAutonomy = (enabled: boolean) => controls.set({ scope: 'global', autonomyEnabled: enabled, reason: enabled ? 'test: autonomy on' : 'test: kill switch', changedBy: 'it-deterministic-offer', correlationId: randomUUID() });

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  expect((await migrateSales(pool)).applied).toEqual(['0006_sales_reference_application', '0007_sales_quote_v2_issuance', '0008_sales_autonomous_quote_decisions', '0009_sales_quote_intent_evidence']);
  controls = new AutonomyControls({ store: new PostgresProductionStore(pool), logger });
  // A fresh deployment is autonomous for nobody (global DISABLED): the matrix runs with autonomy enabled unless a case engages the switch.
  expect((await controls.admit()).admitted).toBe(false);
  await setAutonomy(true);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const NOW = new Date('2026-10-14T15:00:00Z');
const newKey = () => `r4x_${randomBytes(16).toString('hex')}`;
const LIMITS: AutonomousQuoteLimitsV6 = { maxGrossClp: 500_000, maxLines: 3, maxUnitsPerLine: 5, maxTotalUnits: 5, maxQuotesPerConversation: 3, maxQuotesPerHour: 1_000, confirmationWindowSeconds: 900 };

class Thread {
  readonly entries: ConversationThreadEntry[] = [];
  #clock = Date.parse('2026-10-14T14:00:00Z');

  tick(seconds = 10): string {
    this.#clock += seconds * 1000;
    return new Date(this.#clock).toISOString();
  }

  agent(text: string, options: { status?: string | null; after?: number } = {}): string {
    const at = this.tick(options.after ?? 10);
    const stepId = randomUUID();
    this.entries.push({ cursor: `${at}|${stepId}`, at, kind: 'agent', text, refs: { stepId }, delivery: options.status === null ? null : { outboundId: randomUUID(), status: options.status ?? 'accepted' } });
    return stepId;
  }

  customer(text: string, options: { after?: number } = {}): string {
    const at = this.tick(options.after ?? 10);
    const inputId = randomUUID();
    this.entries.push({ cursor: `${at}|${inputId}`, at, kind: 'contact', text, refs: { inputId }, delivery: null });
    return inputId;
  }

  readonly reader = { thread: () => Promise.resolve([...this.entries]) };
}

/** An owner whose answers are altered after it committed (what a defective Quote V2 could return). */
function tampering(owner: FixtureQuoteV2Service, tamper: (quote: QuoteV2Quote) => QuoteV2Quote): QuoteV2Service {
  return {
    createAndIssue: async (...a) => {
      const result = await owner.createAndIssue(...a);
      return { ...result, quote: tamper(result.quote) };
    },
    getQuote: async (...a) => tamper(await owner.getQuote(...a)),
    getOperation: (...a) => owner.getOperation(...a),
    lookupIdempotency: (...a) => owner.lookupIdempotency(...a),
    getDocument: (...a) => owner.getDocument(...a),
  };
}

function world(options: { limits?: Partial<AutonomousQuoteLimitsV6>; owner?: FixtureQuoteV2Service; tamper?: (quote: QuoteV2Quote) => QuoteV2Quote; controls?: AutonomyControls } = {}) {
  const store = new PostgresSalesStore(pool);
  const baseCatalog = new FixtureCatalog({ now: () => NOW });
  const baseShipping = new FixtureShipping({ now: () => NOW });
  const owner = options.owner ?? new FixtureQuoteV2Service({ now: () => NOW });
  const gate = options.controls ?? controls;
  const limits = { ...LIMITS, ...options.limits };
  const state = { catalogPatch: null as null | ((item: CatalogItemContext) => CatalogItemContext | Promise<CatalogItemContext>) };
  const catalog: CatalogPort = {
    search: (...a) => baseCatalog.search(...a),
    getProductContext: (...a) => baseCatalog.getProductContext(...a),
    getItemContext: async (request, callOptions) => {
      const item = await baseCatalog.getItemContext(request, callOptions);
      return state.catalogPatch ? state.catalogPatch(item) : item;
    },
  };
  const shipping: ShippingService = { quote: (...a) => baseShipping.quote(...a) };
  const thread = new Thread();
  const clock = { now: () => NOW };
  // The @7 composition's Quote port: createAndIssue behind the durable kill switch.
  const quotes = killSwitchGuardedQuotes(options.tamper ? tampering(owner, options.tamper) : owner, gate, logger);
  const workspaceV2 = workspaceCapabilityV2({ store, catalog, shipping, clock });
  const preview = quotePreviewV3Capability({ store, catalog, shipping, limits, now: () => NOW });
  const create = () => quoteCreateV5Capability({ store, quotes, catalog, shipping, limits, conversation: thread.reader, admission: gate, now: () => NOW });
  let capability = create();
  const taskId = randomUUID();
  const trusted = { taskId, runId: randomUUID(), agentId: 'sales', agentVersion: 7, correlationId: 'it-quote-v5', grantedScopes: ['quote.create', 'catalog.read', 'shipping.read', 'sales.workspace.write'] };
  const writeContext = (executionKey: string, attempt = 1): WriteHandlerContext => ({ executionKey, attempt, signal: new AbortController().signal, execution: { ...trusted, actor: { kind: 'service', ref: 'sales-channel-ingress' }, identityAssurance: 'provisional' } });
  const readContext = (): CapabilityHandlerContext => ({ execution: trusted, invocationId: randomUUID(), signal: new AbortController().signal });
  const courierNet = async (items: { productId: string; quantity: number }[]) => {
    const basis = await resolveOrderBasis(baseCatalog, items);
    return (await shipping.quote({ destination: { commune: 'Ñuñoa' }, basis: { type: 'order', ...basis } })).offers.find((o) => o.carrierName === 'Fixture Courier')!.price.ownerNet.amount;
  };
  return {
    store, owner, state, thread, taskId, courierNet, quotes,
    update: (operations: unknown[]) => workspaceV2.execute(workspaceUpdateV2InputSchema.parse({ operations }), writeContext(newKey())),
    preview: () => preview.handler({}, readContext()),
    issue: (previewId: string, executionKey = newKey(), attempt = 1) => capability.execute(quoteCreateV3Input.parse({ previewId }), writeContext(executionKey, attempt)),
    reconcile: (executionKey: string) => capability.reconcile!(writeContext(executionKey, 2)),
    /** quote.create@4 (sales-production@6) over the same records: the version that verified only reference and total. */
    issueV4: (previewId: string) => quoteCreateV4Capability({ store, quotes, catalog, shipping, limits, conversation: thread.reader, now: () => NOW }).execute(quoteCreateV3Input.parse({ previewId }), writeContext(newKey())),
    restart: () => {
      capability = create();
    },
    decisions: async () => (await pool.query<{ outcome: string; reason_code: string }>('select outcome, reason_code from sales.quote_autonomous_decisions where task_id = $1 order by decided_at', [taskId])).rows.map((r) => `${r.outcome}:${r.reason_code}`),
  };
}
type World = ReturnType<typeof world>;

/** Two lines, delivery to Ñuñoa with the customer's chosen offer. */
const ITEMS = [
  { productId: 'BAR-OLY20', quantity: 1 },
  { productId: 'BAR-EZ', quantity: 2 },
];

/** Selection, the customer's shipping choice, a ready preview, and the Sales offer message delivered as the agent's reply. */
async function offered(w: World): Promise<QuotePreviewV3Output> {
  expect(await w.update([...ITEMS.map((i) => ({ op: 'add_item', ...i })), { op: 'set_delivery_destination', commune: 'Ñuñoa' }])).toMatchObject({ status: 'applied' });
  expect(await w.update([{ op: 'select_shipping_offer', carrierName: 'Fixture Courier', serviceType: 'NORMAL', ownerNetClp: await w.courierNet(ITEMS) }])).toMatchObject({ status: 'applied' });
  const p = await w.preview();
  expect(p).toMatchObject({ status: 'ready', issuable: true, presentation: { offerTemplate: 'r4-sales-offer-es-v1', reference: expect.stringMatching(/^Q-[0-9A-F]{6}-\d+$/) } });
  w.thread.customer('Quiero cotizar una barra olímpica y dos barras Z con despacho a Ñuñoa', { after: 1 });
  w.thread.agent(p.presentation!.offerMessage);
  return p;
}

/**
 * A catalog variant (Kettlebell de competición, Peso 12 kg) and delivery explicitly excluded: the order-basis
 * shipping quote reads the parent product's weight, which the fixture keeps per variant only (pre-existing J2 rule).
 */
async function offeredVariant(w: World): Promise<QuotePreviewV3Output> {
  expect(await w.update([{ op: 'add_item', productId: 'KB-COMP-12', quantity: 1 }, { op: 'add_item', productId: 'BAR-EZ', quantity: 1 }, { op: 'exclude_shipping' }])).toMatchObject({ status: 'applied' });
  const p = await w.preview();
  expect(p).toMatchObject({ status: 'ready', issuable: true });
  expect(p.presentation!.offerMessage).toContain('1. Kettlebell de competición\nVariante: Peso: 12 kg\nCantidad: 1;');
  expect(p.presentation!.offerMessage).toContain('\n\nDespacho: no incluido.\n\n');
  w.thread.customer('Quiero la kettlebell de 12 kg y una barra Z, sin despacho', { after: 1 });
  w.thread.agent(p.presentation!.offerMessage);
  return p;
}

describe('A. the exact Sales offer, confirmed, issues once', () => {
  it('A1 quote.preview@3 renders the snapshot; the identical message + "Sí, emítela." issues; the evidence binds its SHA-256 without copying text', async () => {
    const w = world();
    const p = await offered(w);
    const presentation = p.presentation!;
    expect(presentation.offerMessage).toBe(renderOfferMessage(p.snapshot!, presentation.reference));
    expect(presentation.offerMessage).toContain(`Total: $${presentation.totalText.match(/\$([\d.]+)/)![1]} (IVA incluido)`);
    const inputId = w.thread.customer('Sí, emítela.');
    const key = newKey();
    expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001', totals: { gross: presentation.grossClp }, document: { verification: 'verified' } } });
    expect(w.owner.quotes).toHaveLength(1);
    expect(await w.store.intentEvidence(key)).toMatchObject({ offerTextSha256: presentation.offerMessageSha256, confirmationInputId: inputId, presentedReference: presentation.reference });
    expect((await w.store.autonomousDecision(key))!.quoteRequest).toMatchObject({ source: 'conversation_thread', offerTemplate: 'r4-sales-offer-es-v1', offerMessageSha256: presentation.offerMessageSha256, reference: presentation.reference, confirmationInputId: inputId });
    const rows = JSON.stringify((await pool.query('select e.*, d.quote_request from sales.quote_intent_evidence e join sales.quote_autonomous_decisions d using (execution_key) where e.execution_key = $1', [key])).rows);
    expect(rows).not.toMatch(/Cotización lista|Condiciones|em[ií]tela/);
  });

  it('A2 a preview over an autonomy limit carries no offer message: there is nothing the customer could confirm', async () => {
    const w = world({ limits: { maxGrossClp: 100_000 } });
    await w.update([...ITEMS.map((i) => ({ op: 'add_item', ...i })), { op: 'set_delivery_destination', commune: 'Ñuñoa' }]);
    await w.update([{ op: 'select_shipping_offer', carrierName: 'Fixture Courier', serviceType: 'NORMAL', ownerNetClp: await w.courierNet(ITEMS) }]);
    const p = await w.preview();
    expect(p).toMatchObject({ status: 'ready', issuable: false, presentation: null });
    expect(p.limitBreaches.map((b) => b.code)).toEqual(['autonomy_limit_amount']);
  });
});

describe('B. any difference between the confirmed message and the Sales offer refuses the issuance', () => {
  const swap = (from: string, to: string) => (text: string) => {
    expect(text, from).toContain(from);
    return text.replace(from, to);
  };
  const amountAfter = (label: string) => (text: string) => {
    const match = new RegExp(`${label}\\$([\\d.]+)`).exec(text)!;
    return text.replace(match[0], `${label}$${match[1]!.replace(/\d$/, (d) => String((Number(d) + 1) % 10))}`);
  };
  it.each([
    ['product', swap('Barra Z 1,2 m', 'Barra Z 1,5 m')],
    ['quantity', swap('Cantidad: 2;', 'Cantidad: 3;')],
    ['unit price', amountAfter('precio unitario: ')],
    ['subtotal', amountAfter('subtotal: ')],
    ['shipping carrier', swap('Despacho: Fixture Courier', 'Despacho: Otro Courier')],
    ['shipping destination', swap('a Ñuñoa', 'a Providencia')],
    ['shipping amount', (text: string) => text.replace(/^(Despacho: .*\$[\d.]*)(\d)$/m, (_m, head: string, last: string) => `${head}${(Number(last) + 1) % 10}`)],
    ['net', amountAfter('Neto: ')],
    ['VAT', amountAfter('IVA: ')],
    ['total', amountAfter('Total: ')],
    ['reference', (text: string) => text.replace(/Ref\. (Q-[0-9A-F]{6})-(\d+)/, (_m, prefix: string, version: string) => `Ref. ${prefix}-${Number(version) + 1}`)],
    ['doubled space', swap('Neto: ', 'Neto:  ')],
    ['CRLF line breaks', (text: string) => text.replace(/\n/g, '\r\n')],
    ['accent dropped', swap('Cotización', 'Cotizacion')],
    ['symbol dropped', swap('¿Emito', 'Emito')],
    ['thousands format', (text: string) => text.replace(/\$(\d{1,3})\.(\d{3})/, '$$$1,$2')],
    ['text before', (text: string) => `¡Perfecto! Aquí va tu cotización:\n\n${text}`],
    ['text after', (text: string) => `${text}\n\nCualquier duda me avisas.`],
    ['discount claim appended', (text: string) => `${text} Te aplico un 10% de descuento.`],
  ])('B1 %s → offer_not_presented, nothing decided for issuance, the owner never called', async (_name, mutate) => {
    const w = world();
    await offered(w);
    const p = await w.preview();
    // Replace the delivered offer with the mutated one (the same agent turn).
    w.thread.entries.pop();
    w.thread.agent(mutate(p.presentation!.offerMessage));
    w.thread.customer('Sí, emítela.');
    const result = await w.issue(p.previewId!);
    expect(result).toMatchObject({ status: 'rejected', code: 'offer_not_presented' });
    expect(w.owner.createCalls).toBe(0);
    expect(await w.decisions()).toEqual(['rejected:offer_not_presented']);
  });

  it('B1 variant → offer_not_presented; the exact variant offer then issues once', async () => {
    const w = world();
    const p = await offeredVariant(w);
    w.thread.entries.pop();
    w.thread.agent(p.presentation!.offerMessage.replace('Peso: 12 kg', 'Peso: 24 kg'));
    w.thread.customer('Sí, emítela.');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code: 'offer_not_presented' });
    expect(w.owner.createCalls).toBe(0);
    w.thread.agent(p.presentation!.offerMessage);
    w.thread.customer('Sí, emítela.');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'applied', result: { shipping: null } });
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('B2 the refusal names the template and both hashes; the version that checked only reference and total (quote.create@4) would have issued', async () => {
    const w = world();
    await offered(w);
    const p = await w.preview();
    w.thread.entries.pop();
    const lying = p.presentation!.offerMessage.replace('Cantidad: 2;', 'Cantidad: 3;');
    w.thread.agent(lying);
    w.thread.customer('Sí, emítela.');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code: 'offer_not_presented', details: { offerTemplate: 'r4-sales-offer-es-v1', expectedSha256: p.presentation!.offerMessageSha256, presentedSha256: expect.not.stringMatching(p.presentation!.offerMessageSha256) } });
    expect(w.owner.createCalls).toBe(0);
    // The documented J3E-B weakness, now closed in @5: @4 accepts a wrong quantity when the reference and the total are present.
    expect(await w.issueV4(p.previewId!)).toMatchObject({ status: 'applied' });
  });

  it('B3 an offer of an earlier commercial version (change and revert) is refused; the current offer re-presented issues once', async () => {
    const w = world();
    const first = await offered(w);
    await w.update([{ op: 'set_item_quantity', productId: 'BAR-EZ', quantity: 1 }]);
    await w.update([{ op: 'set_item_quantity', productId: 'BAR-EZ', quantity: 2 }]);
    await w.update([{ op: 'select_shipping_offer', carrierName: 'Fixture Courier', serviceType: 'NORMAL', ownerNetClp: await w.courierNet(ITEMS) }]);
    const again = await w.preview();
    expect(again.previewId).toBe(first.previewId);
    expect(again.presentation!.offerMessage).not.toBe(first.presentation!.offerMessage);
    w.thread.agent(first.presentation!.offerMessage);
    w.thread.customer('Sí, emítela.');
    expect(await w.issue(again.previewId!)).toMatchObject({ status: 'rejected', code: 'offer_not_presented' });
    w.thread.agent(again.presentation!.offerMessage);
    w.thread.customer('Sí, emítela.');
    expect(await w.issue(again.previewId!)).toMatchObject({ status: 'applied' });
    expect(w.owner.quotes).toHaveLength(1);
  });
});

describe('C. the customer confirmation (quote.create@4 rules, unchanged in @5)', () => {
  it('C1 an ambiguous reply is refused; the identical offer re-presented and "CONFIRMO" issue once', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_not_explicit' });
    w.thread.agent(p.presentation!.offerMessage);
    w.thread.customer('CONFIRMO');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'applied' });
    expect(w.owner.quotes).toHaveLength(1);
    expect(await w.decisions()).toEqual(['rejected:customer_confirmation_not_explicit', 'authorized:eligible']);
  });

  it('C2 a late confirmation (expired offer), a reused confirmation, a negation and an undelivered offer are refused', async () => {
    const late = world({ limits: { confirmationWindowSeconds: 600 } });
    const pl = await offered(late);
    late.thread.customer('Sí, emítela.', { after: 601 });
    expect(await late.issue(pl.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_expired' });

    const reused = world();
    const pr = await offered(reused);
    reused.thread.customer('Sí, emítela.');
    expect(await reused.issue(pr.previewId!)).toMatchObject({ status: 'applied' });
    expect(await reused.issue(pr.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_used' });
    expect(reused.owner.quotes).toHaveLength(1);

    const no = world();
    const pn = await offered(no);
    no.thread.customer('No confirmo, todavía lo estoy pensando.');
    expect(await no.issue(pn.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_not_explicit' });

    const undelivered = world();
    const pu = await offered(undelivered);
    undelivered.thread.entries.pop();
    undelivered.thread.agent(pu.presentation!.offerMessage, { status: 'failed' });
    undelivered.thread.customer('Sí, emítela.');
    expect(await undelivered.issue(pu.previewId!)).toMatchObject({ status: 'rejected', code: 'offer_not_delivered' });
    expect(late.owner.createCalls + no.owner.createCalls + undelivered.owner.createCalls).toBe(0);
  });
});

describe('D. concurrency, replay, restart', () => {
  it('D1 three simultaneous commands on one confirmation issue one quote; two conversations with identical content issue two', async () => {
    const c = world();
    const pc = await offered(c);
    c.thread.customer('Sí, emítela.');
    const outcomes = await Promise.all([c.issue(pc.previewId!), c.issue(pc.previewId!), c.issue(pc.previewId!)]);
    expect(outcomes.filter((o) => o.status === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected').map((o) => (o as { code: string }).code)).toEqual(['customer_confirmation_used', 'customer_confirmation_used']);
    expect(c.owner.quotes).toHaveLength(1);

    const owner = new FixtureQuoteV2Service({ now: () => NOW });
    const a = world({ owner });
    const b = world({ owner });
    const [pa, pb] = await Promise.all([offered(a), offered(b)]);
    a.thread.customer('Sí, emítela.');
    b.thread.customer('Confirmo la cotización');
    expect((await Promise.all([a.issue(pa.previewId!), b.issue(pb.previewId!)])).map((r) => r.status)).toEqual(['applied', 'applied']);
    expect(owner.quotes).toHaveLength(2);
  });

  it('D2 a lost answer after a restart is reconciled (strictly) by the same key; the replay decides nothing again', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    w.restart();
    w.owner.faults.afterCommit = () => 'timeout';
    const key = newKey();
    expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'unknown' });
    w.restart();
    w.owner.faults.afterCommit = () => 'answer';
    expect(await w.reconcile(key)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001', document: { verification: 'verified' } } });
    expect(await w.issue(p.previewId!, key, 2)).toMatchObject({ status: 'applied', replayed: true });
    expect(w.owner.quotes).toHaveLength(1);
    expect(await w.decisions()).toEqual(['authorized:eligible']);
  });
});

describe('E. strict settlement of what Quote V2 returns', () => {
  const lines = (quote: QuoteV2Quote, map: (l: QuoteV2Quote['lines'][number], i: number) => QuoteV2Quote['lines'][number]) => ({ ...quote, lines: quote.lines.map(map) });
  it.each([
    // Equal totals, redistributed between lines: invisible to totals-only settlement.
    ['line amounts redistributed', (q: QuoteV2Quote) => lines(q, (l, i) => (i === 0 ? { ...l, amounts: { ...l.amounts, net: l.amounts.net + 1, tax: l.amounts.tax - 1 } } : l)), /line 1 amounts differ/],
    ['lines swapped between positions', (q: QuoteV2Quote) => lines(q, (l, i) => ({ ...l, amounts: q.lines[(i + 1) % q.lines.length]!.amounts })), /line 1 amounts differ/],
    ['shipping components', (q: QuoteV2Quote) => ({ ...q, shipping: { amounts: { ...q.shipping!.amounts, net: q.shipping!.amounts.net - 1, tax: q.shipping!.amounts.tax + 1 } } }), /shipping amounts differ/],
    ['exempt net', (q: QuoteV2Quote) => ({ ...q, totals: { ...q.totals, exemptNet: 1 } }), /exempt net differs/],
    ['correlation type', (q: QuoteV2Quote) => ({ ...q, externalCorrelation: { ...q.externalCorrelation, externalReferenceType: 'crm-opportunity' } }), /external correlation type differs/],
  ])('E1 %s → unknown (issued but inconsistent), never success; the same key replays, no new key', async (_name, tamper, problem) => {
    const owner = new FixtureQuoteV2Service({ now: () => NOW });
    const w = world({ owner, tamper });
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    const key = newKey();
    const first = await w.issue(p.previewId!, key);
    expect(first).toMatchObject({ status: 'unknown' });
    expect((first as { message: string }).message).toMatch(problem);
    // Reconciliation reads the same owner record: still inconsistent, still unknown.
    expect(await w.reconcile(key)).toMatchObject({ status: 'unknown' });
    // A replay of the same command reuses the frozen body and key: the owner replays, nothing is issued twice.
    expect(await w.issue(p.previewId!, key, 2)).toMatchObject({ status: 'unknown' });
    expect(owner.quotes).toHaveLength(1);
    expect(await w.decisions()).toEqual(['authorized:eligible']);
  });

  it('E2 the PDF is verified by SHA-256; a corrupt document is reported as mismatch, never verified', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    w.owner.faults.document = () => 'corrupt';
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'applied', result: { document: { verification: 'mismatch' } } });
    expect(w.owner.quotes).toHaveLength(1);
  });
});

describe('F. the kill switch over Quote V2 writes (durable controls, read at the call)', () => {
  it('F1 engaged before the execution: refused before any decision, owner never called; released, a new command for the same preview issues once', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    await setAutonomy(false);
    try {
      const key = newKey();
      expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'failed', code: 'autonomy_disabled', details: { reason: 'autonomy_disabled', retryable: true } });
      expect(await w.store.autonomousDecision(key)).toBeNull();
      expect(await w.store.quoteV2Request(key)).toBeNull();
    } finally {
      await setAutonomy(true);
    }
    expect(w.owner.createCalls).toBe(0);
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'applied' });
    expect(w.owner.quotes).toHaveLength(1);
  });

  // Handler level only: the platform lifecycle of a held command (backoff, admission, reconcile, replay) runs in sales-deterministic-offer-canary.
  it('F2 engaged while deciding (after the first check): the authorized command is held (unknown), never failed; no send recorded; a lookup establishes not applied; replays stay held while engaged; released, the same key sends its frozen body once', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    let engaged = false;
    w.state.catalogPatch = async (item) => {
      if (!engaged) {
        engaged = true;
        await setAutonomy(false);
      }
      return item;
    };
    const key = newKey();
    try {
      expect(await w.issue(p.previewId!, key)).toEqual({ status: 'unknown', message: expect.stringMatching(/^autonomy_disabled \(autonomy_disabled\): the authorized quote was not sent/) });
      expect(w.owner.createCalls).toBe(0);
      // The authorization and the frozen body exist (decided before the switch); nothing was sent, nor recorded as sent.
      expect((await w.store.autonomousDecision(key))!.outcome).toBe('authorized');
      expect(await w.store.quoteV2Request(key)).not.toBeNull();
      expect(await w.store.quoteV2SendAgeMs(key)).toBeNull();
      // The reconciliation the platform runs next is a read (open while engaged): not applied, which permits a replay of the same key.
      expect(await w.reconcile(key)).toEqual({ status: 'not_applied' });
      // A replay while engaged is held again before the owner (the pre-decision check does not apply to an authorized command).
      expect(await w.issue(p.previewId!, key, 3)).toMatchObject({ status: 'unknown' });
      expect(w.owner.createCalls).toBe(0);
    } finally {
      w.state.catalogPatch = null;
      await setAutonomy(true);
    }
    expect(await w.issue(p.previewId!, key, 5)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001' } });
    expect(w.owner.quotes).toHaveLength(1);
    expect(await w.decisions()).toEqual(['authorized:eligible']);
    // ADR-034: the snapshot is authorized for that key only; a NEW command for it in this conversation is a duplicate.
    w.thread.agent(p.presentation!.offerMessage);
    w.thread.customer('Sí, emítela.');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code: 'duplicate_quote' });
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('F2b engaged between the last check and the guarded call: the guard refuses, the command is held; the send already recorded keeps the lookup unknown inside the owner window (no premature "not applied")', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    const recordSend = w.store.recordQuoteV2Send.bind(w.store);
    w.store.recordQuoteV2Send = async (executionKey) => {
      await recordSend(executionKey);
      await setAutonomy(false);
    };
    const key = newKey();
    try {
      expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'unknown', message: expect.stringMatching(/not sent/) });
      expect(w.owner.createCalls).toBe(0);
      expect(await w.store.quoteV2SendAgeMs(key)).not.toBeNull();
      expect(await w.reconcile(key)).toMatchObject({ status: 'unknown', message: expect.stringMatching(/could still commit/) });
    } finally {
      await setAutonomy(true);
    }
    expect(w.owner.quotes).toHaveLength(0);
  });

  it('F3 engaged during a reconciliation: the reads still settle the issued quote (never declared failed); no create call', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    w.owner.faults.afterCommit = () => 'timeout';
    const key = newKey();
    expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'unknown' });
    w.owner.faults.afterCommit = () => 'answer';
    const calls = w.owner.createCalls;
    await setAutonomy(false);
    try {
      expect(await w.reconcile(key)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001', document: { verification: 'verified' } } });
      expect(await w.quotes.lookupIdempotency(key)).toMatchObject({ quoteStatus: 'issued' });
    } finally {
      await setAutonomy(true);
    }
    expect(w.owner.createCalls).toBe(calls);
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('F5 LIMITATION: a per-channel switch does not stop a quote.create@5 write (only the global switch is read; the channel switch holds inbound and outbound only)', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    const channel = (enabled: boolean) => controls.set({ scope: 'channel:whatsapp', autonomyEnabled: enabled, reason: enabled ? 'test: channel on' : 'test: channel off', changedBy: 'it-deterministic-offer', correlationId: randomUUID() });
    await channel(false);
    try {
      expect(await controls.enabledFor('whatsapp')).toBe(false);
      expect(await w.issue(p.previewId!)).toMatchObject({ status: 'applied' });
      expect(w.owner.createCalls).toBe(1);
    } finally {
      await channel(true);
    }
  });

  it('F4 controls that cannot be read count as engaged (fail closed)', async () => {
    const unreadable = new AutonomyControls({ store: { readControls: () => Promise.reject(new Error('database down')) } as unknown as ProductionStore, logger });
    const w = world({ controls: unreadable });
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'failed', code: 'autonomy_disabled', details: { reason: 'autonomy_controls_unavailable' } });
    await expect(w.quotes.createAndIssue({} as never, newKey())).rejects.toMatchObject({ code: 'autonomy_disabled' });
    expect(w.owner.createCalls).toBe(0);
  });
});
