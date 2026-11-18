import { describe, expect, it } from 'vitest';
import { FixtureCatalog, FixtureShipping, type CatalogItemContext, type CatalogPort, type ShippingService } from '@r4-adapters/domains';
import { F1_COMMERCIAL_POLICY_V2_VERSION, F1_COMMERCIAL_POLICY_V3_VERSION, F1_COMMERCIAL_POLICY_VERSION, F1_PROMOTION_MARGIN_MS, F1_QUOTE_VALIDITY_MS, QUOTE_PARITY_REQUIRED_PROFILES, buildCommercialSnapshot, productContextOutput, productContextView, promotionQuotability, withPromotionQuotability, type Workspace } from '@r4-sales/agent';
import { SALES_PRODUCTION_PROFILE_V13, SALES_PRODUCTION_PROFILE_V14, SALES_PRODUCTION_PROFILE_V16, SALES_PRODUCTION_PROFILE_V17, SALES_PRODUCTION_PROFILE_V18, SALES_PRODUCTION_PROFILE_V19, SALES_PRODUCTION_PROFILE_V8, loadPromotionalQuotes, salesCommercialEligibility } from '@r4-sales/agent/production';

/**
 * F1 commercial policy (owner decision «F1 simplified commercial canary», 2026-11-09): Catalog V2 is the commercial
 * authority. @17 quotes what Catalog backs (price, stock, provenance, a bounded validity) with no static P-1 file, and
 * refuses degraded or unbounded answers, promotional prices (Catalog's own field, no heuristic) and any shipping.
 */
const NOW = new Date('2026-11-09T12:00:00Z');
const at = '2026-11-09T11:00:00Z';
const policy = { policyVersion: F1_COMMERCIAL_POLICY_VERSION };
type Found = Extract<CatalogItemContext, { status: 'found' }>;
const workspace = (delivery: { commune: string } | null): Workspace => ({
  taskId: 't', version: 2, createdAt: at, updatedAt: at,
  state: { facts: {}, delivery: delivery ? { ...delivery, sinceVersion: 1, updatedAt: at } : null, items: [{ productId: 'BAR-EZ', quantity: 2, sinceVersion: 1, updatedAt: at }], shipping: delivery ? null : { kind: 'excluded', sinceVersion: 2, updatedAt: at } },
} as unknown as Workspace);
function catalog(patch: (item: Found) => Found = (i) => i): CatalogPort {
  const base = new FixtureCatalog({ now: () => NOW });
  return {
    search: (...a) => base.search(...a),
    getProductContext: (...a) => base.getProductContext(...a),
    getItemContext: async (r, o) => {
      const item = await base.getItemContext(r, o);
      return item.status === 'found' ? patch(item) : item;
    },
  };
}
const pricing = (item: Found, extra: object) => ({ ...item, pricing: { ...item.pricing, ...extra } }) as Found;
let shippingCalls = 0;
const shipping = (): ShippingService => {
  const base = new FixtureShipping({ now: () => NOW });
  return { quote: (...a) => ((shippingCalls += 1), base.quote(...a)) };
};
const build = (c: CatalogPort, w: Workspace, eligibility: typeof policy | null) => buildCommercialSnapshot({ catalog: c, shipping: shipping(), eligibility }, w, {}, NOW);
const codes = (r: Awaited<ReturnType<typeof build>>) => (r.status === 'blocked' ? r.blockers.map((b) => b.code) : []);

