import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  FixtureCatalog,
  FixtureQuoteV2Service,
  FixtureShipping,
  type CatalogItemContext,
  type CatalogPort,
  type QuoteV2Service,
  type ShippingService,
} from '@r4-adapters/domains';
import type { CapabilityHandlerContext, WriteHandlerContext } from '@r4/capability-runtime';
import {
  PostgresSalesStore,
  migrateSales,
  quoteCreateV3Capability,
  quoteCreateV3Input,
  quotePreviewCapability,
  resolveOrderBasis,
  workspaceCapabilityV2,
  workspaceUpdateV2InputSchema,
  type AutonomousQuoteLimits,
} from '@r4-sales/agent';
import type { Pool } from '@r4/persistence-postgres';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * R4-J3E offline matrix of autonomous quote issuance: quote.preview (READ),
 * sales.workspace.update@2 and quote.create@3 against the Quote V2, Catalog and
 * Shipping fixture owners and a real PostgreSQL `sales` schema (0006–0008).
 * Every case asserts what the Quote owner actually committed: an incorrect
 * quote is never counted as a success, a duplicate is never issued.
 */
let db: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  expect((await migrateSales(pool)).applied).toEqual(['0006_sales_reference_application', '0007_sales_quote_v2_issuance', '0008_sales_autonomous_quote_decisions']);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const NOW = new Date('2026-10-13T15:00:00Z');
const newKey = () => `r4x_${randomBytes(16).toString('hex')}`;
const LIMITS: AutonomousQuoteLimits = { maxGrossClp: 1_000_000, maxLines: 5, maxUnitsPerLine: 10, maxQuotesPerConversation: 3, maxQuotesPerHour: 1_000 };

type CatalogWrap = (base: FixtureCatalog) => CatalogPort;
type ShippingWrap = (base: FixtureShipping) => ShippingService;

/** One conversation (task) with mutable owner behavior: wrappers read `w.catalogPatch` / `w.shippingNetDelta` at call time. */
function world(options: { limits?: Partial<AutonomousQuoteLimits>; quotes?: (base: FixtureQuoteV2Service) => QuoteV2Service; owner?: FixtureQuoteV2Service; taskId?: string } = {}) {
  const store = new PostgresSalesStore(pool);
  const baseCatalog = new FixtureCatalog({ now: () => NOW });
  const baseShipping = new FixtureShipping({ now: () => NOW });
  const owner = options.owner ?? new FixtureQuoteV2Service({ now: () => NOW });
  const limits = { ...LIMITS, ...options.limits };
  const state = { catalogPatch: null as null | ((item: CatalogItemContext, quantity: number) => CatalogItemContext), shippingNetDelta: 0, catalogDown: false };
  const catalogWrap: CatalogWrap = (base) => ({
    search: (...a) => base.search(...a),
    getProductContext: (...a) => base.getProductContext(...a),
    getItemContext: async (request, callOptions) => {
      if (state.catalogDown) throw new DomainError('temporarily_unavailable', 'catalog_unavailable', 'catalog down');
      const item = await base.getItemContext(request, callOptions);
      return state.catalogPatch ? state.catalogPatch(item, request.quantity) : item;
    },
  });
  const shippingWrap: ShippingWrap = (base) => ({
    quote: async (request, callOptions) => {
      const quote = await base.quote(request, callOptions);
      return state.shippingNetDelta === 0 ? quote : { ...quote, offers: quote.offers.map((o) => ({ ...o, price: { ...o.price, ownerNet: { ...o.price.ownerNet, amount: o.price.ownerNet.amount + state.shippingNetDelta } } })) };
    },
  });
  const catalog = catalogWrap(baseCatalog);
  const shipping = shippingWrap(baseShipping);
  const quotes = options.quotes ? options.quotes(owner) : owner;
  const clock = { now: () => NOW };
  const workspaceV2 = workspaceCapabilityV2({ store, catalog, shipping, clock });
  const preview = quotePreviewCapability({ store, catalog, shipping, limits, now: () => NOW });
  const create = quoteCreateV3Capability({ store, quotes, catalog, shipping, limits, now: () => NOW });
  const taskId = options.taskId ?? randomUUID();
  const trusted = { taskId, runId: randomUUID(), agentId: 'sales', agentVersion: 5, correlationId: 'it-quote-v3', grantedScopes: ['quote.create', 'catalog.read', 'shipping.read', 'sales.workspace.write'] };
  const writeContext = (executionKey: string, attempt = 1): WriteHandlerContext => ({ executionKey, attempt, signal: new AbortController().signal, execution: { ...trusted, actor: { kind: 'service', ref: 'sales-channel-ingress' }, identityAssurance: 'provisional' } });
  const readContext = (): CapabilityHandlerContext => ({ execution: trusted, invocationId: randomUUID(), signal: new AbortController().signal });
  /** The owner's current Fixture Courier NET for an order of these items to Ñuñoa (what the customer would be offered). */
  const courierNet = async (items: { productId: string; quantity: number }[]) => {
    const basis = await resolveOrderBasis(catalog, items);
    return (await shipping.quote({ destination: { commune: 'Ñuñoa' }, basis: { type: 'order', ...basis } })).offers.find((o) => o.carrierName === 'Fixture Courier')!.price.ownerNet.amount;
  };
  return {
    store,
    owner,
    state,
    courierNet,
    limits,
    taskId,
    update: (operations: unknown[]) => workspaceV2.execute(workspaceUpdateV2InputSchema.parse({ operations }), writeContext(newKey())),
    preview: () => preview.handler({}, readContext()),
    issue: (previewId: string, executionKey = newKey(), attempt = 1) => create.execute(quoteCreateV3Input.parse({ previewId }), writeContext(executionKey, attempt)),
    reconcile: (executionKey: string) => create.reconcile!(writeContext(executionKey, 2)),
    decisions: async () => (await pool.query<{ outcome: string; reason_code: string; preview_id: string }>('select outcome, reason_code, preview_id from sales.quote_autonomous_decisions where task_id = $1 order by decided_at', [taskId])).rows,
  };
}

