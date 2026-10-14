import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogItemContext, type CatalogPort, type ShippingService } from '@r4-adapters/domains';
import type { CapabilityHandlerContext, WriteHandlerContext } from '@r4/capability-runtime';
import {
  PostgresSalesStore,
  migrateSales,
  quoteCreateV3Input,
  quoteCreateV4Capability,
  quotePreviewV2Capability,
  resolveOrderBasis,
  workspaceCapabilityV2,
  workspaceUpdateV2InputSchema,
  type AutonomousQuoteLimitsV6,
  type ConversationThreadEntry,
  type QuotePreviewV2Output,
} from '@r4-sales/agent';
import type { Pool } from '@r4/persistence-postgres';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * R4-J3E-B offline matrix of quote.create@4: the customer's confirmation is read
 * from the conversation the platform recorded (a controllable stand-in of
 * ProductionStore.thread here; the real port in sales-confirmed-intent-canary),
 * never from capability arguments. Real PostgreSQL `sales` schema (0006–0009),
 * fixture owners. Every case asserts what the Quote owner actually committed.
 */
let db: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  expect((await migrateSales(pool)).applied).toEqual(['0006_sales_reference_application', '0007_sales_quote_v2_issuance', '0008_sales_autonomous_quote_decisions', '0009_sales_quote_intent_evidence']);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const NOW = new Date('2026-10-14T15:00:00Z');
const newKey = () => `r4x_${randomBytes(16).toString('hex')}`;
const LIMITS: AutonomousQuoteLimitsV6 = { maxGrossClp: 500_000, maxLines: 3, maxUnitsPerLine: 5, maxTotalUnits: 5, maxQuotesPerConversation: 3, maxQuotesPerHour: 1_000, confirmationWindowSeconds: 900 };

/** The conversation as the platform would record it: inputs (`contact`) and delivered responses (`agent`). */
class Thread {
  readonly entries: ConversationThreadEntry[] = [];
  #clock = Date.parse('2026-10-14T14:00:00Z');

  /** Advances the conversation clock (seconds) and returns the instant. */
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

  customer(text: string, options: { after?: number; inputId?: string } = {}): string {
    const at = this.tick(options.after ?? 10);
    const inputId = options.inputId ?? randomUUID();
    this.entries.push({ cursor: `${at}|${inputId}`, at, kind: 'contact', text, refs: { inputId }, delivery: null });
    return inputId;
  }

  readonly reader = { thread: () => Promise.resolve([...this.entries]) };
}

function world(options: { limits?: Partial<AutonomousQuoteLimitsV6>; owner?: FixtureQuoteV2Service; taskId?: string } = {}) {
  const store = new PostgresSalesStore(pool);
  const baseCatalog = new FixtureCatalog({ now: () => NOW });
  const baseShipping = new FixtureShipping({ now: () => NOW });
  const owner = options.owner ?? new FixtureQuoteV2Service({ now: () => NOW });
  const limits = { ...LIMITS, ...options.limits };
  const state = { catalogPatch: null as null | ((item: CatalogItemContext) => CatalogItemContext) };
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
  const workspaceV2 = workspaceCapabilityV2({ store, catalog, shipping, clock });
  const preview = quotePreviewV2Capability({ store, catalog, shipping, limits, now: () => NOW });
  const create = () => quoteCreateV4Capability({ store, quotes: owner, catalog, shipping, limits, conversation: thread.reader, now: () => NOW });
  let capability = create();
  const taskId = options.taskId ?? randomUUID();
  const trusted = { taskId, runId: randomUUID(), agentId: 'sales', agentVersion: 6, correlationId: 'it-quote-v4', grantedScopes: ['quote.create', 'catalog.read', 'shipping.read', 'sales.workspace.write'] };
  const writeContext = (executionKey: string, attempt = 1): WriteHandlerContext => ({ executionKey, attempt, signal: new AbortController().signal, execution: { ...trusted, actor: { kind: 'service', ref: 'sales-channel-ingress' }, identityAssurance: 'provisional' } });
  const readContext = (): CapabilityHandlerContext => ({ execution: trusted, invocationId: randomUUID(), signal: new AbortController().signal });
  const courierNet = async (items: { productId: string; quantity: number }[]) => {
    const basis = await resolveOrderBasis(catalog, items);
    return (await shipping.quote({ destination: { commune: 'Ñuñoa' }, basis: { type: 'order', ...basis } })).offers.find((o) => o.carrierName === 'Fixture Courier')!.price.ownerNet.amount;
  };
  return {
    store, owner, state, thread, taskId, courierNet,
    update: (operations: unknown[]) => workspaceV2.execute(workspaceUpdateV2InputSchema.parse({ operations }), writeContext(newKey())),
    preview: () => preview.handler({}, readContext()),
    issue: (previewId: string, executionKey = newKey(), attempt = 1) => capability.execute(quoteCreateV3Input.parse({ previewId }), writeContext(executionKey, attempt)),
    reconcile: (executionKey: string) => capability.reconcile!(writeContext(executionKey, 2)),
    /** A worker restart: a new capability instance (no in-memory state) over the same durable records. */
    restart: () => {
      capability = create();
    },
    decisions: async () => (await pool.query<{ outcome: string; reason_code: string }>('select outcome, reason_code from sales.quote_autonomous_decisions where task_id = $1 order by decided_at', [taskId])).rows.map((r) => `${r.outcome}:${r.reason_code}`),
  };
}

