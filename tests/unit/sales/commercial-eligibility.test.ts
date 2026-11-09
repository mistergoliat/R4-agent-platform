import { describe, expect, it } from 'vitest';
import { FixtureCatalog, FixtureShipping, type CatalogItemContext, type CatalogPort, type ShippingService } from '@r4-adapters/domains';
import { F1_COMMERCIAL_POLICY_VERSION, buildCommercialSnapshot, catalogPriceClass, type Workspace } from '@r4-sales/agent';
import { SALES_PRODUCTION_PROFILE_V13, SALES_PRODUCTION_PROFILE_V14, SALES_PRODUCTION_PROFILE_V16, SALES_PRODUCTION_PROFILE_V17, SALES_PRODUCTION_PROFILE_V8, salesCommercialEligibility } from '@r4-sales/agent/production';

/**
 * F1 commercial eligibility: R4 reads the Catalog owner's price class (never infers it) and refuses a line that is
 * promotional or not proven regular, and any shipping charge while pc-carrier gives no rate validity. Fail safe.
 */
const NOW = new Date('2026-11-09T12:00:00Z');
const at = '2026-11-09T11:00:00Z';
const policy = { policyVersion: F1_COMMERCIAL_POLICY_VERSION };
const workspace = (delivery: { commune: string } | null): Workspace => ({
  taskId: 't', version: 2, createdAt: at, updatedAt: at,
  state: { facts: {}, delivery: delivery ? { ...delivery, sinceVersion: 1, updatedAt: at } : null, items: [{ productId: 'BAR-EZ', quantity: 2, sinceVersion: 1, updatedAt: at }], shipping: delivery ? null : { kind: 'excluded', sinceVersion: 2, updatedAt: at } },
} as unknown as Workspace);
function catalog(promotion: boolean): CatalogPort {
  const base = new FixtureCatalog({ now: () => NOW });
  return {
    search: (...a) => base.search(...a),
    getProductContext: (...a) => base.getProductContext(...a),
    getItemContext: async (r, o) => {
      const item = await base.getItemContext(r, o);
      if (item.status !== 'found' || item.pricing.status !== 'available' || !promotion) return item;
      return { ...item, pricing: { ...item.pricing, promotion: { name: 'Cyber', percentOff: 0.1, amountOffGross: null, validUntil: '2026-11-09T12:30:00Z' } } } as unknown as CatalogItemContext;
    },
  };
}
let shippingCalls = 0;
const shipping = (): ShippingService => {
  const base = new FixtureShipping({ now: () => NOW });
  return { quote: (...a) => ((shippingCalls += 1), base.quote(...a)) };
};
const build = (c: CatalogPort, w: Workspace, eligibility: typeof policy | null) => buildCommercialSnapshot({ catalog: c, shipping: shipping(), eligibility }, w, {}, NOW);

describe('F1 commercial eligibility (policy F1-COMMERCIAL-POLICY-v1)', () => {
  it('without the policy (every profile but @17) the snapshot is unchanged', async () => {
    expect((await build(catalog(false), workspace(null), null)).status).toBe('ready');
  });

  it('a price the owner does not declare regular is refused (unknown), with the policy version', async () => {
    expect(await build(catalog(false), workspace(null), policy)).toMatchObject({ status: 'blocked', blockers: [{ code: 'price_class_unknown', details: { itemKey: 'BAR-EZ', policy: 'F1-COMMERCIAL-POLICY-v1' } }] });
  });

  it('a promotional price is excluded', async () => {
    expect(await build(catalog(true), workspace(null), policy)).toMatchObject({ status: 'blocked', blockers: [{ code: 'price_promotional_excluded', details: { itemKey: 'BAR-EZ' } }] });
  });

  it('a delivery destination is refused before pricing any shipping (no rate validity yet)', async () => {
    shippingCalls = 0;
    const result = await build(catalog(false), workspace({ commune: 'Ñuñoa' }), policy);
    expect(result).toMatchObject({ status: 'blocked' });
    expect(result.status === 'blocked' && result.blockers.map((b) => b.code)).toContain('shipping_validity_unverified');
    expect(shippingCalls).toBe(0);
  });

  it('the price class is read from the owner, never inferred: promotion → promotional; anything else → unknown', () => {
    const available = { status: 'available' as const, quantity: 1, regularGross: { amount: 1, currency: 'CLP' }, finalGross: { amount: 1, currency: 'CLP' }, tax: { included: true as const, rate: 0.19, basis: 'x' }, engineVersion: 'e' };
    expect(catalogPriceClass({ ...available, promotion: null } as never)).toBe('unknown');
    expect(catalogPriceClass({ ...available, promotion: { percentOff: 0.1 } } as never)).toBe('promotional');
    expect(catalogPriceClass({ status: 'unavailable', reason: 'x' } as never)).toBe('unknown');
  });

  it('only the F1 candidate @17 enforces it', () => {
    expect(salesCommercialEligibility(SALES_PRODUCTION_PROFILE_V17)).toEqual(policy);
    for (const p of [SALES_PRODUCTION_PROFILE_V16, SALES_PRODUCTION_PROFILE_V14, SALES_PRODUCTION_PROFILE_V13, SALES_PRODUCTION_PROFILE_V8]) expect(salesCommercialEligibility(p)).toBeNull();
  });
});