// The synthetic solution of J3B: Barra olímpica ×1 + Barra Z ×2 delivered to Ñuñoa, Fixture Courier NORMAL at 12 674 CLP net.
// Owner arithmetic: 129 990 incl. → 109 235 + 20 755; 79 980 incl. → 67 210 + 12 770; freight 12 674 excl. 19 % → 2 408;
// totals 189 119 / 35 933 / 225 052.
const SELECTION = [
  { op: 'add_item', productId: 'BAR-OLY20', quantity: 1 },
  { op: 'add_item', productId: 'BAR-EZ', quantity: 2 },
  { op: 'set_delivery_destination', commune: 'Ñuñoa' },
];
const CHOICE = { op: 'select_shipping_offer', carrierName: 'Fixture Courier', serviceType: 'NORMAL', ownerNetClp: 12_674 };
const WORDS = 'Sí, envíame esa cotización por favor';

/** Selection, destination and shipping choice recorded; the preview is ready; the customer's request is recorded for it. */
async function requested(w: ReturnType<typeof world>): Promise<string> {
  expect(await w.update(SELECTION)).toMatchObject({ status: 'applied' });
  expect(await w.update([CHOICE])).toMatchObject({ status: 'applied' });
  const preview = await w.preview();
  expect(preview).toMatchObject({ status: 'ready', issuable: false, quoteRequest: { recorded: false, matchesThisPreview: false } });
  expect(await w.update([{ op: 'record_quote_request', previewId: preview.previewId, customerWords: WORDS }])).toMatchObject({ status: 'applied' });
  return preview.previewId!;
}

