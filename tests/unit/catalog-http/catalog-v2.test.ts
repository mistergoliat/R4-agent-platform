import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CATALOG_ENV, CATALOG_V2_ENV, CatalogConfigError, HttpCatalogAdapter, describeCatalogHttpConfig, loadCatalogHttpConfig, type CatalogHttpConfig } from '@r4-adapters/catalog-http';
import { DomainError, catalogShortStock } from '@r4-adapters/domains';
import { catalogFixture, catalogFixtureFiles, catalogFixtureManifest, fakeCatalogFetch, json } from '../../support/catalog-contract.js';

/**
 * R4-CATALOG-V2 (CAT-R4-1, CAT-R4-2): Catalog V2 serves the same read contract the adapter already speaks
 * (CAT_V2_R4_J45_HANDOFF §2, §4; owner contracts/catalog/v2 unchanged from d9c63cc to the deployed 5f2c086). These tests
 * run the owner's fixtures through the adapter configured for the V2 source: what R4 keeps, what it drops (pinned),
 * and the commercial semantics a quote depends on. Real-HTTP against V2 is NOT_RUN (EC2 loopback only, not authorized).
 */
const V2_ENV = { R4_CATALOG_V2_BASE_URL: 'http://127.0.0.1:4011', R4_CATALOG_V2_API_KEY: 'k'.repeat(24), R4_CATALOG_V2_TIMEOUT_MS: '5000' };
const V1_ENV = { R4_CATALOG_BASE_URL: 'http://127.0.0.1:4010', R4_CATALOG_API_KEY: 'j'.repeat(24), R4_CATALOG_TIMEOUT_MS: '2500' };
const V2: CatalogHttpConfig = loadCatalogHttpConfig(V2_ENV, { allowNetwork: false, source: 'v2' });

const serving = (status: number, body: unknown) => {
  const transport = fakeCatalogFetch(() => json(status, body));
  return { catalog: new HttpCatalogAdapter({ config: V2, fetch: transport.fetch }), requests: transport.requests };
};
const withoutVersion = (fixture: Record<string, unknown>) => {
  const { schemaVersion: _, ...rest } = fixture;
  return rest;
};
const paths = (value: unknown, prefix = ''): string[] =>
  value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => { const p = Array.isArray(value) ? `${prefix}[]` : prefix ? `${prefix}.${k}` : k; return [p, ...paths(v, p)]; }) : [];
async function through(file: string): Promise<unknown> {
  const fixture = catalogFixture(file);
  const { catalog } = serving(200, fixture);
  if (file.startsWith('search-')) return catalog.search({ query: 'barra' });
  if (file.startsWith('product-')) return catalog.getProductContext(fixture.productKey as string);
  const quantity = (fixture.pricing as { quantity?: number } | undefined)?.quantity ?? (fixture.availability as { requestedQuantity?: number } | undefined)?.requestedQuantity ?? 1;
  return catalog.getItemContext({ itemKey: fixture.itemKey as string, quantity });
}

