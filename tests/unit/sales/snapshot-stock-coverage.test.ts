import { describe, expect, it } from 'vitest';
import { FixtureCatalog, FixtureShipping, catalogShortStock, type CatalogItemContext, type CatalogPort } from '@r4-adapters/domains';
import { buildCommercialSnapshot, type Workspace } from '@r4-sales/agent';

/**
 * (R4-J5 F2-1) Catalog engine v2.3.0 evaluates sellability for the requested quantity: 4 on hand for 5 asked
 * comes as not_sellable/out_of_stock (or backorder/backorder_allowed) with stockCoverage "partial". The quote
 * path must keep reporting it as insufficient stock with the units on hand, never as "not sellable / no stock".
 */
const NOW = new Date('2026-11-05T12:00:00Z');
const at = '2026-11-05T11:00:00Z';
const workspace = (quantity: number): Workspace => ({
  taskId: 't',
  version: 2,
  createdAt: at,
  updatedAt: at,
  state: { facts: {}, delivery: null, items: [{ productId: 'BAR-EZ', quantity, sinceVersion: 1, updatedAt: at }], shipping: { kind: 'excluded', sinceVersion: 2, updatedAt: at } },
});

function catalogAnswering(patch: (a: Extract<CatalogItemContext, { status: 'found' }>['availability']) => Record<string, unknown>): CatalogPort {
  const base = new FixtureCatalog({ now: () => NOW });
  return {
    search: (...a) => base.search(...a),
    getProductContext: (...a) => base.getProductContext(...a),
    getItemContext: async (request, options) => {
      const item = await base.getItemContext(request, options);
      return item.status === 'found' ? { ...item, availability: { ...item.availability, ...patch(item.availability) } } : item;
    },
  };
}
const snapshot = (catalog: CatalogPort, quantity: number) => buildCommercialSnapshot({ catalog, shipping: new FixtureShipping({ now: () => NOW }) }, workspace(quantity), {}, NOW);

describe('commercial snapshot: Catalog v2.3.0 partial stock coverage (F2-1)', () => {
  it.each([
    ['not_sellable', 'out_of_stock'],
    ['backorder', 'backorder_allowed'],
  ])('%s/%s with partial coverage is insufficient_stock with the units on hand', async (sellability, reason) => {
    const result = await snapshot(catalogAnswering(() => ({ sellability, reason, availableQuantity: 4, requestedQuantity: 5, stockCoverage: 'partial' })), 5);
    expect(result).toMatchObject({ status: 'blocked', blockers: [{ code: 'insufficient_stock', details: { available: 4, requested: 5 } }] });
  });

  it('the v2.2.0 shape (sellable, fewer units than asked, no coverage field) is still insufficient_stock', async () => {
    const result = await snapshot(catalogAnswering(() => ({ sellability: 'sellable', reason: 'in_stock', availableQuantity: 4 })), 5);
    expect(result).toMatchObject({ status: 'blocked', blockers: [{ code: 'insufficient_stock', details: { available: 4, requested: 5 } }] });
  });

  it('no stock at all (coverage none) stays not sellable, and a non-stock reason is never re-read as stock', async () => {
    const none = await snapshot(catalogAnswering(() => ({ sellability: 'not_sellable', reason: 'out_of_stock', availableQuantity: 0, requestedQuantity: 5, stockCoverage: 'none' })), 5);
    expect(none).toMatchObject({ status: 'blocked', blockers: [{ code: 'item_not_sellable', details: { reason: 'out_of_stock' } }] });
    const inactive = await snapshot(catalogAnswering(() => ({ sellability: 'not_sellable', reason: 'inactive', availableQuantity: 4, requestedQuantity: 5, stockCoverage: 'partial' })), 5);
    expect(inactive).toMatchObject({ status: 'blocked', blockers: [{ code: 'item_not_sellable', details: { reason: 'inactive' } }] });
  });

  it('full coverage quotes as before', async () => {
    const result = await snapshot(catalogAnswering(() => ({ sellability: 'sellable', reason: 'in_stock', availableQuantity: 9, requestedQuantity: 2, stockCoverage: 'full' })), 2);
    expect(result.status).toBe('ready');
  });

  it('catalogShortStock: the units on hand only when the stock covers part of the quantity', () => {
    expect(catalogShortStock({ sellability: 'not_sellable', reason: 'out_of_stock', availableQuantity: 4, stockCoverage: 'partial' }, 5)).toBe(4);
    expect(catalogShortStock({ sellability: 'sellable', reason: 'in_stock', availableQuantity: 4 }, 5)).toBe(4);
    expect(catalogShortStock({ sellability: 'sellable', reason: 'in_stock', availableQuantity: 5 }, 5)).toBeNull();
    expect(catalogShortStock({ sellability: 'not_sellable', reason: 'out_of_stock', availableQuantity: 0, stockCoverage: 'none' }, 5)).toBeNull();
    expect(catalogShortStock({ sellability: 'check_with_staff', reason: 'stock_unknown', availableQuantity: null, stockCoverage: 'unknown' }, 5)).toBeNull();
    expect(catalogShortStock({ sellability: 'not_sellable', reason: 'not_listed', availableQuantity: 4, stockCoverage: 'partial' }, 5)).toBeNull();
  });
});