describe('A. quote.preview: the commercial snapshot', () => {
  it('A1 resolves lines, tier prices, shipping and owner-arithmetic totals from the workspace only; deterministic id', async () => {
    const w = world();
    expect(await w.update(SELECTION)).toMatchObject({ status: 'applied' });
    expect(await w.update([CHOICE])).toMatchObject({ status: 'applied', result: { shipping: { kind: 'selected', carrierName: 'Fixture Courier', serviceType: 'NORMAL', agreedOwnerNetClp: 12_674, commune: 'Ñuñoa' } } });
    const first = await w.preview();
    expect(first).toMatchObject({
      status: 'ready',
      blockers: [],
      limitBreaches: [],
      snapshot: {
        schema: 'r4-sales-commercial-snapshot-v1',
        customer: { kind: 'guest' },
        lines: [
          { itemKey: 'BAR-OLY20', quantity: 1, unitPrice: { amount: 129_990, taxBasis: 'included', taxRate: '0.19' }, amounts: { net: 109_235, tax: 20_755, gross: 129_990 } },
          { itemKey: 'BAR-EZ', quantity: 2, unitPrice: { amount: 39_990, taxBasis: 'included', taxRate: '0.19' }, amounts: { net: 67_210, tax: 12_770, gross: 79_980 } },
        ],
        shipping: { kind: 'selected', carrierName: 'Fixture Courier', serviceType: 'NORMAL', commune: 'Ñuñoa', amount: { amount: 12_674, taxBasis: 'excluded', taxRate: '0.19' }, amounts: { net: 12_674, tax: 2_408, gross: 15_082 } },
        totals: { net: 189_119, tax: 35_933, gross: 225_052 },
      },
    });
    expect(first.previewId).toMatch(/^[0-9a-f]{64}$/);
    expect((await w.preview()).previewId).toBe(first.previewId);
    // The same content in another conversation is the same snapshot (a name of content, never of a task or a moment).
    const other = world();
    await other.update(SELECTION);
    await other.update([CHOICE]);
    expect((await other.preview()).previewId).toBe(first.previewId);
  });

  it('A2 a quantity tier: the unit price follows the Catalog price for the selected quantity; a new quantity is a new snapshot', async () => {
    const w = world();
    // Tiered owner price: from 3 units BAR-EZ costs 35 990.
    w.state.catalogPatch = (item, quantity) => (item.status === 'found' && item.parentProduct.productKey === 'BAR-EZ' && quantity >= 3 && item.pricing.status === 'available' ? { ...item, pricing: { ...item.pricing, finalGross: { ...item.pricing.finalGross, amount: 35_990 } } } : item);
    await w.update(SELECTION);
    await w.update([CHOICE]);
    const two = await w.preview();
    expect(await w.update([{ op: 'set_item_quantity', productId: 'BAR-EZ', quantity: 3 }])).toMatchObject({ status: 'applied', result: { shipping: null } });
    const blocked = await w.preview();
    // The quantity change cleared the shipping choice: the customer must choose again for the new order.
    expect(blocked).toMatchObject({ status: 'blocked', blockers: [{ code: 'shipping_not_selected' }] });
    const net = await w.courierNet([{ productId: 'BAR-OLY20', quantity: 1 }, { productId: 'BAR-EZ', quantity: 3 }]);
    expect(await w.update([{ ...CHOICE, ownerNetClp: net }])).toMatchObject({ status: 'applied' });
    const three = await w.preview();
    expect(three).toMatchObject({ status: 'ready', snapshot: { lines: [{ itemKey: 'BAR-OLY20' }, { itemKey: 'BAR-EZ', quantity: 3, unitPrice: { amount: 35_990 }, amounts: { gross: 107_970 } }] } });
    expect(three.previewId).not.toBe(two.previewId);
  });

  it('A3 variants: a product with variants never enters the selection; the chosen variant is quoted with its attributes', async () => {
    const w = world();
    expect(await w.update([{ op: 'add_item', productId: 'KB-COMP', quantity: 1 }])).toMatchObject({ status: 'rejected', code: 'variant_required' });
    await w.update([{ op: 'add_item', productId: 'KB-COMP-12', quantity: 2 }]);
    await w.update([{ op: 'exclude_shipping' }]);
    expect(await w.preview()).toMatchObject({ status: 'ready', snapshot: { lines: [{ itemKey: 'KB-COMP-12', variantRef: '1141', sku: 'FL-KBC-12', attributes: [{ name: 'Peso', value: '12 kg' }], amounts: { gross: 89_980 } }], shipping: { kind: 'excluded' }, totals: { gross: 89_980 } } });
  });

  it('A4 blockers: empty selection, delivery not decided, unsellable, insufficient stock, stale catalog answer', async () => {
    const w = world();
    expect(await w.preview()).toMatchObject({ status: 'blocked', blockers: [{ code: 'selection_empty' }, { code: 'shipping_not_decided' }] });
    await w.update([{ op: 'add_item', productId: 'RACK-PR300', quantity: 1 }]);
    await w.update([{ op: 'exclude_shipping' }]);
    expect((await w.preview()).blockers.map((b) => b.code)).toContain('item_not_sellable');
    const s = world();
    await s.update([{ op: 'add_item', productId: 'RACK-HR50', quantity: 3 }, { op: 'set_delivery_destination', commune: 'Ñuñoa' }]);
    const stock = await s.preview();
    expect(stock.status).toBe('blocked');
    expect(stock.blockers.map((b) => b.code).some((c) => c === 'insufficient_stock' || c === 'item_not_sellable')).toBe(true);
    const t = world();
    await t.update([{ op: 'add_item', productId: 'BAR-EZ', quantity: 1 }, { op: 'exclude_shipping' }]);
    t.state.catalogPatch = (item) => (item.status === 'found' ? { ...item, freshness: { ...item.freshness, validUntil: new Date(NOW.getTime() - 1_000).toISOString() } } : item);
    expect(await t.preview()).toMatchObject({ status: 'blocked', blockers: [{ code: 'catalog_evidence_stale' }] });
  });

  it('A5 limits the snapshot itself exceeds are reported and make it not issuable', async () => {
    const w = world({ limits: { maxGrossClp: 200_000, maxLines: 1, maxUnitsPerLine: 1 } });
    const previewId = await requested(w);
    const preview = await w.preview();
    expect(preview.previewId).toBe(previewId);
    expect(preview).toMatchObject({ status: 'ready', issuable: false, quoteRequest: { recorded: true, matchesThisPreview: true } });
    expect(preview.limitBreaches.map((b) => b.code).sort()).toEqual(['autonomy_limit_amount', 'autonomy_limit_lines', 'autonomy_limit_quantity']);
  });
});