const SELECTION = [
  { op: 'add_item', productId: 'BAR-OLY20', quantity: 1 },
  { op: 'add_item', productId: 'BAR-EZ', quantity: 2 },
  { op: 'set_delivery_destination', commune: 'Ñuñoa' },
];
const CHOICE = { op: 'select_shipping_offer', carrierName: 'Fixture Courier', serviceType: 'NORMAL', ownerNetClp: 12_674 };
/** The agent's offer message, as the v6 instructions ask: lines, totals, totalText and reference. */
const offerText = (p: QuotePreviewV2Output) => `Tu cotización: Barra olímpica ×1 y Barra Z ×2, despacho a Ñuñoa. ${p.presentation!.totalText} · Ref. ${p.presentation!.reference}. ¿Emito la cotización?`;

/** Selection, shipping choice and a ready preview, presented to the customer in a delivered offer message. */
async function offered(w: ReturnType<typeof world>): Promise<QuotePreviewV2Output> {
  expect(await w.update(SELECTION)).toMatchObject({ status: 'applied' });
  expect(await w.update([CHOICE])).toMatchObject({ status: 'applied' });
  const p = await w.preview();
  expect(p).toMatchObject({ status: 'ready', issuable: true, presentation: { reference: expect.stringMatching(/^Q-[0-9A-F]{6}-\d+$/), grossClp: 225_052, totalText: 'Total: $225.052 (IVA incluido)' } });
  w.thread.customer('Quiero cotizar una barra olímpica y dos barras Z con despacho a Ñuñoa', { after: 1 });
  w.thread.agent(offerText(p));
  return p;
}

describe('A. a natural, explicit confirmation read from the conversation', () => {
  it('A1 "Sí, emítela." after the delivered offer issues once; the evidence holds ids, times and hashes, not the text', async () => {
    const w = world();
    const p = await offered(w);
    const inputId = w.thread.customer('Sí, emítela.');
    const key = newKey();
    expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001', totals: { gross: 225_052 }, document: { verification: 'verified' } } });
    expect(w.owner.quotes).toHaveLength(1);
    const evidence = (await w.store.intentEvidence(key))!;
    expect(evidence).toMatchObject({ previewId: p.previewId, commercialVersion: p.presentation!.commercialVersion, presentedReference: p.presentation!.reference, presentedGross: 225_052, offerDeliveryStatus: 'accepted', confirmationInputId: inputId, grammarVersion: 'r4-sales-confirmation-es-v1', grammarRule: 'affirmation=si;courtesy=none' });
    expect(evidence.confirmationTextSha256).toMatch(/^[0-9a-f]{64}$/);
    // No customer text is duplicated into Sales: neither the evidence nor the decision carries it.
    const rows = JSON.stringify((await pool.query('select e.*, d.quote_request from sales.quote_intent_evidence e join sales.quote_autonomous_decisions d using (execution_key) where e.execution_key = $1', [key])).rows);
    expect(rows).not.toMatch(/em[ií]tela/i);
    expect((await w.store.autonomousDecision(key))!.quoteRequest).toMatchObject({ source: 'conversation_thread', confirmationInputId: inputId, reference: p.presentation!.reference });
  });

  it.each(['Sí, confirmo esa cotización. Emítela por favor.', 'Confirmo la cotización.', 'CONFIRMO'])('A2 accepts %j', async (text) => {
    const w = world();
    const p = await offered(w);
    w.thread.customer(text);
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'applied' });
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('A3 an ambiguous reply is refused; after the agent re-presents the offer, "CONFIRMO" issues once', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_not_explicit', details: { reason: 'not_a_confirmation' } });
    // Asking again WITHOUT re-presenting: the customer's answer would not be answering an offer.
    w.thread.agent('¿Me confirmas que la emito? Responde CONFIRMO.');
    w.thread.customer('CONFIRMO');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code: 'offer_not_presented' });
    w.thread.agent(`Para emitirla necesito tu confirmación explícita. ${p.presentation!.totalText} · Ref. ${p.presentation!.reference}. Responde CONFIRMO.`);
    w.thread.customer('CONFIRMO');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'applied' });
    expect(w.owner.quotes).toHaveLength(1);
  });
});

