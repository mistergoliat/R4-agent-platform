import { describe, expect, it } from 'vitest';
import { FIXTURE_PRODUCTS, FixtureCatalog, type FixtureProductRecord } from '@r4-adapters/domains';

/**
 * R4-DISCOVER-I1 §5 — the FixtureCatalog stands in for the Catalog OWNER, so it must follow the
 * owner's commercial contract (catalog-service unitPriceBudget, CAT-DISCOVER-C2): a reference
 * price of something that cannot be ordered never satisfies `maxUnitPrice`, a "from" price never
 * certifies a fixed variant, a unit that is not sellable is never offered for immediate purchase,
 * and price and stock always belong to the same itemKey. (Before I1, fixture.ts let a not_offerable
 * price pass `maxUnitPrice`, which the real owner never does.)
 */
const now = new Date('2026-01-01T00:00:00.000Z');
const catalog = (products: readonly FixtureProductRecord[] = FIXTURE_PRODUCTS) => new FixtureCatalog({ products, now: () => now });

describe('FixtureCatalog — maxUnitPrice follows the owner\'s budget predicate', () => {
  it('a reference price of a product that cannot be ordered (out of stock, no backorder) does not satisfy the budget', async () => {
    const c = catalog();
    const unfiltered = await c.search({ query: 'power rack', limit: 10 });
    const pr300 = unfiltered.results.find((r) => r.productKey === 'RACK-PR300')!;
    expect(pr300.priceSummary).toMatchObject({ basis: 'not_offerable', finalGross: { amount: 459_990 } });
    expect(pr300.availabilitySummary.sellability).toBe('not_sellable');
    // Search still shows it (visibility is not a budget question) …
    expect(unfiltered.results.map((r) => r.productKey)).toContain('RACK-PR300');
    // … but 459 990 ≤ 500 000 is NOT "within budget": a reference price is never an offer.
    const budget = await c.search({ query: 'power rack', filters: { maxUnitPrice: 500_000 }, limit: 10 });
    expect(budget.results.map((r) => r.productKey)).not.toContain('RACK-PR300');
    expect(budget.results.every((r) => r.priceSummary?.basis === 'offerable' && r.priceSummary.finalGross.amount <= 500_000)).toBe(true);
  });

  it('a product whose variants are all unorderable has a not_offerable "from" that never satisfies a budget', async () => {
    const kb = FIXTURE_PRODUCTS.find((p) => p.productKey === 'KB-COMP')!;
    const none = { ...kb, variants: kb.variants.map((v) => ({ ...v, availableQuantity: 0 })) };
    const c = catalog([none]);
    expect((await c.search({ query: 'kettlebell competicion', limit: 5 })).results[0]!.priceSummary).toMatchObject({ kind: 'from', basis: 'not_offerable' });
    expect((await c.search({ query: 'kettlebell competicion', filters: { maxUnitPrice: 1_000_000 }, limit: 5 })).results).toEqual([]);
  });

  it('a "from" price proves SOME orderable unit fits, never a fixed variant', async () => {
    const c = catalog();
    const within = await c.search({ query: 'kettlebell competicion', filters: { maxUnitPrice: 50_000 }, limit: 5 });
    const kbComp = within.results.find((r) => r.productKey === 'KB-COMP');
    expect(kbComp?.priceSummary).toMatchObject({ kind: 'from', basis: 'offerable', finalGross: { amount: 44_990 } });
    // The 24 kg variant the customer may fix costs 74 990: over the same budget. Only its item context says so.
    const kb24 = await c.getItemContext({ itemKey: 'KB-COMP-24', quantity: 1 });
    expect(kb24.status === 'found' && kb24.pricing.status === 'available' ? kb24.pricing.finalGross.amount : null).toBe(74_990);
    // The product key itself is not a sellable unit: a variant must be chosen.
    expect((await c.getItemContext({ itemKey: 'KB-COMP', quantity: 1 })).status).toBe('variant_required');
  });

  it('a unit that is not sellable is not offered for immediate purchase (sellability not_sellable, not orderable)', async () => {
    const kb16 = await catalog().getItemContext({ itemKey: 'KB-COMP-16', quantity: 1 });
    expect(kb16).toMatchObject({ status: 'found', availability: { sellability: 'not_sellable', reason: 'out_of_stock', availableQuantity: 0 } });
    expect(catalog().current('KB-COMP-16')).toMatchObject({ sellability: 'not_sellable' });
  });

  it('price and stock belong to the same itemKey, and changing one unit never changes another', async () => {
    const c = catalog();
    const kb = FIXTURE_PRODUCTS.find((p) => p.productKey === 'KB-COMP')!;
    for (const v of kb.variants) {
      const item = await c.getItemContext({ itemKey: v.itemKey, quantity: 1 });
      expect(item.status).toBe('found');
      if (item.status !== 'found' || item.pricing.status !== 'available') continue;
      expect(item.itemKey).toBe(v.itemKey);
      expect(item.pricing.finalGross.amount).toBe(v.finalGross);
      expect(item.availability.availableQuantity).toBe(v.availableQuantity);
    }
    c.setStock('KB-COMP-12', 0);
    c.setPrice('KB-COMP-24', 70_000);
    const kb12 = await c.getItemContext({ itemKey: 'KB-COMP-12', quantity: 1 });
    const kb24 = await c.getItemContext({ itemKey: 'KB-COMP-24', quantity: 1 });
    expect(kb12.status === 'found' && kb12.pricing.status === 'available' ? [kb12.pricing.finalGross.amount, kb12.availability.availableQuantity] : null).toEqual([44_990, 0]);
    expect(kb24.status === 'found' && kb24.pricing.status === 'available' ? [kb24.pricing.finalGross.amount, kb24.availability.availableQuantity] : null).toEqual([70_000, 4]);
    // With KB-COMP-12 out of stock the owner's "from" moves to the cheapest ORDERABLE unit (70 000), and a 50 000 budget no longer fits.
    expect((await c.search({ query: 'kettlebell competicion', limit: 5 })).results.find((r) => r.productKey === 'KB-COMP')!.priceSummary).toMatchObject({ kind: 'from', basis: 'offerable', finalGross: { amount: 70_000 } });
    expect((await c.search({ query: 'kettlebell competicion', filters: { maxUnitPrice: 50_000 }, limit: 5 })).results.map((r) => r.productKey)).not.toContain('KB-COMP');
  });
});