describe('B. sales.workspace.update@2: the customer\'s shipping choice and quote request', () => {
  it('B1 a choice must be an offer the owner makes now, for a recorded destination, in its own update', async () => {
    const w = world();
    expect(await w.update([{ op: 'add_item', productId: 'BAR-EZ', quantity: 1 }, CHOICE])).toMatchObject({ status: 'rejected', code: 'shipping_selection_not_alone' });
    await w.update([{ op: 'add_item', productId: 'BAR-EZ', quantity: 1 }]);
    expect(await w.update([CHOICE])).toMatchObject({ status: 'rejected', code: 'no_delivery_destination' });
    await w.update([{ op: 'set_delivery_destination', commune: 'Ñuñoa' }]);
    // The model cannot silently pick another price or an offer the owner does not make.
    expect(await w.update([{ ...CHOICE, ownerNetClp: 1 }])).toMatchObject({ status: 'rejected', code: 'shipping_offer_not_offered' });
    expect(await w.update([{ ...CHOICE, carrierName: 'Courier Inventado' }])).toMatchObject({ status: 'rejected', code: 'shipping_offer_not_offered' });
    expect(await w.update([{ op: 'exclude_shipping' }])).toMatchObject({ status: 'rejected', code: 'delivery_destination_set' });
  });

  it('B2 any change of items, quantities or destination clears the choice and the quote request', async () => {
    const w = world();
    await requested(w);
    expect(await w.update([{ op: 'set_delivery_destination', commune: 'Providencia' }])).toMatchObject({ status: 'applied', result: { shipping: null, quoteRequest: null } });
    const workspace = await w.store.workspace(w.taskId);
    expect(workspace.state).toMatchObject({ shipping: null, quoteRequest: null });
    const transitions = await w.store.transitions(w.taskId);
    expect(transitions.at(-1)!.changes.map((c) => c.kind).sort()).toEqual(['delivery', 'quote_request', 'shipping']);
  });

  it('B3 version 1 states keep their exact shape (no new keys)', async () => {
    const w = world();
    await w.update([{ op: 'add_item', productId: 'BAR-EZ', quantity: 1 }]);
    expect(Object.keys((await w.store.workspace(w.taskId)).state).sort()).toEqual(['delivery', 'facts', 'items']);
  });
});