describe('F1 commercial policy F1-COMMERCIAL-POLICY-v1 (Catalog V2 is the commercial authority)', () => {
  it('a regular price Catalog backs (provenance, bounded validity, stock) is quotable: no static P-1 file, no extra classification', async () => {
    expect((await build(catalog(), workspace(null), policy)).status).toBe('ready');
    expect([...QUOTE_PARITY_REQUIRED_PROFILES]).not.toContain('sales-production@17');
  });

  it('a promotional price (Catalog\'s own pricing.promotion) is excluded until its owners authorize it', async () => {
    const promo = catalog((i) => pricing(i, { promotion: { name: 'Cyber', percentOff: 0.1, amountOffGross: null, validUntil: '2026-11-09T12:30:00Z' } }));
    expect(codes(await build(promo, workspace(null), policy))).toEqual(['price_promotional_excluded']);
  });

  it('an answer without pricing provenance, or without a bounded validity, is refused (fail safe)', async () => {
    expect(codes(await build(catalog((i) => pricing(i, { engineVersion: '' })), workspace(null), policy))).toEqual(['catalog_provenance_missing']);
    expect(codes(await build(catalog((i) => ({ ...i, freshness: { ...i.freshness, validUntil: null } })), workspace(null), policy))).toEqual(['catalog_evidence_unbounded']);
  });

  it('a stale answer stays refused (as for every profile)', async () => {
    expect(codes(await build(catalog((i) => ({ ...i, freshness: { ...i.freshness, validUntil: '2026-11-09T11:59:59Z' } })), workspace(null), policy))).toEqual(['catalog_evidence_stale']);
  });

  it('a delivery destination is refused before pricing any shipping (F1 quotes carry no shipping)', async () => {
    shippingCalls = 0;
    expect(codes(await build(catalog(), workspace({ commune: 'Ñuñoa' }), policy))).toContain('shipping_not_in_f1');
    expect(shippingCalls).toBe(0);
  });

  it('F1-COMMERCIAL-POLICY-v2 (@19): a delivery destination is priced by the Shipping owner, never blocked by the policy', async () => {
    shippingCalls = 0;
    const v2 = { policyVersion: F1_COMMERCIAL_POLICY_V2_VERSION, shippingAllowed: true };
    const result = codes(await build(catalog(), workspace({ commune: 'Ñuñoa' }), v2));
    expect(result).not.toContain('shipping_not_in_f1');
    expect(result).toContain('shipping_not_selected');
    expect(salesCommercialEligibility(SALES_PRODUCTION_PROFILE_V19)).toEqual(v2);
    expect(salesCommercialEligibility(SALES_PRODUCTION_PROFILE_V18)).toEqual(policy);
  });

  it('only the F1 candidate @17 applies the policy; every other profile is unchanged', async () => {
    expect(salesCommercialEligibility(SALES_PRODUCTION_PROFILE_V17)).toEqual(policy);
    for (const p of [SALES_PRODUCTION_PROFILE_V16, SALES_PRODUCTION_PROFILE_V14, SALES_PRODUCTION_PROFILE_V13, SALES_PRODUCTION_PROFILE_V8]) expect(salesCommercialEligibility(p)).toBeNull();
    const promo = catalog((i) => pricing(i, { promotion: { name: 'Cyber', percentOff: 0.1, amountOffGross: null, validUntil: null } }));
    expect((await build(promo, workspace(null), null)).status).toBe('ready');
  });
});

/**
 * F1-COMMERCIAL-POLICY-v3 (owner decision 2026-11-13; active only once the Quote owner accepts it): a promotional price
 * is quoted only while Catalog's own `promotion.validUntil` outlasts the 60-minute quote plus a 15-minute margin.
 */
