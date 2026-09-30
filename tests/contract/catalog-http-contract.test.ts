import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HttpCatalogAdapter, catalogItemContextResponseSchema, catalogProductContextResponseSchema, catalogSearchResponseSchema } from '@r4-adapters/catalog-http';
import { TEST_CATALOG_CONFIG, catalogFixture, catalogFixtureFiles, catalogFixtureHash, catalogFixtureManifest, catalogFixtureText, fakeCatalogFetch, json } from '../support/catalog-contract.js';

/**
 * R4-J1C consumer contract: the Catalog OWNER's published fixtures
 * (unchanged copies, pinned by the owner's MANIFEST.json) are the source of
 * truth for what R4 accepts. Additive evolution is tolerated; a new
 * schemaVersion, a missing or mistyped known field and every contract
 * invariant violation are rejected — never repaired.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const manifest = catalogFixtureManifest();
const answers = manifest.fixtures.filter((f) => f.httpStatus === 200);
const schemaFor = (file: string) => (file.startsWith('search-') ? catalogSearchResponseSchema : file.startsWith('product-') ? catalogProductContextResponseSchema : catalogItemContextResponseSchema);
const clone = <T>(value: T): T => structuredClone(value);

/** Adds an unknown field to every object in the payload (what a newer owner might send). */
function withAdditiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withAdditiveFields);
  if (value !== null && typeof value === 'object') return { ...Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withAdditiveFields(v)])), futureField: { note: 'added by a newer owner' } };
  return value;
}

describe('owner fixtures: one source of truth (catalog-service MANIFEST.json)', () => {
  it('the copies are the owner\'s files, unchanged, and nothing else lives here', () => {
    expect(manifest).toMatchObject({ contract: 'catalog-commercial-v2', schemaVersion: 1, owner: 'MS-pesaschile-catalog-service' });
    for (const f of manifest.fixtures) expect(catalogFixtureHash(catalogFixtureText(f.file)), f.file).toBe(f.sha256);
    // No R4-authored fixture: every file is listed by the owner.
    expect(catalogFixtureFiles()).toEqual(manifest.fixtures.map((f) => f.file).sort());
  });

  it('the sync record names the owner commit the copies came from', () => {
    const source = JSON.parse(catalogFixtureText('SOURCE.json')) as Record<string, unknown>;
    expect(source).toMatchObject({ owner: manifest.owner, contract: manifest.contract, schemaVersion: 1, fixtures: manifest.fixtures.length });
    expect(source.ownerCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof source.ownerContractFilesUncommitted).toBe('boolean');
  });

  it('covers every case the consumer must handle', () => {
    expect(manifest.fixtures.map((f) => `${f.httpStatus} ${f.file}`).sort()).toEqual([
      '200 item-backorder.json', '200 item-not-found.json', '200 item-not-sellable.json', '200 item-pricing-unavailable.json', '200 item-promotion.json', '200 item-simple.json', '200 item-stock-unknown.json', '200 item-variant-required.json', '200 item-variant.json',
      '200 product-inactive.json', '200 product-not-found.json', '200 product-not-listed.json', '200 product-simple.json', '200 product-with-fbt.json', '200 product-with-variants.json',
      '200 search-empty.json', '200 search-success.json', '200 search-truncated.json', '200 search-with-variants.json', '200 search-zero-stock-visible.json',
      '400 error-invalid-request.json', '401 error-unauthorized.json', '429 error-rate-limited.json', '503 error-source-unavailable.json',
    ]);
  });
});

