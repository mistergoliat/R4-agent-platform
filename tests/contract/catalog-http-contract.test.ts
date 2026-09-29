import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HttpCatalogAdapter, catalogItemContextResponseSchema, catalogProductContextResponseSchema, catalogSearchResponseSchema } from '@r4-adapters/catalog-http';
import { TEST_CATALOG_CONFIG, catalogFixture, catalogFixtureNames, fakeCatalogFetch, json } from '../support/catalog-contract.js';

/**
 * R4-J1B consumer contract: the (temporary) Catalog fixtures are the source
 * of truth for what R4 accepts. Additive evolution is tolerated; a new
 * schemaVersion and every contract invariant violation are rejected — never
 * repaired.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const schemaFor = (name: string) => (name.startsWith('search/') ? catalogSearchResponseSchema : name.startsWith('product/') ? catalogProductContextResponseSchema : catalogItemContextResponseSchema);
const clone = <T>(value: T): T => structuredClone(value);

/** Adds an unknown field to every object in the payload (what a newer owner might send). */
function withAdditiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withAdditiveFields);
  if (value !== null && typeof value === 'object') return { ...Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withAdditiveFields(v)])), futureField: { note: 'added by a newer owner' } };
  return value;
}

describe('Catalog contract fixtures (schemaVersion 1)', () => {
  const names = catalogFixtureNames();

  it('covers every case J1B requires', () => {
    expect(names.sort()).toEqual([
      'item/backorder.json', 'item/not-found.json', 'item/not-sellable.json', 'item/pricing-unavailable.json', 'item/promotion.json', 'item/selected-variant.json', 'item/simple.json', 'item/stock-unknown.json', 'item/variant-required.json',
      'product/inactive.json', 'product/not-found.json', 'product/not-listed.json', 'product/simple.json', 'product/with-variants.json',
      'search/empty-complete.json', 'search/exact-name.json', 'search/exact-sku.json', 'search/no-stock-present.json', 'search/product-with-variants.json', 'search/truncated.json',
    ]);
  });

  it.each(names)('%s validates against the adapter schema', (name) => {
    const parsed = schemaFor(name).safeParse(catalogFixture(name));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it.each(names)('%s: unknown additional fields at every level are tolerated and dropped', (name) => {
    const parsed = schemaFor(name).safeParse(withAdditiveFields(catalogFixture(name)));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    expect(JSON.stringify(parsed.data)).not.toContain('futureField');
  });

  it('a breaking schemaVersion is rejected by the adapter before parsing (contract_violation, not retryable)', async () => {
    for (const version of [2, 0, '1', undefined]) {
      const body = { ...catalogFixture('search/exact-name.json'), schemaVersion: version };
      const adapter = new HttpCatalogAdapter({ config: TEST_CATALOG_CONFIG, fetch: fakeCatalogFetch(() => json(200, body)).fetch });
      await expect(adapter.search({ query: 'banco' }), String(version)).rejects.toMatchObject({ category: 'contract_violation', code: 'unsupported_schema_version', retryable: false });
    }
  });
});

describe('contract invariants are enforced (R4 rejects, never repairs)', () => {
  const rejects = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => expect(schema.safeParse(value).success).toBe(false);

  it('search: identity, completeness, price and sellability invariants', () => {
    const base = catalogFixture('search/exact-name.json') as { results: Record<string, unknown>[]; completeness: Record<string, unknown> };
    const mutate = (fn: (b: typeof base) => void) => {
      const b = clone(base);
      fn(b);
      return b;
    };
    rejects(catalogSearchResponseSchema, mutate((b) => { b.results[0]!.variants = { count: 0, requiresSelection: true }; }));
    rejects(catalogSearchResponseSchema, mutate((b) => { b.results[0]!.priceSummary = { kind: 'from', finalGross: { amount: 1, currency: 'CLP' }, regularGross: { amount: 1, currency: 'CLP' }, discounted: false }; }));
    rejects(catalogSearchResponseSchema, mutate((b) => { b.completeness = { totalMatches: 5, truncated: false }; }));
    rejects(catalogSearchResponseSchema, mutate((b) => { b.completeness = { totalMatches: 0, truncated: false }; }));
    rejects(catalogSearchResponseSchema, mutate((b) => { b.results.push(clone(b.results[0]!)); b.completeness = { totalMatches: 2, truncated: false }; }));
    rejects(catalogSearchResponseSchema, mutate((b) => { b.results[0]!.availabilitySummary = { sellability: 'sellable', reason: 'out_of_stock', sellableVariants: null }; }));
    rejects(catalogSearchResponseSchema, mutate((b) => { b.results[0]!.priceSummary = { kind: 'exact', finalGross: { amount: 200, currency: 'CLP' }, regularGross: { amount: 100, currency: 'CLP' }, discounted: false }; }));
    rejects(catalogSearchResponseSchema, mutate((b) => { b.results[0]!.priceSummary = { kind: 'exact', finalGross: { amount: 90, currency: 'CLP' }, regularGross: { amount: 100, currency: 'CLP' }, discounted: false }; }));
    rejects(catalogSearchResponseSchema, mutate((b) => { b.results[0]!.priceSummary = { kind: 'exact', finalGross: { amount: 100, currency: 'USD' }, regularGross: { amount: 100, currency: 'USD' }, discounted: false }; }));
    rejects(catalogSearchResponseSchema, mutate((b) => { (b.results[0]!.product as Record<string, unknown>).productKey = '../admin'; }));
    rejects(catalogSearchResponseSchema, mutate((b) => { (b as Record<string, unknown>).freshness = { asOf: '2026-09-29T15:00:00.000Z', cache: { hit: true, ageMs: 10 }, validUntil: '2026-09-29T14:00:00.000Z' }; }));
    rejects(catalogSearchResponseSchema, mutate((b) => { delete (b as Record<string, unknown>).freshness; }));
  });

  it('product context: sellable identity, variant ownership, lifecycle and text bounds', () => {
    const simple = catalogFixture('product/simple.json') as { facts: Record<string, unknown>; derived: Record<string, unknown> };
    const variants = catalogFixture('product/with-variants.json') as { facts: { variantOptions: { item: Record<string, unknown> }[]; sellableItem: unknown } };
    const m = <T>(value: T, fn: (b: T) => void) => {
      const b = clone(value);
      fn(b);
      return b;
    };
    rejects(catalogProductContextResponseSchema, m(simple, (b) => { b.facts.sellableItem = null; }));
    rejects(catalogProductContextResponseSchema, m(simple, (b) => { b.facts.sellableItem = { productId: '898', variantId: '3', itemKey: 'P898-V3' }; }));
    rejects(catalogProductContextResponseSchema, m(variants, (b) => { b.facts.sellableItem = { productId: '1301', variantId: null, itemKey: 'P1301' }; }));
    rejects(catalogProductContextResponseSchema, m(variants, (b) => { b.facts.variantOptions[0]!.item.variantId = null; }));
    rejects(catalogProductContextResponseSchema, m(variants, (b) => { b.facts.variantOptions[0]!.item.productId = '999'; }));
    rejects(catalogProductContextResponseSchema, m(variants, (b) => { b.facts.variantOptions[1]!.item.itemKey = 'P1301-V12'; }));
    rejects(catalogProductContextResponseSchema, m(simple, (b) => { b.facts.lifecycle = { status: 'inactive', listed: true, orderable: true }; }));
    rejects(catalogProductContextResponseSchema, m(simple, (b) => { b.facts.shortDescription = 'x'.repeat(601); }));
    rejects(catalogProductContextResponseSchema, m(simple, (b) => { b.facts.specifications = Array.from({ length: 41 }, (_, i) => ({ name: `n${i}`, value: 'v' })); }));
    rejects(catalogProductContextResponseSchema, m(simple, (b) => { b.derived.priceSummary = { kind: 'from', finalGross: { amount: 1, currency: 'CLP' }, regularGross: { amount: 1, currency: 'CLP' }, discounted: false }; }));
  });

  it('item context: item/product agreement, variant presence, price ordering, no lead time', () => {
    const variant = catalogFixture('item/selected-variant.json') as Record<string, unknown> & { item: Record<string, unknown>; pricing: Record<string, unknown>; availability: Record<string, unknown> };
    const m = (fn: (b: typeof variant) => void) => {
      const b = clone(variant);
      fn(b);
      return b;
    };
    rejects(catalogItemContextResponseSchema, m((b) => { b.variant = null; }));
    rejects(catalogItemContextResponseSchema, m((b) => { b.item.productId = '898'; }));
    rejects(catalogItemContextResponseSchema, m((b) => { b.pricing.finalGross = { amount: 99_999_999, currency: 'CLP' }; }));
    rejects(catalogItemContextResponseSchema, m((b) => { b.availability.leadTime = '3 días'; }));
    rejects(catalogItemContextResponseSchema, m((b) => { b.availability.sellability = 'backorder'; }));
    rejects(catalogItemContextResponseSchema, m((b) => { (b.pricing.taxBasis as Record<string, unknown>).taxIncluded = false; }));
  });
});

describe('the HTTP adapter contains no Catalog business repair logic', () => {
  const sources = ['adapter.ts', 'schemas.ts', 'config.ts'].map((f) => readFileSync(join(ROOT, 'adapters/domains/catalog/http/src', f), 'utf8'));
  const adapter = sources[0]!;

  it('fabricates no time and never reorders, deduplicates or recomputes', () => {
    const all = sources.join('\n');
    // No clock: freshness is the owner's (Date.parse only compares owner timestamps).
    expect(all).not.toMatch(/Date\.now\(|new Date\(/);
    // No reranking / dedup / selection over owner results.
    expect(all).not.toMatch(/\.sort\(|\.reverse\(|new Map\(|\.find\(/);
    // No price or tax arithmetic, no variant choice.
    expect(all).not.toMatch(/\brate\s*\*|\*\s*quantity|amount\s*[*+-]|isDefault|default_on|reduction/);
    expect(adapter).not.toMatch(/physical_quantity|reserved|visibility|available_for_order|out_of_stock\b/);
  });

  it('depends only on the domain ports, zod and node built-ins', () => {
    const imports = sources.flatMap((s) => [...s.matchAll(/from '([^']+)'/g)].map((m) => m[1]!));
    expect(imports.filter((i) => !/^(zod|@r4-adapters\/domains|node:perf_hooks|\.\/[\w.-]+\.js)$/.test(i))).toEqual([]);
  });
});
