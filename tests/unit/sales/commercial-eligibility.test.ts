import { describe, expect, it } from 'vitest';
import { FixtureCatalog, FixtureShipping, type CatalogItemContext, type CatalogPort, type ShippingService } from '@r4-adapters/domains';
import { F1_COMMERCIAL_POLICY_VERSION, QUOTE_PARITY_REQUIRED_PROFILES, buildCommercialSnapshot, type Workspace } from '@r4-sales/agent';
import { SALES_PRODUCTION_PROFILE_V13, SALES_PRODUCTION_PROFILE_V14, SALES_PRODUCTION_PROFILE_V16, SALES_PRODUCTION_PROFILE_V17, SALES_PRODUCTION_PROFILE_V8, salesCommercialEligibility } from '@r4-sales/agent/production';

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

  it('only the F1 candidate @17 applies the policy; every other profile is unchanged', async () => {
    expect(salesCommercialEligibility(SALES_PRODUCTION_PROFILE_V17)).toEqual(policy);
    for (const p of [SALES_PRODUCTION_PROFILE_V16, SALES_PRODUCTION_PROFILE_V14, SALES_PRODUCTION_PROFILE_V13, SALES_PRODUCTION_PROFILE_V8]) expect(salesCommercialEligibility(p)).toBeNull();
    const promo = catalog((i) => pricing(i, { promotion: { name: 'Cyber', percentOff: 0.1, amountOffGross: null, validUntil: null } }));
    expect((await build(promo, workspace(null), null)).status).toBe('ready');
  });
});