describe('Catalog contract (schemaVersion 1): additive evolution', () => {
  it.each(answers.map((f) => f.file))('%s validates against the adapter schema', (file) => {
    const parsed = schemaFor(file).safeParse(catalogFixture(file));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it.each(answers.map((f) => f.file))('%s: unknown additional fields at every level are tolerated and dropped', (file) => {
    const parsed = schemaFor(file).safeParse(withAdditiveFields(catalogFixture(file)));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    expect(JSON.stringify(parsed.data)).not.toContain('futureField');
  });

  it('a breaking schemaVersion is rejected by the adapter before parsing (contract_violation, not retryable)', async () => {
    for (const version of [2, 0, '1', undefined, null]) {
      const body = { ...catalogFixture('search-success.json'), schemaVersion: version };
      const adapter = new HttpCatalogAdapter({ config: TEST_CATALOG_CONFIG, fetch: fakeCatalogFetch(() => json(200, body)).fetch });
      await expect(adapter.search({ query: 'banco' }), String(version)).rejects.toMatchObject({ category: 'contract_violation', code: 'unsupported_schema_version', retryable: false });
    }
  });

  /** Every leaf path of a payload whose value is not an array element container. */
  function knownPaths(value: unknown, at: (string | number)[] = []): (string | number)[][] {
    if (Array.isArray(value)) return value.length > 0 ? knownPaths(value[0], [...at, 0]) : [];
    if (value === null || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([k, v]) => [[...at, k], ...knownPaths(v, [...at, k])]);
  }
  const unset = (value: unknown, path: (string | number)[], replacement: unknown) => {
    const copy = clone(value) as Record<string | number, unknown>;
    let node = copy;
    for (const segment of path.slice(0, -1)) node = node[segment] as Record<string | number, unknown>;
    const last = path.at(-1)!;
    if (replacement === undefined) delete node[last];
    else node[last] = replacement;
    return copy;
  };
  // Owner fields R4 deliberately does not read (dropped like any unknown field).
  const UNUSED = new Set(['weightKg', 'stock', 'isDefault', 'leadTime']);
  const unused = (path: (string | number)[]) => path.some((p) => typeof p === 'string' && UNUSED.has(p)) && !(path.join('.') === 'availability.leadTime');

  it.each(['search-with-variants.json', 'product-with-fbt.json', 'product-with-variants.json', 'item-promotion.json', 'item-variant.json', 'item-variant-required.json'])('%s: every known field missing or mistyped is rejected (no defaults, no coercion)', (file) => {
    const base = catalogFixture(file);
    const schema = schemaFor(file);
    const paths = knownPaths(base).filter((p) => !unused(p) && p[0] !== 'schemaVersion');
    expect(paths.length).toBeGreaterThan(2);
    for (const path of paths) {
      expect(schema.safeParse(unset(base, path, undefined)).success, `missing ${path.join('.')}`).toBe(false);
      expect(schema.safeParse(unset(base, path, { mistyped: true })).success, `mistyped ${path.join('.')}`).toBe(false);
    }
  });
});

describe('contract invariants are enforced (R4 rejects, never repairs)', () => {
  const rejects = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown, why: string) => expect(schema.safeParse(value).success, why).toBe(false);
  const m = <T>(value: T, fn: (b: T) => void) => {
    const b = clone(value);
    fn(b);
    return b;
  };

  it('search: identity, completeness, price and sellability invariants', () => {
    type R = { results: Record<string, unknown>[]; completeness: Record<string, unknown> } & Record<string, unknown>;
    const base = catalogFixture('search-truncated.json') as R;
    const s = catalogSearchResponseSchema;
    rejects(s, m(base, (b) => { b.results[0]!.variants = { count: 0, requiresSelection: true }; }), 'selection without variants');
    rejects(s, m(base, (b) => { b.results[1]!.priceSummary = { kind: 'from', finalGross: { amount: 1, currency: 'CLP' }, regularGross: { amount: 1, currency: 'CLP' }, discounted: false }; }), '"from" without variants');
    rejects(s, m(base, (b) => { b.completeness = { totalMatches: 6, truncated: false }; }), 'truncated disagrees');
    rejects(s, m(base, (b) => { b.completeness = { totalMatches: 1, truncated: false }; }), 'fewer matches than results');
    rejects(s, m(base, (b) => { b.results[1] = clone(b.results[0]!); }), 'duplicated productKey');
    rejects(s, m(base, (b) => { b.results[0]!.availabilitySummary = { sellability: 'sellable', reason: 'out_of_stock', sellableVariants: 1 }; }), 'sellability/reason');
    rejects(s, m(base, (b) => { b.results[1]!.availabilitySummary = { sellability: 'sellable', reason: 'in_stock', sellableVariants: 1 }; }), 'sellableVariants without variants');
    rejects(s, m(base, (b) => { b.results[1]!.priceSummary = { kind: 'exact', finalGross: { amount: 200, currency: 'CLP' }, regularGross: { amount: 100, currency: 'CLP' }, discounted: false }; }), 'final above regular');
    rejects(s, m(base, (b) => { b.results[1]!.priceSummary = { kind: 'exact', finalGross: { amount: 90, currency: 'CLP' }, regularGross: { amount: 100, currency: 'CLP' }, discounted: false }; }), 'discounted disagrees');
    rejects(s, m(base, (b) => { b.results[1]!.priceSummary = { kind: 'exact', finalGross: { amount: 100, currency: 'USD' }, regularGross: { amount: 100, currency: 'USD' }, discounted: false }; }), 'currency');
    rejects(s, m(base, (b) => { b.results[0]!.productKey = '../admin'; }), 'unsafe key');
    rejects(s, m(base, (b) => { b.freshness = { asOf: '2026-09-29T15:00:00.000Z', cache: { hit: true, ageMs: 10 }, validUntil: '2026-09-29T14:00:00.000Z' }; }), 'validUntil before asOf');
    rejects(s, m(base, (b) => { b.results[0]!.name = 'x'.repeat(129); }), 'name above owner bound');
  });

  it('search identity (R4-J1C): a product-level result carrying only an itemKey is rejected, not reinterpreted', () => {
    const base = catalogFixture('search-with-variants.json') as { results: Record<string, unknown>[] };
    // The pre-J1C owner shape: itemKey (P{id}) + ref.variantId at product level.
    const legacy = m(base, (b) => {
      const r = b.results[0]!;
      r.itemKey = r.productKey;
      delete r.productKey;
      r.ref = { productId: '20', variantId: null };
    });
    rejects(catalogSearchResponseSchema, legacy, 'itemKey at product level');
  });

  it('product context: sellable identity, variant ownership, status and text bounds', () => {
    type P = { facts: Record<string, unknown> & { variantOptions: Record<string, unknown>[] }; derived: Record<string, unknown> } & Record<string, unknown>;
    const simple = catalogFixture('product-simple.json') as P;
    const variants = catalogFixture('product-with-variants.json') as P;
    const s = catalogProductContextResponseSchema;
    rejects(s, m(simple, (b) => { b.facts.sellableItem = null; }), 'simple product without sellable item');
    rejects(s, m(simple, (b) => { b.facts.sellableItem = { itemKey: 'P10-V3', ref: { productId: '10', variantId: '3' } }; }), 'product-level item names a variant');
    rejects(s, m(variants, (b) => { b.facts.sellableItem = { itemKey: 'P20', ref: { productId: '20', variantId: null } }; }), 'P{id} sellable while variants exist');
    rejects(s, m(variants, (b) => { (b.facts.variantOptions[0]!.ref as Record<string, unknown>).variantId = null; }), 'variant option without variantId');
    rejects(s, m(variants, (b) => { (b.facts.variantOptions[0]!.ref as Record<string, unknown>).productId = '999'; }), 'variant of another product');
    rejects(s, m(variants, (b) => { b.facts.variantOptions[1]!.itemKey = b.facts.variantOptions[0]!.itemKey; }), 'duplicated itemKey');
    rejects(s, m(variants, (b) => { (b.derived.availability as Record<string, unknown>).sellableVariants = null; }), 'variants without count');
    rejects(s, m(simple, (b) => { b.facts.status = { active: false, listed: true, orderable: true }; }), 'inactive yet sellable');
    rejects(s, m(simple, (b) => { b.facts.shortDescription = 'x'.repeat(601); }), 'description above bound');
    rejects(s, m(simple, (b) => { b.facts.specifications = Array.from({ length: 41 }, (_, i) => ({ name: `n${i}`, value: 'v' })); }), 'too many specifications');
    rejects(s, m(simple, (b) => { b.derived.priceSummary = { kind: 'from', finalGross: { amount: 1, currency: 'CLP' }, regularGross: { amount: 1, currency: 'CLP' }, discounted: false }; }), '"from" without variants');
    rejects(s, m(simple, (b) => { (b.provenance as Record<string, unknown>).sourceUpdatedAt = 'yesterday'; }), 'bad timestamp');
  });

  it('FBT items are products: an itemKey-only FBT item (pre-J1C shape) is rejected', () => {
    const fbt = catalogFixture('product-with-fbt.json') as { inferred: { frequentlyBoughtTogether: { items: Record<string, unknown>[] } } };
    rejects(catalogProductContextResponseSchema, m(fbt, (b) => { const item = b.inferred.frequentlyBoughtTogether.items[0]!; item.itemKey = item.productKey; delete item.productKey; }), 'FBT itemKey');
    rejects(catalogProductContextResponseSchema, m(fbt, (b) => { b.inferred.frequentlyBoughtTogether.items[0]!.confidence = 3; }), 'confidence outside 0..1');
  });

  it('item context: variant agreement, price ordering, no lead time, tax included', () => {
    const variant = catalogFixture('item-variant.json') as Record<string, unknown> & { variant: Record<string, unknown>; pricing: Record<string, unknown>; availability: Record<string, unknown> };
    const s = catalogItemContextResponseSchema;
    rejects(s, m(variant, (b) => { b.variant.variantId = null; }), 'variant disagrees with ref');
    rejects(s, m(variant, (b) => { b.pricing.finalGross = { amount: 99_999_999, currency: 'CLP' }; }), 'final above regular');
    rejects(s, m(variant, (b) => { b.availability.leadTime = '3 días'; }), 'invented lead time');
    rejects(s, m(variant, (b) => { b.availability.sellability = 'backorder'; }), 'sellability/reason');
    rejects(s, m(variant, (b) => { (b.pricing.tax as Record<string, unknown>).included = false; }), 'tax excluded');
    rejects(s, m(variant, (b) => { b.pricing.lineFinalGross = 1; b.pricing.quantity = 0; }), 'quantity 0');
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
    // No key rewriting: owner keys and data are never split, replaced or re-derived.
    expect(`${adapter}\n${sources[1]!}`).not.toMatch(/\.replace\(|\.split\(|\.slice\(|\.substring\(/);
    expect(adapter).not.toMatch(/physical_quantity|reserved|visibility|available_for_order|out_of_stock\b/);
    // The only mapping is dropping schemaVersion.
    expect(adapter.match(/const \{ schemaVersion: _, \.\.\.\w+ \} = parsed;/g)).toHaveLength(3);
  });

  it('depends only on the domain ports, zod and node built-ins', () => {
    const imports = sources.flatMap((s) => [...s.matchAll(/from '([^']+)'/g)].map((m) => m[1]!));
    expect(imports.filter((i) => !/^(zod|@r4-adapters\/domains|node:perf_hooks|\.\/[\w.-]+\.js)$/.test(i))).toEqual([]);
  });
});
