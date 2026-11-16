import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogItemContext, type CatalogPort, type QuoteV2Service } from '@r4-adapters/domains';
import type { CapabilityHandlerContext, WriteHandlerContext } from '@r4/capability-runtime';
import { AutonomyControls } from '@r4/live-ops';
import { createSilentLogger } from '@r4/observability';
import { PostgresProductionStore, type Pool } from '@r4/persistence-postgres';
import {
  F1_COMMERCIAL_POLICY_V2_VERSION,
  F1_COMMERCIAL_POLICY_V3_VERSION,
  PROMOTIONAL_QUOTE_NO_LONGER_VALID,
  PostgresSalesStore,
  migrateSales,
  quoteCreateV3Input,
  quoteCreateV5Capability,
  quotePreviewV3Capability,
  workspaceCapabilityV2,
  workspaceUpdateV2InputSchema,
  type AutonomousQuoteLimitsV6,
  type CommercialEligibility,
  type ConversationThreadEntry,
  type QuotePreviewV3Output,
} from '@r4-sales/agent';
import { killSwitchGuardedQuotes } from '@r4-sales/agent/production';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';

/**
 * F1-COMMERCIAL-POLICY-v3 hardening (owner order «promotional quotes hardening and @19 canary validation»): a
 * promotional price is validated against Catalog IMMEDIATELY before every send of the authorized, frozen body — after
 * a kill-switch hold, an unavailable owner, a restart and its reconciliation — and the validation is persisted with
 * the decision and with each send attempt. Real PostgreSQL (`sales` 0006–0011), the real durable kill switch, fixture
 * owners, a clock the test moves, quote.create@5 at handler level (the platform lifecycle is the deterministic-offer one).
 */