describe('C. quote.create@3: autonomous issuance', () => {
  it('C1 valid autonomous quote: recomputed snapshot, frozen guest body, owner-issued, verified PDF, decision recorded', async () => {
    const w = world();
    const previewId = await requested(w);
    const key = newKey();
    const outcome = await w.issue(previewId, key);
    expect(outcome).toMatchObject({
      status: 'applied',
      replayed: false,
      externalOperationRef: 'PC-000001',
      result: { quoteNumber: 'PC-000001', status: 'issued', totals: { net: 189_119, tax: 35_933, gross: 225_052, exemptNet: 0 }, shipping: { carrierName: 'Fixture Courier', amounts: { gross: 15_082 } }, document: { verification: 'verified' } },
    });
    const frozen = (await w.store.quoteV2Request(key))!;
    expect(frozen.request.customer).toEqual({ kind: 'guest' });
    expect(frozen.request.expectedTotals).toEqual({ net: 189_119, tax: 35_933, gross: 225_052 });
    expect(frozen.request.externalCorrelation).toEqual({ sourceSystem: 'r4-sales', externalReferenceType: 'r4-task', externalReference: w.taskId });
    const decision = (await w.store.autonomousDecision(key))!;
    expect(decision).toMatchObject({ outcome: 'authorized', reasonCode: 'eligible', previewId, quoteRequest: { previewId, customerWords: WORDS }, limits: LIMITS, measurements: { authorizedInConversation: 0, sameSnapshotAuthorizedBy: null, gross: 225_052, lines: 2, units: 3 } });
    expect(decision.snapshot).toMatchObject({ totals: { gross: 225_052 } });
    expect(w.owner.quotes).toHaveLength(1);
    expect(w.owner.createCalls).toBe(1);
    expect(await w.store.quoteV2Issued(w.taskId)).toMatchObject([{ quoteNumber: 'PC-000001', documentVerification: 'verified' }]);
  });

  it('C2 no quote request recorded → refused, nothing sent', async () => {
    const w = world();
    await w.update(SELECTION);
    await w.update([CHOICE]);
    const { previewId } = await w.preview();
    expect(await w.issue(previewId!)).toMatchObject({ status: 'rejected', code: 'quote_not_requested' });
    expect(w.owner.createCalls).toBe(0);
    expect(await w.decisions()).toEqual([{ outcome: 'rejected', reason_code: 'quote_not_requested', preview_id: previewId }]);
  });

  it('C3 manipulation: another preview, a fabricated id, or extra commercial arguments are refused', async () => {
    const w = world();
    const previewId = await requested(w);
    const fabricated = 'f'.repeat(64);
    expect(await w.issue(fabricated)).toMatchObject({ status: 'rejected', code: 'quote_request_other_preview' });
    // The agent records a request for an id the snapshot does not have (made up, or an old one): the recomputation refuses it.
    await w.update([{ op: 'record_quote_request', previewId: fabricated, customerWords: WORDS }]);
    expect(await w.issue(fabricated)).toMatchObject({ status: 'rejected', code: 'preview_stale', details: { currentPreviewId: previewId } });
    for (const extra of [{ unitPrice: 1 }, { expectedTotals: { net: 1, tax: 0, gross: 1 } }, { discount: 10 }, { customer: { kind: 'person', displayName: 'Inventado' } }, { lines: [] }, { shipping: null }]) {
      expect(quoteCreateV3Input.safeParse({ previewId, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(w.owner.createCalls).toBe(0);
  });

  it('C4 the owners changed after the preview (price, shipping offer, stock): refused as stale or blocked; nothing issued', async () => {
    const price = world();
    const p1 = await requested(price);
    price.state.catalogPatch = (item) => (item.status === 'found' && item.parentProduct.productKey === 'BAR-EZ' && item.pricing.status === 'available' ? { ...item, pricing: { ...item.pricing, finalGross: { ...item.pricing.finalGross, amount: 41_990 } } } : item);
    expect(await price.issue(p1)).toMatchObject({ status: 'rejected', code: 'preview_stale' });
    const freight = world();
    const p2 = await requested(freight);
    freight.state.shippingNetDelta = 500;
    expect(await freight.issue(p2)).toMatchObject({ status: 'rejected', code: 'shipping_offer_changed', details: { agreedOwnerNet: 12_674, currentOwnerNet: 13_174 } });
    const stock = world();
    const p3 = await requested(stock);
    stock.state.catalogPatch = (item) => (item.status === 'found' && item.parentProduct.productKey === 'BAR-EZ' ? { ...item, availability: { ...item.availability, availableQuantity: 1 } } : item);
    expect(await stock.issue(p3)).toMatchObject({ status: 'rejected', code: 'insufficient_stock' });
    for (const w of [price, freight, stock]) expect(w.owner.createCalls).toBe(0);
  });

  it('C5 duplicates: the same snapshot is issued once per conversation, also under concurrency; the same key replays', async () => {
    const w = world();
    const previewId = await requested(w);
    const key = newKey();
    expect(await w.issue(previewId, key)).toMatchObject({ status: 'applied', replayed: false });
    // Same command again (platform retry with the same key): the owner replays the same quote.
    expect(await w.issue(previewId, key, 2)).toMatchObject({ status: 'applied', replayed: true, result: { quoteNumber: 'PC-000001' } });
    // A new proposal for the same snapshot: refused before anything is sent.
    expect(await w.issue(previewId)).toMatchObject({ status: 'rejected', code: 'duplicate_quote' });
    expect(w.owner.quotes).toHaveLength(1);

    const race = world();
    const racePreview = await requested(race);
    const outcomes = await Promise.all([race.issue(racePreview), race.issue(racePreview), race.issue(racePreview)]);
    expect(outcomes.filter((o) => o.status === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected' && o.code === 'duplicate_quote')).toHaveLength(2);
    expect(race.owner.quotes).toHaveLength(1);
    expect((await race.decisions()).filter((d) => d.outcome === 'authorized')).toHaveLength(1);
  });

  it('C6 limits: amount, lines and quantity refuse before any decision; conversation and hourly limits under the lock', async () => {
    const amount = world({ limits: { maxGrossClp: 225_051 } });
    expect(await amount.issue(await requested(amount))).toMatchObject({ status: 'rejected', code: 'autonomy_limit_amount' });
    const lines = world({ limits: { maxLines: 1 } });
    expect(await lines.issue(await requested(lines))).toMatchObject({ status: 'rejected', code: 'autonomy_limit_lines' });
    const units = world({ limits: { maxUnitsPerLine: 1 } });
    expect(await units.issue(await requested(units))).toMatchObject({ status: 'rejected', code: 'autonomy_limit_quantity' });

    const conversation = world({ limits: { maxQuotesPerConversation: 1 } });
    expect(await conversation.issue(await requested(conversation))).toMatchObject({ status: 'applied' });
    await conversation.update([{ op: 'set_item_quantity', productId: 'BAR-EZ', quantity: 1 }]);
    await conversation.update([{ ...CHOICE, ownerNetClp: await conversation.courierNet([{ productId: 'BAR-OLY20', quantity: 1 }, { productId: 'BAR-EZ', quantity: 1 }]) }]);
    const second = await conversation.preview();
    expect(second.status).toBe('ready');
    await conversation.update([{ op: 'record_quote_request', previewId: second.previewId, customerWords: 'Y esta otra también' }]);
    expect(await conversation.issue(second.previewId!)).toMatchObject({ status: 'rejected', code: 'autonomy_limit_conversation' });
    expect(conversation.owner.quotes).toHaveLength(1);

    // The hourly limit spans conversations: count what this database authorized during the last hour, plus one.
    const authorizedLastHour = Number((await pool.query<{ n: string }>("select count(*) as n from sales.quote_autonomous_decisions where outcome = 'authorized' and decided_at > clock_timestamp() - interval '1 hour'")).rows[0]!.n);
    const owner = new FixtureQuoteV2Service({ now: () => NOW });
    const a = world({ owner, limits: { maxQuotesPerHour: authorizedLastHour + 1 } });
    const b = world({ owner, limits: { maxQuotesPerHour: authorizedLastHour + 1 } });
    const pa = await requested(a);
    const pb = await requested(b);
    expect(await a.issue(pa)).toMatchObject({ status: 'applied' });
    expect(await b.issue(pb)).toMatchObject({ status: 'rejected', code: 'autonomy_limit_rate' });
    expect(owner.quotes).toHaveLength(1);
  });

  it('C7 lost answer and 202: unknown, then reconciled by key to the single issued quote; never a second POST body', async () => {
    const lost = world();
    const p1 = await requested(lost);
    lost.owner.faults.afterCommit = () => 'timeout';
    const k1 = newKey();
    expect(await lost.issue(p1, k1)).toMatchObject({ status: 'unknown' });
    lost.owner.faults.afterCommit = () => 'answer';
    expect(await lost.reconcile(k1)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001' } });
    expect(lost.owner.quotes).toHaveLength(1);

    const async = world();
    const p2 = await requested(async);
    async.owner.faults.issuance = () => 'async';
    const k2 = newKey();
    expect(await async.issue(p2, k2)).toMatchObject({ status: 'unknown', message: expect.stringMatching(/issuing/) });
    expect(await async.reconcile(k2)).toMatchObject({ status: 'unknown' });
    async.owner.completeIssuance(async.owner.quotes[0]!.quoteId, 'succeed');
    expect(await async.reconcile(k2)).toMatchObject({ status: 'applied', result: { status: 'issued', document: { verification: 'verified' } } });
    // Retries send exactly the frozen body: the owner bound one fingerprint and created one quote.
    expect(async.owner.quotes).toHaveLength(1);
  });

  it('C8 owner refusal (422), invalid PDF, Quote outage and Catalog outage', async () => {
    const refused = world({ quotes: (base) => ({ ...bind(base), createAndIssue: () => Promise.reject(new DomainError('validation', 'arithmetic_mismatch', 'expectedTotals differ')) }) });
    expect(await refused.issue(await requested(refused))).toMatchObject({ status: 'rejected', code: 'quote_arithmetic_mismatch' });
    expect(refused.owner.quotes).toHaveLength(0);

    const corrupt = world();
    corrupt.owner.faults.document = () => 'corrupt';
    // The quote IS issued (owner authority); R4 never reports its document as verified.
    expect(await corrupt.issue(await requested(corrupt))).toMatchObject({ status: 'applied', result: { document: { verification: 'mismatch' } } });
    expect(await corrupt.store.quoteV2Issued(corrupt.taskId)).toMatchObject([{ documentVerification: 'mismatch' }]);

    const down = world();
    const p = await requested(down);
    down.owner.availability.set({ mode: 'down' });
    const key = newKey();
    expect(await down.issue(p, key)).toMatchObject({ status: 'failed', code: 'quote_service_unavailable', details: { retryable: true } });
    expect(down.owner.quotes).toHaveLength(0);
    down.owner.availability.set({ mode: 'up' });
    expect(await down.issue(p, key, 2)).toMatchObject({ status: 'applied' });
    expect(down.owner.quotes).toHaveLength(1);

    const catalogDown = world();
    const pc = await requested(catalogDown);
    catalogDown.state.catalogDown = true;
    const ck = newKey();
    expect(await catalogDown.issue(pc, ck)).toMatchObject({ status: 'failed', code: 'quote_evidence_unavailable', details: { retryable: true } });
    // Nothing was decided: the platform may retry the same command once the owner answers.
    expect(await catalogDown.store.autonomousDecision(ck)).toBeNull();
    catalogDown.state.catalogDown = false;
    expect(await catalogDown.issue(pc, ck, 2)).toMatchObject({ status: 'applied' });
  });

  it('C10 two conversations with identical commercial content: same previewId, two independent quotes (no cross-conversation collision)', async () => {
    const owner = new FixtureQuoteV2Service({ now: () => NOW });
    const a = world({ owner });
    const b = world({ owner });
    const pa = await requested(a);
    const pb = await requested(b);
    // Content identity is shared on purpose; conversation identity is not part of it.
    expect(pb).toBe(pa);
    const ka = newKey();
    const kb = newKey();
    expect(await a.issue(pa, ka)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001' } });
    expect(await b.issue(pb, kb)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000002' } });
    expect(owner.quotes).toHaveLength(2);
    // Each quote is correlated to its own conversation and bound to its own Idempotency-Key.
    expect(owner.quotes.map((q) => q.externalCorrelation.externalReference).sort()).toEqual([a.taskId, b.taskId].sort());
    expect((await a.store.quoteV2Request(ka))!.request.externalCorrelation.externalReference).toBe(a.taskId);
    expect((await b.store.quoteV2Request(kb))!.request.externalCorrelation.externalReference).toBe(b.taskId);
    // The unique index is per (conversation, snapshot): both authorizations coexist.
    const rows = (await pool.query<{ task_id: string }>("select task_id from sales.quote_autonomous_decisions where preview_id = $1 and outcome = 'authorized' and task_id = any($2::uuid[])", [pa, [a.taskId, b.taskId]])).rows;
    expect(rows.map((r) => r.task_id).sort()).toEqual([a.taskId, b.taskId].sort());
  });

  it('C11 repeated requests in one conversation: a second request for the issued snapshot never issues again', async () => {
    const w = world();
    const previewId = await requested(w);
    expect(await w.issue(previewId)).toMatchObject({ status: 'applied' });
    // The customer "asks again" (the agent records the request a second time, other words) and a new proposal follows.
    expect(await w.update([{ op: 'record_quote_request', previewId, customerWords: 'Mándamela de nuevo' }])).toMatchObject({ status: 'applied' });
    expect(await w.issue(previewId)).toMatchObject({ status: 'rejected', code: 'duplicate_quote' });
    expect(await w.issue(previewId)).toMatchObject({ status: 'rejected', code: 'duplicate_quote' });
    expect(w.owner.quotes).toHaveLength(1);
    expect((await w.decisions()).map((d) => `${d.outcome}:${d.reason_code}`)).toEqual(['authorized:eligible', 'rejected:duplicate_quote', 'rejected:duplicate_quote']);
  });

  it('C12 request identity: a request belongs to one workspace history; reverting to identical content needs a new request', async () => {
    const w = world();
    const previewId = await requested(w);
    await w.update([{ op: 'set_item_quantity', productId: 'BAR-EZ', quantity: 1 }]);
    await w.update([{ op: 'set_item_quantity', productId: 'BAR-EZ', quantity: 2 }]);
    await w.update([CHOICE]);
    // Same content again → same previewId, but the earlier request was cleared by the changes.
    expect((await w.preview()).previewId).toBe(previewId);
    expect(await w.issue(previewId)).toMatchObject({ status: 'rejected', code: 'quote_not_requested' });
    expect(w.owner.createCalls).toBe(0);
  });

  it('C9 the decision ledger is append-only', async () => {
    const w = world();
    await w.issue(await requested(w));
    await expect(pool.query('update sales.quote_autonomous_decisions set reason_code = $1 where task_id = $2', ['eligible', w.taskId])).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from sales.quote_autonomous_decisions where task_id = $1', [w.taskId])).rejects.toThrow(/append-only/);
  });
});

/** The fixture owner's methods bound to it (to override one of them). */
function bind(base: FixtureQuoteV2Service): QuoteV2Service {
  return {
    createAndIssue: (...a) => base.createAndIssue(...a),
    getQuote: (...a) => base.getQuote(...a),
    getOperation: (...a) => base.getOperation(...a),
    lookupIdempotency: (...a) => base.lookupIdempotency(...a),
    getDocument: (...a) => base.getDocument(...a),
  };
}