describe('F1-COMMERCIAL-POLICY-v3: promotional prices with a verifiable end', () => {
  const v3 = { policyVersion: F1_COMMERCIAL_POLICY_V3_VERSION, shippingAllowed: true, promotionsAllowed: true };
  const promoEnding = (validUntil: string | null) => catalog((i) => pricing(i, { promotion: { type: 'percentage', percentOff: 0.1, amountOffGross: null, validUntil } }));
  const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

  it('quotes a promotion that ends at least 75 minutes from now (60-minute quote + 15-minute margin), keeping its end as evidence', async () => {
    const at75 = await build(promoEnding(minutes(75)), workspace(null), v3);
    expect(at75.status).toBe('ready');
    if (at75.status === 'ready') expect(at75.evidence.lines[0]).toMatchObject({ itemKey: 'BAR-EZ', promotionEndsAt: minutes(75) });
    expect((await build(promoEnding(minutes(24 * 60)), workspace(null), v3)).status).toBe('ready');
  });

  it('refuses a promotion ending sooner, an open-ended or unknown end, and stays at v2 behaviour when not enabled', async () => {
    expect(codes(await build(promoEnding(minutes(74)), workspace(null), v3))).toEqual(['price_promotional_ending']);
    expect(codes(await build(promoEnding(minutes(-1)), workspace(null), v3))).toEqual(['price_promotional_ending']);
    expect(codes(await build(promoEnding(null), workspace(null), v3))).toEqual(['price_promotional_unbounded']);
    expect(codes(await build(promoEnding('not-a-date'), workspace(null), v3))).toEqual(['price_promotional_unbounded']);
    const v2 = { policyVersion: F1_COMMERCIAL_POLICY_V2_VERSION, shippingAllowed: true };
    expect(codes(await build(promoEnding(minutes(24 * 60)), workspace(null), v2))).toEqual(['price_promotional_excluded']);
  });

  it('is judged with the clock of each decision: a preview that qualified no longer does at issuance once the end comes within 75 minutes', () => {
    const promotion = { type: 'percentage' as const, percentOff: 0.1, amountOffGross: null, validUntil: minutes(80) };
    expect(promotionQuotability(promotion, v3, NOW)).toEqual({ quotable: true, endsAt: minutes(80) });
    expect(promotionQuotability(promotion, v3, new Date(NOW.getTime() + 6 * 60_000))).toMatchObject({ quotable: false, code: 'price_promotional_ending' });
    expect(F1_QUOTE_VALIDITY_MS + F1_PROMOTION_MARGIN_MS).toBe(75 * 60_000);
  });

  it('only @19 can enable it, from R4_F1_PROMOTIONAL_QUOTES=enabled (default off; anything else refuses)', () => {
    expect(salesCommercialEligibility(SALES_PRODUCTION_PROFILE_V19, true)).toEqual(v3);
    expect(salesCommercialEligibility(SALES_PRODUCTION_PROFILE_V19)).toEqual({ policyVersion: F1_COMMERCIAL_POLICY_V2_VERSION, shippingAllowed: true });
    for (const p of [SALES_PRODUCTION_PROFILE_V18, SALES_PRODUCTION_PROFILE_V17, SALES_PRODUCTION_PROFILE_V8]) expect(() => salesCommercialEligibility(p, true)).toThrow(/promotional quotes/);
    expect(loadPromotionalQuotes({})).toBe(false);
    expect(loadPromotionalQuotes({ R4_F1_PROMOTIONAL_QUOTES: 'disabled' })).toBe(false);
    expect(loadPromotionalQuotes({ R4_F1_PROMOTIONAL_QUOTES: 'enabled' })).toBe(true);
    expect(() => loadPromotionalQuotes({ R4_F1_PROMOTIONAL_QUOTES: 'yes' })).toThrow(/enabled or disabled/);
  });

  it('the agent reads, on the product itself, whether a formal quote at the promotional price is possible (same rule)', async () => {
    const call = { signal: new AbortController().signal, correlationId: 'c' };
    const base = productContextView(await new FixtureCatalog({ now: () => NOW }).getProductContext('BAR-EZ', call));
    if (base.status !== 'found' || !base.derived.price) throw new Error('fixture');
    const discounted = { ...base, derived: { ...base.derived, price: { ...base.derived.price, discounted: true } } };
    const annotate = async (validUntil: string | null, eligibility: { promotionsAllowed?: boolean }) =>
      withPromotionQuotability(discounted, promoEnding(validUntil), { eligibility, now: () => NOW }, call);
    const ok = await annotate(minutes(120), v3);
    expect(ok.status === 'found' && ok.derived.promotion).toMatchObject({ formalQuote: 'available', endsAt: minutes(120) });
    expect(productContextOutput.safeParse(ok).success).toBe(true);
    const ending = await annotate(minutes(30), v3);
    expect(ending.status === 'found' && ending.derived.promotion).toMatchObject({ formalQuote: 'not_available' });
    expect(ending.status === 'found' && ending.derived.promotion?.note).toMatch(/cannot be issued.*Do not offer it as quotable/);
    // v2 (not enabled): the agent learns up front that the promotional price is not quotable at all.
    const v2 = await annotate(minutes(24 * 60), { promotionsAllowed: false });
    expect(v2.status === 'found' && v2.derived.promotion).toMatchObject({ formalQuote: 'not_available' });
    // A product without a discount is read as before (no extra owner call needed, no annotation).
    expect(await withPromotionQuotability(base, promoEnding(minutes(120)), { eligibility: v3, now: () => NOW }, call)).toEqual(base);
  });
});