let db: TestDatabase;
let pool: Pool;
let controls: AutonomyControls;
const logger = createSilentLogger();
const setAutonomy = (enabled: boolean) => controls.set({ scope: 'global', autonomyEnabled: enabled, reason: enabled ? 'test: autonomy on' : 'test: kill switch', changedBy: 'it-promotional-quote', correlationId: randomUUID() });

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  pool = openPool(db.url);
  expect((await migrateSales(pool)).applied).toContain('0011_sales_quote_send_validation');
  controls = new AutonomyControls({ store: new PostgresProductionStore(pool), logger });
  await setAutonomy(true);
});
afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const T0 = Date.parse('2026-11-13T15:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const newKey = () => `r4x_${randomBytes(16).toString('hex')}`;
const LIMITS: AutonomousQuoteLimitsV6 = { maxGrossClp: 500_000, maxLines: 3, maxUnitsPerLine: 5, maxTotalUnits: 5, maxQuotesPerConversation: 3, maxQuotesPerHour: 1_000, confirmationWindowSeconds: 900 };
const V3: CommercialEligibility = { policyVersion: F1_COMMERCIAL_POLICY_V3_VERSION, shippingAllowed: true, promotionsAllowed: true };
const V2: CommercialEligibility = { policyVersion: F1_COMMERCIAL_POLICY_V2_VERSION, shippingAllowed: true };

interface Promo {
  /** The promotion's end (Catalog's promotion.validUntil); null = open-ended; undefined = no promotion (regular price). */
  endsAt?: string | null;
  /** The final unit price Catalog answers (default: 10 % off the fixture's regular price). */
  finalGross?: number;
  available?: number;
}

function world(options: { eligibility?: CommercialEligibility } = {}) {
  const clock = { now: T0 };
  const now = () => new Date(clock.now);
  const store = new PostgresSalesStore(pool);
  const baseCatalog = new FixtureCatalog({ now });
  const owner = new FixtureQuoteV2Service({ now });
  const promo: { current: Promo } = { current: { endsAt: at(180) } };
  /** Runs once, the next time Catalog is read (to engage the kill switch in the middle of a decision). */
  const hook: { once: (() => Promise<unknown>) | null } = { once: null };
  const catalog: CatalogPort = {
    search: (...a) => baseCatalog.search(...a),
    getProductContext: (...a) => baseCatalog.getProductContext(...a),
    getItemContext: async (request, callOptions) => {
      const run = hook.once;
      hook.once = null;
      if (run) await run();
      const item = await baseCatalog.getItemContext(request, callOptions);
      if (item.status !== 'found' || item.pricing.status !== 'available') return item;
      const p = promo.current;
      const regular = item.pricing.regularGross.amount;
      const withPromo: CatalogItemContext = p.endsAt === undefined
        ? item
        : { ...item, pricing: { ...item.pricing, finalGross: { ...item.pricing.finalGross, amount: p.finalGross ?? Math.round(regular * 0.9) }, promotion: { type: 'percentage', percentOff: 0.1, amountOffGross: null, validUntil: p.endsAt } } };
      return p.available === undefined ? withPromo : { ...withPromo, availability: { ...withPromo.availability, availableQuantity: p.available } };
    },
  };
  const shipping = new FixtureShipping({ now });
  const thread: ConversationThreadEntry[] = [];
  let threadClock = T0 - 3_600_000;
  const say = (kind: 'agent' | 'contact', text: string) => {
    threadClock += 10_000;
    const atIso = new Date(threadClock).toISOString();
    const id = randomUUID();
    thread.push({ cursor: `${atIso}|${id}`, at: atIso, kind, text, refs: kind === 'agent' ? { stepId: id } : { inputId: id }, delivery: kind === 'agent' ? { outboundId: randomUUID(), status: 'accepted' } : null });
  };
  /** The owner answers "temporarily unavailable" to the next N creates (before committing anything). */
  const unavailable = { next: 0 };
  const flaky: QuoteV2Service = {
    createAndIssue: async (...a) => {
      if (unavailable.next > 0) {
        unavailable.next -= 1;
        throw new DomainError('temporarily_unavailable', 'quote_owner_unavailable', 'HTTP 503');
      }
      return owner.createAndIssue(...a);
    },
    getQuote: (...a) => owner.getQuote(...a),
    getOperation: (...a) => owner.getOperation(...a),
    lookupIdempotency: (...a) => owner.lookupIdempotency(...a),
    getDocument: (...a) => owner.getDocument(...a),
  };
  const quotes = killSwitchGuardedQuotes(flaky, controls, logger);
  const eligibility = options.eligibility ?? V3;
  const preview = quotePreviewV3Capability({ store, catalog, shipping, limits: LIMITS, now, eligibility });
  const create = () => quoteCreateV5Capability({ store, quotes, catalog, shipping, limits: LIMITS, conversation: { thread: () => Promise.resolve([...thread]) }, admission: controls, now, eligibility });
  let capability = create();
  const taskId = randomUUID();
  const trusted = { taskId, runId: randomUUID(), agentId: 'sales', agentVersion: 19, correlationId: 'it-promo', grantedScopes: ['quote.create', 'catalog.read', 'shipping.read', 'sales.workspace.write'] };
  const writeContext = (executionKey: string, attempt = 1): WriteHandlerContext => ({ executionKey, attempt, signal: new AbortController().signal, execution: { ...trusted, actor: { kind: 'service', ref: 'sales-channel-ingress' }, identityAssurance: 'provisional' } });
  const readContext = (): CapabilityHandlerContext => ({ execution: trusted, invocationId: randomUUID(), signal: new AbortController().signal });
  const workspace = workspaceCapabilityV2({ store, catalog, shipping, clock: { now } });
  return {
    clock, promo, owner, unavailable, store, hook,
    /** Selection (2 × Barra Z, no delivery), a preview, and the offer presented and accepted in the conversation. */
    async offered(): Promise<QuotePreviewV3Output> {
      expect(await workspace.execute(workspaceUpdateV2InputSchema.parse({ operations: [{ op: 'add_item', productId: 'BAR-EZ', quantity: 2 }, { op: 'exclude_shipping' }] }), writeContext(newKey()))).toMatchObject({ status: 'applied' });
      const p = await preview.handler({}, readContext());
      if (p.status === 'ready') {
        say('contact', 'Quiero 2 barras Z, sin despacho');
        say('agent', p.presentation!.offerMessage);
        say('contact', 'Sí, emítela.');
      }
      return p;
    },
    issue: (previewId: string, executionKey: string, attempt = 1) => capability.execute(quoteCreateV3Input.parse({ previewId }), writeContext(executionKey, attempt)),
    reconcile: (executionKey: string) => capability.reconcile!(writeContext(executionKey, 2)),
    restart: () => {
      capability = create();
    },
    decision: async (key: string) => (await store.autonomousDecision(key))?.quoteRequest as { promotion?: Record<string, unknown> } | null,
    /**
     * The owner's not-found window (90 + 30 s after the last attempt) is measured on the DATABASE clock: here the
     * recorded attempts are aged by 10 minutes (throwaway test database; the append-only trigger is bypassed for this
     * session only), which is what waiting that long would do.
     */
    async ageSends(key: string) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local session_replication_role = replica');
        await client.query(`update sales.quote_v2_sends set sent_at = sent_at - interval '10 minutes' where execution_key = $1`, [key]);
        await client.query('commit');
      } finally {
        client.release();
      }
    },
    validations: (key: string) => store.quoteV2SendValidations(key),
  };
}