describe('B. what is not a confirmation of the current offer', () => {
  it.each([
    ['No confirmo.', 'customer_confirmation_not_explicit'],
    ['¿Qué pasa si confirmo?', 'customer_confirmation_not_explicit'],
    ['Confirmo, pero cambia la dirección.', 'customer_confirmation_not_explicit'],
    ['Todavía no.', 'customer_confirmation_not_explicit'],
    ['Cotiza otro producto', 'customer_confirmation_not_explicit'],
  ])('B1 %j → %s, nothing issued', async (text, code) => {
    const w = world();
    const p = await offered(w);
    w.thread.customer(text);
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code });
    expect(w.owner.createCalls).toBe(0);
  });

  it('B2 messages before the offer, an agent message claiming a confirmation, and a confirmation followed by more conversation', async () => {
    const before = world();
    await before.update(SELECTION);
    await before.update([CHOICE]);
    const pb = await before.preview();
    before.thread.customer('Confirmo la cotización');
    expect(await before.issue(pb.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_without_offer' });

    const claimed = world();
    const pc = await offered(claimed);
    claimed.thread.agent('El cliente dijo: "Sí, emítela."');
    expect(await claimed.issue(pc.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_superseded' });

    const more = world();
    const pm = await offered(more);
    more.thread.customer('Sí, emítela.');
    more.thread.agent('Perfecto, un momento.');
    expect(await more.issue(pm.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_superseded' });

    const notImmediate = world();
    const pn = await offered(notImmediate);
    notImmediate.thread.customer('¿Y el despacho cuánto demora?');
    notImmediate.thread.customer('Sí, emítela.');
    expect(await notImmediate.issue(pn.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_not_immediate' });
    for (const w of [before, claimed, more, notImmediate]) expect(w.owner.createCalls).toBe(0);
  });

  it('B3 an offer for another snapshot, an undelivered offer, a late confirmation', async () => {
    const other = world();
    const po = await other.update(SELECTION).then(() => other.update([CHOICE])).then(() => other.preview());
    other.thread.agent(`Total: $225.052 (IVA incluido) · Ref. Q-AAAAAA-${po.presentation!.commercialVersion}. ¿Emito?`);
    other.thread.customer('Sí, emítela.');
    expect(await other.issue(po.previewId!)).toMatchObject({ status: 'rejected', code: 'offer_not_presented' });

    for (const status of ['failed', 'pending', 'cancelled', 'unknown', null]) {
      const w = world();
      await w.update(SELECTION);
      await w.update([CHOICE]);
      const p = await w.preview();
      w.thread.agent(offerText(p), { status });
      w.thread.customer('Sí, emítela.');
      expect(await w.issue(p.previewId!), String(status)).toMatchObject({ status: 'rejected', code: 'offer_not_delivered' });
    }

    const late = world({ limits: { confirmationWindowSeconds: 600 } });
    const pl = await offered(late);
    late.thread.customer('Sí, emítela.', { after: 601 });
    expect(await late.issue(pl.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_expired', details: { windowSeconds: 600 } });
  });
});

describe('C. commercial changes between the offer and the issuance', () => {
  it('C1 products: a change voids the offer; reverting to identical content still needs a new offer (commercial version)', async () => {
    const w = world();
    const p = await offered(w);
    await w.update([{ op: 'set_item_quantity', productId: 'BAR-EZ', quantity: 1 }]);
    w.thread.customer('Sí, emítela.');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code: 'shipping_not_selected' });
    // Back to the same items and the same shipping choice: same content and previewId, but a newer commercial version.
    await w.update([{ op: 'set_item_quantity', productId: 'BAR-EZ', quantity: 2 }]);
    await w.update([CHOICE]);
    const again = await w.preview();
    expect(again.previewId).toBe(p.previewId);
    expect(again.presentation!.commercialVersion).toBeGreaterThan(p.presentation!.commercialVersion);
    w.thread.customer('Confirmo la cotización');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_not_immediate' });
    w.thread.agent(offerText(again));
    w.thread.customer('Confirmo la cotización');
    expect(await w.issue(again.previewId!)).toMatchObject({ status: 'applied' });
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('C2 shipping: another offer chosen after the offer → the old preview is stale', async () => {
    const w = world();
    const p = await offered(w);
    const other = (await new FixtureShipping({ now: () => NOW }).quote({ destination: { commune: 'Ñuñoa' }, basis: { type: 'order', ...(await resolveOrderBasis(new FixtureCatalog({ now: () => NOW }), [{ productId: 'BAR-OLY20', quantity: 1 }, { productId: 'BAR-EZ', quantity: 2 }])) } })).offers.find((o) => o.carrierName !== 'Fixture Courier');
    if (other) {
      await w.update([{ op: 'select_shipping_offer', carrierName: other.carrierName, serviceType: other.serviceType, ownerNetClp: other.price.ownerNet.amount }]);
      w.thread.customer('Sí, emítela.');
      expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code: 'preview_stale' });
    } else {
      await w.update([{ op: 'clear_delivery_destination' }]);
      await w.update([{ op: 'exclude_shipping' }]);
      w.thread.customer('Sí, emítela.');
      expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code: 'preview_stale' });
    }
    expect(w.owner.createCalls).toBe(0);
  });

  it('C3 price and stock changed by the owner after the offer', async () => {
    const price = world();
    const pp = await offered(price);
    price.thread.customer('Sí, emítela.');
    price.state.catalogPatch = (item) => (item.status === 'found' && item.parentProduct.productKey === 'BAR-EZ' && item.pricing.status === 'available' ? { ...item, pricing: { ...item.pricing, finalGross: { ...item.pricing.finalGross, amount: 41_990 } } } : item);
    expect(await price.issue(pp.previewId!)).toMatchObject({ status: 'rejected', code: 'preview_stale' });
    const stock = world();
    const ps = await offered(stock);
    stock.thread.customer('Sí, emítela.');
    stock.state.catalogPatch = (item) => (item.status === 'found' && item.parentProduct.productKey === 'BAR-EZ' ? { ...item, availability: { ...item.availability, availableQuantity: 1 } } : item);
    expect(await stock.issue(ps.previewId!)).toMatchObject({ status: 'rejected', code: 'insufficient_stock' });
    expect(price.owner.createCalls + stock.owner.createCalls).toBe(0);
  });
});

describe('D. single use, concurrency, restart, unknown', () => {
  it('D1 a confirmation authorizes once: a new command reusing it (or a replayed inbound) is refused', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'applied' });
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_used' });
    expect(w.owner.quotes).toHaveLength(1);
    expect(await w.decisions()).toEqual(['authorized:eligible', 'rejected:customer_confirmation_used']);
  });

  it('D2 an old confirmation never answers a newer offer', async () => {
    const w = world({ limits: { maxQuotesPerConversation: 2 } });
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'applied' });
    // A new order and a new offer; the customer has not answered it.
    await w.update([{ op: 'set_item_quantity', productId: 'BAR-EZ', quantity: 1 }]);
    await w.update([{ ...CHOICE, ownerNetClp: await w.courierNet([{ productId: 'BAR-OLY20', quantity: 1 }, { productId: 'BAR-EZ', quantity: 1 }]) }]);
    const second = await w.preview();
    w.thread.agent(offerText(second));
    // The latest customer message is the old confirmation; the newer offer came after it.
    expect(await w.issue(second.previewId!)).toMatchObject({ status: 'rejected', code: 'customer_confirmation_superseded' });
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('D3 two conversations confirm the same content concurrently: two quotes; three simultaneous commands in one: one quote', async () => {
    const owner = new FixtureQuoteV2Service({ now: () => NOW });
    const a = world({ owner });
    const b = world({ owner });
    const [pa, pb] = await Promise.all([offered(a), offered(b)]);
    a.thread.customer('Sí, emítela.');
    b.thread.customer('Confirmo la cotización');
    const [ra, rb] = await Promise.all([a.issue(pa.previewId!), b.issue(pb.previewId!)]);
    expect([ra.status, rb.status]).toEqual(['applied', 'applied']);
    expect(owner.quotes).toHaveLength(2);

    const c = world();
    const pc = await offered(c);
    c.thread.customer('Sí, emítela.');
    const outcomes = await Promise.all([c.issue(pc.previewId!), c.issue(pc.previewId!), c.issue(pc.previewId!)]);
    expect(outcomes.filter((o) => o.status === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected').map((o) => (o as { code: string }).code).sort()).toEqual(['customer_confirmation_used', 'customer_confirmation_used']);
    expect(c.owner.quotes).toHaveLength(1);
  });

  it('D4 a restart between the confirmation and the issuance changes nothing; a lost answer is reconciled by the same key', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    w.restart();
    w.owner.faults.afterCommit = () => 'timeout';
    const key = newKey();
    expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'unknown' });
    w.restart();
    w.owner.faults.afterCommit = () => 'answer';
    expect(await w.reconcile(key)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001' } });
    // The platform retry of the same command replays; nothing is decided again.
    expect(await w.issue(p.previewId!, key, 2)).toMatchObject({ status: 'applied', replayed: true });
    expect(w.owner.quotes).toHaveLength(1);
    expect(await w.decisions()).toEqual(['authorized:eligible']);
  });
});

describe('E. limits', () => {
  it('E1 total units across several lines are capped independently of the per-line limit', async () => {
    const w = world({ limits: { maxUnitsPerLine: 5, maxTotalUnits: 4 } });
    await w.update([{ op: 'add_item', productId: 'BAR-EZ', quantity: 3 }, { op: 'add_item', productId: 'COLLARS', quantity: 2 }, { op: 'exclude_shipping' }]);
    const p = await w.preview();
    expect(p).toMatchObject({ status: 'ready', issuable: false });
    expect(p.limitBreaches.map((b) => b.code)).toEqual(['autonomy_limit_total_units']);
    w.thread.agent(`${p.presentation!.totalText} · Ref. ${p.presentation!.reference}`);
    w.thread.customer('Sí, emítela.');
    expect(await w.issue(p.previewId!)).toMatchObject({ status: 'rejected', code: 'autonomy_limit_total_units', details: { units: 5, limit: 4 } });

    const ok = world({ limits: { maxUnitsPerLine: 5, maxTotalUnits: 5 } });
    await ok.update([{ op: 'add_item', productId: 'BAR-EZ', quantity: 3 }, { op: 'add_item', productId: 'COLLARS', quantity: 2 }, { op: 'exclude_shipping' }]);
    const po = await ok.preview();
    expect(po).toMatchObject({ status: 'ready', issuable: true, limitBreaches: [] });
    ok.thread.agent(`${po.presentation!.totalText} · Ref. ${po.presentation!.reference}`);
    ok.thread.customer('Confirmo');
    expect(await ok.issue(po.previewId!)).toMatchObject({ status: 'applied' });
  });

  it('E2 a Catalog outage during the decision decides nothing and stays retryable', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    w.state.catalogPatch = () => {
      throw new DomainError('temporarily_unavailable', 'catalog_unavailable', 'catalog down');
    };
    const key = newKey();
    expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'failed', code: 'quote_evidence_unavailable' });
    expect(await w.store.autonomousDecision(key)).toBeNull();
    w.state.catalogPatch = null;
    expect(await w.issue(p.previewId!, key, 2)).toMatchObject({ status: 'applied' });
  });

  it('E3 the evidence ledger is append-only', async () => {
    const w = world();
    const p = await offered(w);
    w.thread.customer('Sí, emítela.');
    await w.issue(p.previewId!);
    await expect(pool.query('update sales.quote_intent_evidence set grammar_rule = $1 where task_id = $2', ['x', w.taskId])).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from sales.quote_intent_evidence where task_id = $1', [w.taskId])).rejects.toThrow(/append-only/);
  });
});