describe('A. configuration: one adapter, an explicit source, no fallback between sources', () => {
  it('v2 reads only R4_CATALOG_V2_* and says it is v2; the handoff timeout (5000 ms) is accepted', () => {
    expect(CATALOG_V2_ENV).toEqual(['R4_CATALOG_V2_BASE_URL', 'R4_CATALOG_V2_API_KEY', 'R4_CATALOG_V2_TIMEOUT_MS']);
    expect(loadCatalogHttpConfig({ ...V1_ENV, ...V2_ENV }, { allowNetwork: false, source: 'v2' })).toEqual({ source: 'v2', baseUrl: 'http://127.0.0.1:4011', apiKey: V2_ENV.R4_CATALOG_V2_API_KEY, timeoutMs: 5000 });
  });

  it('a missing V2 variable is a refusal even when every V1 variable is present (never a silent fallback to V1)', () => {
    for (const name of CATALOG_V2_ENV) {
      expect(() => loadCatalogHttpConfig({ ...V1_ENV, ...V2_ENV, [name]: undefined }, { allowNetwork: false, source: 'v2' }), name).toThrow(expect.objectContaining({ code: 'catalog_config_incomplete', message: expect.stringContaining(name) as string }) as Error);
    }
  });

  it('the default stays v1 with its exact historical shape and never reads V2 variables', () => {
    expect(loadCatalogHttpConfig({ ...V1_ENV, ...V2_ENV }, { allowNetwork: false })).toEqual({ baseUrl: 'http://127.0.0.1:4010', apiKey: V1_ENV.R4_CATALOG_API_KEY, timeoutMs: 2500 });
    expect(() => loadCatalogHttpConfig(V2_ENV, { allowNetwork: false })).toThrow(CatalogConfigError);
    expect(CATALOG_ENV).toEqual(['R4_CATALOG_BASE_URL', 'R4_CATALOG_API_KEY', 'R4_CATALOG_TIMEOUT_MS']);
  });

  it('the same fail-closed rules apply to V2, naming the V2 variables', () => {
    expect(() => loadCatalogHttpConfig({ ...V2_ENV, R4_CATALOG_V2_API_KEY: 'short' }, { allowNetwork: false, source: 'v2' })).toThrow(/R4_CATALOG_V2_API_KEY is too short/);
    expect(() => loadCatalogHttpConfig({ ...V2_ENV, R4_CATALOG_V2_TIMEOUT_MS: '60000' }, { allowNetwork: false, source: 'v2' })).toThrow(/R4_CATALOG_V2_TIMEOUT_MS must be an integer/);
    expect(() => loadCatalogHttpConfig({ ...V2_ENV, R4_CATALOG_V2_BASE_URL: 'http://k:s@127.0.0.1:4011' }, { allowNetwork: false, source: 'v2' })).toThrow(/must not carry credentials/);
    expect(() => loadCatalogHttpConfig({ ...V2_ENV, R4_CATALOG_V2_BASE_URL: 'https://catalog.example.test' }, { allowNetwork: false, source: 'v2' })).toThrow(expect.objectContaining({ code: 'network_not_allowed' }) as Error);
  });

  it('descriptions carry no secret; v1 descriptions are unchanged, v2 ones say v2', () => {
    const v2 = describeCatalogHttpConfig(V2);
    expect(v2).toEqual({ source: 'v2', baseHost: '127.0.0.1:4011', timeoutMs: 5000, apiKeyConfigured: true, authentication: 'declared, not verified', connectivity: 'not tested' });
    expect(JSON.stringify(v2)).not.toContain(V2_ENV.R4_CATALOG_V2_API_KEY);
    expect(Object.keys(describeCatalogHttpConfig(loadCatalogHttpConfig(V1_ENV, { allowNetwork: false })))).toEqual(['baseHost', 'timeoutMs', 'apiKeyConfigured', 'authentication', 'connectivity']);
  });

  it('calls the V2 base URL with the V2 key in x-api-key, and the three contract endpoints only', async () => {
    const { catalog, requests } = serving(200, catalogFixture('item-simple.json'));
    await catalog.getItemContext({ itemKey: 'P10', quantity: 1 });
    expect(requests[0]).toMatchObject({ url: 'http://127.0.0.1:4011/v2/catalog/items/P10/context?quantity=1', method: 'GET', headers: { 'x-api-key': V2_ENV.R4_CATALOG_V2_API_KEY } });
    const adapter = readFileSync(fileURLToPath(new URL('../../../adapters/domains/catalog/http/src/adapter.ts', import.meta.url)), 'utf8');
    expect(adapter.match(/'\/v2\/catalog\/[^'`$]*|`\/v2\/catalog\/[^`$]*/g)).toEqual(["'/v2/catalog/search", '`/v2/catalog/products/', '`/v2/catalog/items/']);
    expect(adapter).not.toMatch(/discover/i);
  });
});

describe('B. consumer contract: what R4 keeps and what it drops (owner fixtures, contract catalog-commercial-v2)', () => {
  const files = catalogFixtureFiles().filter((f) => /^(item|product|search)-/.test(f));

  it('covers every response fixture of the owner manifest', () => {
    expect(files).toEqual(catalogFixtureManifest().fixtures.map((f) => f.file).filter((f) => /^(item|product|search)-/.test(f)).sort());
  });

  it('item contexts (the unit that is quoted) and search results pass without any loss', async () => {
    for (const file of files.filter((f) => !f.startsWith('product-'))) {
      expect(isDeepStrictEqual(await through(file), withoutVersion(catalogFixture(file))), file).toBe(true);
    }
  });

  // Documented in R4_CATALOG_V2_INTEGRATION.md §6 (V1/V2 matrix, "fields R4 drops"). A new owner field shows up here.
  const DROPPED_FROM_PRODUCT_CONTEXT = ['derived.availability.leadTime', 'facts.stock', 'facts.stock.availableQuantity', 'facts.stock.scope', 'facts.variantOptions[].isDefault'];

  it('product contexts drop exactly the documented summary fields, and nothing else changes', async () => {
    const dropped = new Set<string>();
    for (const file of files.filter((f) => f.startsWith('product-'))) {
      const out = await through(file);
      const kept = new Set(paths(out));
      for (const p of paths(withoutVersion(catalogFixture(file)))) if (!kept.has(p)) dropped.add(p);
    }
    expect([...dropped].sort()).toEqual(DROPPED_FROM_PRODUCT_CONTEXT);
  });
});

describe('C. commercial accuracy through the V2 source (CAT-R4-2)', () => {
  it('price: final and regular gross, tax included, for the requested quantity', async () => {
    const item = (await through('item-simple.json')) as { pricing: { status: string; quantity: number; finalGross: { amount: number }; regularGross: { amount: number }; tax: { included: boolean; rate: number } } };
    expect(item.pricing).toMatchObject({ status: 'available', quantity: 1, finalGross: { amount: 119_000 }, regularGross: { amount: 119_000 }, tax: { included: true, rate: 0.19 } });
  });

  it('promotion: kept with its type, discount and validity; the final price is the owner\'s, never recomputed', async () => {
    const item = (await through('item-promotion.json')) as { pricing: Record<string, unknown> };
    expect(item.pricing).toMatchObject({ quantity: 2, regularGross: { amount: 119_000 }, finalGross: { amount: 107_100 }, promotion: { type: 'percentage', percentOff: 0.1, amountOffGross: null, validUntil: '2026-10-15T03:00:00.000Z' } });
  });

  it('pricing unavailable stays unavailable with its reason (no price is invented)', async () => {
    expect(((await through('item-pricing-unavailable.json')) as { pricing: unknown }).pricing).toEqual({ status: 'unavailable', reason: 'invalid_base_price' });
  });

  it('variants: the variant item keeps its own identity; a product key that needs a variant is answered as variant_required', async () => {
    expect(await through('item-variant.json')).toMatchObject({ itemKey: 'P20-V7', ref: { productId: '20', variantId: '7' }, variant: { sku: 'BAR-20-XL' } });
    expect(await through('item-variant-required.json')).toEqual({ status: 'variant_required', itemKey: 'P20', productKey: 'P20' });
  });

  it('requested quantity: sent to the owner, and an answer for another quantity is refused', async () => {
    const { catalog, requests } = serving(200, catalogFixture('item-promotion.json'));
    await catalog.getItemContext({ itemKey: 'P12', quantity: 2 });
    expect(requests[0]!.url).toContain('quantity=2');
    await expect(serving(200, catalogFixture('item-promotion.json')).catalog.getItemContext({ itemKey: 'P12', quantity: 3 })).rejects.toMatchObject({ category: 'contract_violation', code: 'quantity_mismatch' });
  });

  it('partial coverage: requestedQuantity and stockCoverage are kept; partial stock is never sellable for the whole quantity', async () => {
    const short = (await through('item-insufficient-stock.json')) as { availability: { sellability: string; reason: string; availableQuantity: number; requestedQuantity: number; stockCoverage: string } };
    expect(short.availability).toEqual({ availableQuantity: 4, sellability: 'not_sellable', reason: 'out_of_stock', leadTime: null, requestedQuantity: 5, stockCoverage: 'partial' });
    expect(catalogShortStock(short.availability as Parameters<typeof catalogShortStock>[0], 5)).toBe(4);
    const backorder = (await through('item-insufficient-stock-backorder.json')) as { availability: { sellability: string; stockCoverage: string } };
    expect(backorder.availability).toMatchObject({ sellability: 'backorder', stockCoverage: 'partial' });
  });

  it('stock unknown is check_with_staff, never sellable; zero stock is not_sellable with coverage none', async () => {
    expect(((await through('item-stock-unknown.json')) as { availability: unknown }).availability).toMatchObject({ availableQuantity: null, sellability: 'check_with_staff', reason: 'stock_unknown', stockCoverage: 'unknown' });
    expect(((await through('item-not-sellable.json')) as { availability: unknown }).availability).toMatchObject({ availableQuantity: 0, sellability: 'not_sellable', reason: 'out_of_stock', stockCoverage: 'none' });
  });

  it('disabled products are found, with their status and a not_sellable availability (not "not found")', async () => {
    const inactive = (await through('product-inactive.json')) as { status: string; facts: { status: unknown }; derived: { availability: unknown } };
    expect(inactive.status).toBe('found');
    expect(inactive.facts.status).toEqual({ active: false, listed: true, orderable: true });
    expect(inactive.derived.availability).toMatchObject({ sellability: 'not_sellable', reason: 'inactive' });
    expect(((await through('product-not-listed.json')) as { derived: { availability: unknown } }).derived.availability).toMatchObject({ sellability: 'not_sellable', reason: 'not_listed' });
  });

  it('nonexistent keys are data (HTTP 200 not_found), not errors', async () => {
    expect(await through('item-not-found.json')).toEqual({ status: 'not_found', itemKey: 'P10-V99' });
    expect(await through('product-not-found.json')).toEqual({ status: 'not_found', productKey: 'P999' });
  });

  it('provider errors are errors, never "not found" and never "out of stock"', async () => {
    const manifest = new Map(catalogFixtureManifest().fixtures.map((f) => [f.file, f.httpStatus]));
    const expected: Record<string, { category: string; code: string }> = {
      'error-source-unavailable.json': { category: 'temporarily_unavailable', code: 'catalog_source_unavailable' },
      'error-rate-limited.json': { category: 'temporarily_unavailable', code: 'rate_limited' },
      'error-unauthorized.json': { category: 'unauthorized', code: 'unauthorized' },
      'error-invalid-request.json': { category: 'validation', code: 'invalid_request' },
    };
    for (const [file, outcome] of Object.entries(expected)) {
      const attempt = serving(manifest.get(file)!, catalogFixture(file)).catalog.getItemContext({ itemKey: 'P10', quantity: 1 });
      await expect(attempt, file).rejects.toBeInstanceOf(DomainError);
      await expect(attempt, file).rejects.toMatchObject(outcome);
    }
    await expect(serving(401, catalogFixture('error-unauthorized.json')).catalog.search({ query: 'barra' })).rejects.toThrow(/check R4_CATALOG_V2_API_KEY/);
    // Discover-only saturation codes on a commercial read are still a temporary failure, never data.
    await expect(serving(503, { error: { code: 'capability_saturated', retryable: true } }).catalog.getItemContext({ itemKey: 'P10', quantity: 1 })).rejects.toMatchObject({ category: 'temporarily_unavailable' });
  });

  it('V2 down (unreachable or past the deadline) is a failure of the read: no fallback, no answer', async () => {
    const down = new HttpCatalogAdapter({ config: V2, fetch: () => Promise.reject(new TypeError('fetch failed')) });
    await expect(down.getItemContext({ itemKey: 'P10', quantity: 1 })).rejects.toMatchObject({ category: 'temporarily_unavailable', code: 'catalog_unreachable' });
    const slow = new HttpCatalogAdapter({ config: { ...V2, timeoutMs: 100 }, fetch: (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    await expect(slow.getItemContext({ itemKey: 'P10', quantity: 1 })).rejects.toMatchObject({ category: 'timeout' });
  });

  it('freshness: asOf, validUntil and the cache flag are kept as the owner sent them', async () => {
    expect(((await through('item-simple.json')) as { freshness: unknown }).freshness).toEqual(catalogFixture('item-simple.json').freshness);
  });

  it('the owner fixtures are the published contract the V2 service still serves (manifest pinned to the owner commit)', () => {
    const source = JSON.parse(readFileSync(join(fileURLToPath(new URL('../../../adapters/domains/catalog/http/fixtures', import.meta.url)), 'SOURCE.json'), 'utf8')) as { contract: string; ownerCommit: string };
    expect(source).toMatchObject({ contract: 'catalog-commercial-v2', ownerCommit: 'd9c63ccc0496dadcbee9317c82a610c4815c11d3' });
  });
});