const blockers = (p: QuotePreviewV3Output) => (p.status === 'blocked' ? p.blockers.map((b) => b.code) : []);

describe('promotional quotes: validity at the decision', () => {
  it('more than 75 minutes left: issued once; the promotion is persisted with the decision and with the send', async () => {
    const w = world();
    const p = await w.offered();
    expect(p).toMatchObject({ status: 'ready', issuable: true });
    const key = newKey();
    expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001' } });
    expect(w.owner.createCalls).toBe(1);
    const promotion = (await w.decision(key))!.promotion!;
    expect(promotion).toMatchObject({ policyVersion: F1_COMMERCIAL_POLICY_V3_VERSION, validatedAt: at(0), previewId: p.previewId, lines: [{ itemKey: 'BAR-EZ', quantity: 2, unitGross: expect.any(Number), promotionEndsAt: at(180), promotionRef: null, pricingReference: expect.any(String), catalogAsOf: expect.any(String) }] });
    expect(await w.validations(key)).toEqual([expect.objectContaining({ source: 'decision', validatedAt: at(0), previewId: p.previewId })]);
    // No customer data in the evidence (only owner references, amounts and instants).
    expect(JSON.stringify(promotion)).not.toMatch(/emítela|barras Z, sin/);
  });

  it('ending within 75 minutes, open-ended, or with the switch off: blocked at the preview; nothing is decided or written', async () => {
    for (const [endsAt, eligibility, code] of [[at(74), V3, 'price_promotional_ending'], [null, V3, 'price_promotional_unbounded'], [at(600), V2, 'price_promotional_excluded']] as const) {
      const w = world({ eligibility });
      w.promo.current = { endsAt };
      expect(blockers(await w.offered())).toEqual([code]);
      expect(w.owner.createCalls).toBe(0);
    }
  });

  it('a regular quote (no promotion) is decided and sent exactly as before: no promotion evidence, no send validation', async () => {
    const w = world();
    w.promo.current = {};
    const p = await w.offered();
    const key = newKey();
    expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'applied' });
    expect((await w.decision(key))!.promotion).toBeUndefined();
    expect(await w.validations(key)).toEqual([]);
  });
});

describe('promotional quotes: changes between the accepted offer and the issuance', () => {
  it('the price changes, the promotion is cancelled, or stock runs short after the offer was accepted: refused, owner never called', async () => {
    for (const [change, code] of [[{ endsAt: at(180), finalGross: 1 }, 'preview_stale'], [{}, 'preview_stale'], [{ endsAt: at(180), available: 1 }, 'insufficient_stock']] as const) {
      const w = world();
      const p = await w.offered();
      w.promo.current = change;
      expect(await w.issue(p.previewId!, newKey())).toMatchObject({ status: 'rejected', code });
      expect(w.owner.createCalls).toBe(0);
    }
  });
});

describe('promotional quotes: validation immediately before every send of the frozen body', () => {
  /** Authorizes the quote, then the owner is unavailable: held on its key (unknown), nothing committed by the owner. */
  async function heldAfterAuthorization(w: ReturnType<typeof world>) {
    const p = await w.offered();
    const key = newKey();
    w.unavailable.next = 1;
    expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'unknown' });
    expect(w.owner.quotes).toHaveLength(0);
    return { p, key };
  }

  it('held by the kill switch for 2 hours (promotion ends in 3 h): the replay finds it within 75 minutes of its end and sends nothing', async () => {
    const w = world();
    const p = await w.offered();
    const key = newKey();
    // The switch is engaged while the decision reads Catalog (after the first admission check): authorized, then held.
    w.hook.once = () => setAutonomy(false);
    try {
      expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'unknown', message: expect.stringMatching(/^autonomy_disabled/) });
      expect((await w.store.autonomousDecision(key))!.outcome).toBe('authorized');
      expect(w.owner.createCalls).toBe(0);
      w.clock.now += 120 * 60_000;
      w.restart();
      await w.ageSends(key);
    expect(await w.reconcile(key)).toEqual({ status: 'not_applied' });
      // Still engaged: held again before any validation or send.
      expect(await w.issue(p.previewId!, key, 2)).toMatchObject({ status: 'unknown' });
    } finally {
      await setAutonomy(true);
    }
    expect(await w.issue(p.previewId!, key, 3)).toMatchObject({ status: 'failed', code: PROMOTIONAL_QUOTE_NO_LONGER_VALID, details: { reason: 'price_promotional_ending' } });
    expect(w.owner.createCalls).toBe(0);
    expect(await w.validations(key)).toEqual([]);
  });

  it('owner unavailable, then 2 hours pass (promotion ends in 1 h): reconciled as not applied, the replay is refused before any send', async () => {
    const w = world();
    const { p, key } = await heldAfterAuthorization(w);
    expect(await w.validations(key)).toEqual([expect.objectContaining({ source: 'decision' })]);
    w.clock.now += 120 * 60_000;
    w.restart();
    await w.ageSends(key);
    expect(await w.reconcile(key)).toEqual({ status: 'not_applied' });
    const replay = await w.issue(p.previewId!, key, 2);
    expect(replay).toMatchObject({ status: 'failed', code: PROMOTIONAL_QUOTE_NO_LONGER_VALID, details: { reason: 'price_promotional_ending', retryable: false } });
    expect(w.owner.quotes).toHaveLength(0);
    // The refusal sent nothing: only the first (decision) validation exists; no other quote is ever created for it.
    expect(await w.validations(key)).toHaveLength(1);
  });

  it('owner unavailable, restart, promotion still 2 h away: revalidated against Catalog and sent once with the same key', async () => {
    const w = world();
    const { p, key } = await heldAfterAuthorization(w);
    w.clock.now += 30 * 60_000;
    w.restart();
    await w.ageSends(key);
    expect(await w.reconcile(key)).toEqual({ status: 'not_applied' });
    expect(await w.issue(p.previewId!, key, 2)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001' } });
    expect(w.owner.quotes).toHaveLength(1);
    const validations = await w.validations(key);
    expect(validations.map((v) => (v as { source: string }).source)).toEqual(['decision', 'revalidated']);
    expect(validations[1]).toMatchObject({ validatedAt: at(30), previewId: p.previewId, lines: [{ promotionEndsAt: at(180) }] });
  });

  it('held, then the promotion is cancelled, the price changes or stock runs short: the replay is refused before any send', async () => {
    for (const [change, reason] of [[{}, 'offer_changed'], [{ endsAt: at(180), finalGross: 1 }, 'offer_changed'], [{ endsAt: at(180), available: 1 }, 'insufficient_stock'], [{ endsAt: null }, 'price_promotional_unbounded']] as const) {
      const w = world();
      const { p, key } = await heldAfterAuthorization(w);
      w.promo.current = change;
      await w.ageSends(key);
    expect(await w.reconcile(key)).toEqual({ status: 'not_applied' });
      expect(await w.issue(p.previewId!, key, 2)).toMatchObject({ status: 'failed', code: PROMOTIONAL_QUOTE_NO_LONGER_VALID, details: { reason } });
      expect(w.owner.quotes).toHaveLength(0);
    }
  });

  it('an unknown outcome the owner DID commit is reconciled by its key: applied, never sent again, even if the promotion has since ended', async () => {
    const w = world();
    const p = await w.offered();
    const key = newKey();
    w.owner.faults.afterCommit = () => 'timeout';
    expect(await w.issue(p.previewId!, key)).toMatchObject({ status: 'unknown' });
    w.owner.faults.afterCommit = () => 'answer';
    w.clock.now += 170 * 60_000;
    w.promo.current = { endsAt: at(180) };
    w.restart();
    expect(await w.reconcile(key)).toMatchObject({ status: 'applied', result: { quoteNumber: 'PC-000001' } });
    expect(w.owner.createCalls).toBe(1);
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('two commands on one acceptance (duplicate): one quote, the other refused; the replay of the issued key never sends again', async () => {
    const w = world();
    const p = await w.offered();
    const [a, b] = [newKey(), newKey()];
    const results = await Promise.all([w.issue(p.previewId!, a), w.issue(p.previewId!, b)]);
    expect(results.map((r) => r.status).sort()).toEqual(['applied', 'rejected']);
    expect(w.owner.quotes).toHaveLength(1);
    const issued = results[0].status === 'applied' ? a : b;
    expect(await w.issue(p.previewId!, issued, 2)).toMatchObject({ status: 'applied', replayed: true });
    expect(w.owner.quotes).toHaveLength(1);
  });

  it('a regular quote held and replayed is sent as before: no Catalog revalidation, no validation recorded (unchanged)', async () => {
    const w = world();
    w.promo.current = {};
    const { p, key } = await heldAfterAuthorization(w);
    expect(await w.validations(key)).toEqual([]);
    w.restart();
    await w.ageSends(key);
    expect(await w.reconcile(key)).toEqual({ status: 'not_applied' });
    expect(await w.issue(p.previewId!, key, 2)).toMatchObject({ status: 'applied' });
    expect(await w.validations(key)).toEqual([]);
  });
});
