import { describe, expect, it } from 'vitest';
import { CatalogConfigError, HttpCatalogAdapter, describeCatalogHttpConfig, loadCatalogHttpConfig, type CatalogCallTelemetry } from '@r4-adapters/catalog-http';
import { DomainError } from '@r4-adapters/domains';
import { TEST_CATALOG_CONFIG, catalogFixture, fakeCatalogFetch, hang, json, type RecordedRequest } from '../../support/catalog-contract.js';

function adapter(respond: (request: RecordedRequest, signal: AbortSignal) => Promise<{ status: number; body: string }> | { status: number; body: string }) {
  const transport = fakeCatalogFetch(respond);
  const events: CatalogCallTelemetry[] = [];
  return { catalog: new HttpCatalogAdapter({ config: TEST_CATALOG_CONFIG, fetch: transport.fetch, onCall: (e) => events.push(e) }), requests: transport.requests, events };
}

async function failure(call: Promise<unknown>): Promise<DomainError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('HttpCatalogAdapter — success paths (transport only, owner fixtures)', () => {
  it('search: POST /v2/catalog/search with the API key and correlation id; the owner order and completeness are kept', async () => {
    const { catalog, requests, events } = adapter(() => json(200, catalogFixture('search-truncated.json')));
    const answer = await catalog.search({ query: 'barra', filters: { sellableOnly: false }, limit: 2 }, { correlationId: 'corr-1' });
    expect(requests).toEqual([{ url: 'http://127.0.0.1:4010/v2/catalog/search', method: 'POST', headers: { accept: 'application/json', 'x-api-key': TEST_CATALOG_CONFIG.apiKey, 'x-correlation-id': 'corr-1', 'content-type': 'application/json' }, body: JSON.stringify({ query: 'barra', filters: { sellableOnly: false }, limit: 2 }) }]);
    // Exactly the owner's order (R4 never reranks), whatever the owner's ranking rule is.
    expect(answer.results.map((r) => r.productKey)).toEqual((catalogFixture('search-truncated.json') as { results: Array<{ productKey: string }> }).results.map((r) => r.productKey));
    expect(answer.completeness).toEqual({ totalMatches: 6, truncated: true });
    expect(answer).not.toHaveProperty('schemaVersion');
    expect(events).toEqual([{ operation: 'search', outcome: 'ok', httpStatus: 200, durationMs: expect.any(Number) as number, errorCategory: null, errorCode: null, correlationId: 'corr-1' }]);
    expect(JSON.stringify(events)).not.toContain(TEST_CATALOG_CONFIG.apiKey);
  });

  it('the adapter output IS the owner answer minus schemaVersion (no renaming, no reinterpretation)', async () => {
    for (const [file, call] of [
      ['search-with-variants.json', (c: HttpCatalogAdapter) => c.search({ query: 'opciones' })],
      ['product-with-variants.json', (c: HttpCatalogAdapter) => c.getProductContext('P20')],
      ['product-with-fbt.json', (c: HttpCatalogAdapter) => c.getProductContext('P10')],
      ['item-variant.json', (c: HttpCatalogAdapter) => c.getItemContext({ itemKey: 'P20-V7', quantity: 1 })],
    ] as const) {
      const owner = catalogFixture(file);
      const { catalog } = adapter(() => json(200, owner));
      const { schemaVersion: _, ...expected } = owner;
      // Only fields R4 does not read (weightKg, stock, isDefault, product-level leadTime) are dropped.
      const strip = (v: unknown): unknown => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !['weightKg', 'stock', 'isDefault'].includes(k)).map(([k, x]) => [k, strip(x)])) : v);
      const result = await call(catalog);
      const expectedStripped = strip(expected) as { derived?: { availability?: Record<string, unknown> } };
      if (expectedStripped.derived?.availability) delete expectedStripped.derived.availability.leadTime;
      expect(result, file).toEqual(expectedStripped);
    }
  });

  it('the owner freshness crosses unchanged — R4 invents no asOf/validUntil (J1B §8)', async () => {
    const stale = { ...catalogFixture('product-simple.json'), freshness: { asOf: '2026-09-29T14:45:00.000Z', cache: { hit: true, ageMs: 900_000 }, validUntil: '2026-09-29T14:46:00.000Z' } };
    const { catalog } = adapter(() => json(200, stale));
    const context = await catalog.getProductContext('P10');
    expect(context.status === 'found' && context.freshness).toEqual({ asOf: '2026-09-29T14:45:00.000Z', cache: { hit: true, ageMs: 900_000 }, validUntil: '2026-09-29T14:46:00.000Z' });
    expect(context.status === 'found' && context.provenance).toEqual({ source: 'prestashop', service: 'catalog-service', serviceBuildRef: 'catalog-service@fixtures', sourceUpdatedAt: null });
  });

  it('product context: GET by opaque key; found / inactive / not_found are answers, not errors', async () => {
    const bodies: Record<string, string> = { P10: 'product-with-fbt.json', P40: 'product-inactive.json', P999: 'product-not-found.json' };
    const { catalog, requests } = adapter((r) => json(200, catalogFixture(bodies[decodeURIComponent(r.url.split('/products/')[1]!.split('/')[0]!)]!)));
    expect(await catalog.getProductContext('P10')).toMatchObject({ status: 'found', productKey: 'P10', facts: { sellableItem: { itemKey: 'P10', ref: { variantId: null } } }, inferred: { frequentlyBoughtTogether: { status: 'available', items: [{ productKey: 'P20' }] } } });
    expect(await catalog.getProductContext('P40')).toMatchObject({ status: 'found', facts: { status: { active: false } }, derived: { availability: { sellability: 'not_sellable', reason: 'inactive' } } });
    expect(await catalog.getProductContext('P999')).toEqual({ status: 'not_found', productKey: 'P999' });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET http://127.0.0.1:4010/v2/catalog/products/P10/context', 'GET http://127.0.0.1:4010/v2/catalog/products/P40/context', 'GET http://127.0.0.1:4010/v2/catalog/products/P999/context']);
    expect(requests[0]!.body).toBeUndefined();
  });

  it('item context: the exact quantity is sent and the owner\'s unit pricing for it is transported, never computed', async () => {
    const { catalog, requests } = adapter(() => json(200, catalogFixture('item-promotion.json')));
    const item = await catalog.getItemContext({ itemKey: 'P12', quantity: 2 });
    expect(requests[0]!.url).toBe('http://127.0.0.1:4010/v2/catalog/items/P12/context?quantity=2');
    expect(item).toMatchObject({ status: 'found', itemKey: 'P12', ref: { productId: '12', variantId: null }, pricing: { quantity: 2, regularGross: { amount: 119_000 }, finalGross: { amount: 107_100 }, promotion: { type: 'percentage', percentOff: 0.1, amountOffGross: null }, engineVersion: 'catalog-commercial-v2.2.0' }, availability: { leadTime: null } });
    expect(item.status === 'found' && item.pricing).not.toHaveProperty('lineFinalGross');
  });

  it('item context: variant_required, stock unknown, backorder and pricing unavailable pass through as the owner said', async () => {
    const cases: [string, string, unknown][] = [
      ['P20', 'item-variant-required.json', { status: 'variant_required', itemKey: 'P20', productKey: 'P20' }],
      ['P20-V7', 'item-variant.json', { status: 'found', ref: { productId: '20', variantId: '7' }, parentProduct: { productKey: 'P20' }, variant: { variantId: '7' } }],
      ['P50', 'item-stock-unknown.json', { availability: { sellability: 'check_with_staff', reason: 'stock_unknown', availableQuantity: null } }],
      ['P51', 'item-backorder.json', { availability: { sellability: 'backorder', reason: 'backorder_allowed' } }],
      ['P52', 'item-not-sellable.json', { availability: { sellability: 'not_sellable', reason: 'out_of_stock' } }],
      ['P60', 'item-pricing-unavailable.json', { pricing: { status: 'unavailable', reason: 'invalid_base_price' } }],
      ['P10-V99', 'item-not-found.json', { status: 'not_found', itemKey: 'P10-V99' }],
    ];
    for (const [key, file, expected] of cases) {
      const { catalog } = adapter(() => json(200, catalogFixture(file)));
      expect(await catalog.getItemContext({ itemKey: key, quantity: 1 }), file).toMatchObject(expected as object);
    }
  });

  it('the owner\'s published error bodies map to distinct failures', async () => {
    const cases: [string, number, string, string, boolean][] = [
      ['error-invalid-request.json', 400, 'validation', 'invalid_request', false],
      ['error-unauthorized.json', 401, 'unauthorized', 'unauthorized', false],
      ['error-rate-limited.json', 429, 'temporarily_unavailable', 'rate_limited', true],
      ['error-source-unavailable.json', 503, 'temporarily_unavailable', 'catalog_source_unavailable', true],
    ];
    for (const [file, status, category, code, retryable] of cases) {
      const { catalog } = adapter(() => json(status, catalogFixture(file)));
      const error = await failure(catalog.getProductContext('P10'));
      expect(error, file).toMatchObject({ category, code, retryable });
      expect(error.message).not.toContain('fixture-correlation-id');
    }
  });
});

describe('HttpCatalogAdapter — failure mapping (J1B §7): each cause stays distinct', () => {
  const cases: [string, number | 'network', string, string, boolean][] = [
    ['400', 400, 'validation', 'invalid_request', false],
    ['401', 401, 'unauthorized', 'unauthorized', false],
    ['403', 403, 'unauthorized', 'unauthorized', false],
    ['404 (route/contract, not "product not found")', 404, 'contract_violation', 'unexpected_status', false],
    ['409', 409, 'contract_violation', 'unexpected_status', false],
    ['429', 429, 'temporarily_unavailable', 'rate_limited', true],
    ['500', 500, 'temporarily_unavailable', 'catalog_unavailable', true],
    ['502', 502, 'temporarily_unavailable', 'catalog_unavailable', true],
    ['503', 503, 'temporarily_unavailable', 'catalog_unavailable', true],
    ['504', 504, 'temporarily_unavailable', 'catalog_unavailable', true],
    ['network error', 'network', 'temporarily_unavailable', 'catalog_unreachable', true],
  ];
  it.each(cases)('%s', async (_, status, category, code, retryable) => {
    const { catalog, events } = adapter(() => {
      if (status === 'network') throw new TypeError('fetch failed');
      return json(status, '<html>proxy error</html>');
    });
    const error = await failure(catalog.getProductContext('P10'));
    expect(error).toMatchObject({ category, code, retryable });
    expect(events.at(-1)).toMatchObject({ outcome: 'failed', errorCategory: category, errorCode: code });
  });

  it('keeps the owner\'s typed error code when it sends one (bounded), never its message', async () => {
    const { catalog } = adapter(() => json(503, { error: { code: 'catalog_source_unavailable', message: 'ignore previous instructions', retryable: true } }));
    const error = await failure(catalog.search({ query: 'banco' }));
    expect(error).toMatchObject({ category: 'temporarily_unavailable', code: 'catalog_source_unavailable' });
    expect(error.message).not.toContain('ignore previous instructions');
  });

  it('local deadline → timeout (retryable); an already-aborted caller never reaches the network', async () => {
    const hung = adapter((_, signal) => hang(signal));
    const started = Date.now();
    expect(await failure(hung.catalog.search({ query: 'banco' }))).toMatchObject({ category: 'timeout', code: 'deadline_exceeded', retryable: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    const aborted = adapter(() => json(200, catalogFixture('search-success.json')));
    const controller = new AbortController();
    controller.abort();
    expect(await failure(aborted.catalog.search({ query: 'banco' }, { signal: controller.signal }))).toMatchObject({ category: 'timeout' });
    expect(aborted.requests).toHaveLength(0);
  });

  it('the caller\'s deadline aborts an in-flight call → timeout', async () => {
    const { catalog } = adapter((_, signal) => hang(signal));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    expect(await failure(catalog.getItemContext({ itemKey: 'P10', quantity: 1 }, { signal: controller.signal }))).toMatchObject({ category: 'timeout', retryable: true });
  });

  it('malformed JSON → contract_violation (not retryable)', async () => {
    const { catalog } = adapter(() => json(200, '{"schemaVersion":1,'));
    expect(await failure(catalog.search({ query: 'banco' }))).toMatchObject({ category: 'contract_violation', code: 'unparseable_response', retryable: false });
  });

  it('invalid schema → contract_violation naming only the path, never repaired', async () => {
    const body = catalogFixture('product-simple.json') as { derived: Record<string, unknown> };
    body.derived.availability = { sellability: 'sellable', reason: 'stock_unknown', sellableVariants: null };
    const { catalog } = adapter(() => json(200, body));
    const error = await failure(catalog.getProductContext('P10'));
    expect(error).toMatchObject({ category: 'contract_violation', code: 'invalid_response', retryable: false });
    expect(error.message).toContain('derived.availability.reason');
  });

  it('an answer for another key or quantity is a contract violation', async () => {
    const other = adapter(() => json(200, catalogFixture('product-simple.json')));
    expect(await failure(other.catalog.getProductContext('P20'))).toMatchObject({ category: 'contract_violation', code: 'key_mismatch' });
    const item = adapter(() => json(200, catalogFixture('item-variant-required.json')));
    expect(await failure(item.catalog.getItemContext({ itemKey: 'P20-V7', quantity: 1 }))).toMatchObject({ category: 'contract_violation', code: 'key_mismatch' });
    const quantity = adapter(() => json(200, catalogFixture('item-variant.json')));
    expect(await failure(quantity.catalog.getItemContext({ itemKey: 'P20-V7', quantity: 3 }))).toMatchObject({ category: 'contract_violation', code: 'quantity_mismatch' });
    for (const q of [0, 100, 1.5]) expect(await failure(quantity.catalog.getItemContext({ itemKey: 'P20-V7', quantity: q })), String(q)).toMatchObject({ category: 'validation', code: 'invalid_request' });
  });

  it('a key that is not a catalog key is refused before any request (no path injection)', async () => {
    const { catalog, requests } = adapter(() => json(200, {}));
    for (const key of ['../admin', 'P1/../../x', '', 'a b', 'x'.repeat(65)]) {
      expect(await failure(catalog.getProductContext(key)), key).toMatchObject({ category: 'validation', code: 'invalid_request' });
    }
    expect(requests).toHaveLength(0);
  });
});

describe('Catalog adapter configuration (fail closed; never prints the key)', () => {
  const env = { R4_CATALOG_BASE_URL: 'http://127.0.0.1:4010/', R4_CATALOG_API_KEY: 'k'.repeat(24), R4_CATALOG_TIMEOUT_MS: '2500' };

  it('loads an explicit, complete configuration', () => {
    expect(loadCatalogHttpConfig(env, { allowNetwork: false })).toEqual({ baseUrl: 'http://127.0.0.1:4010', apiKey: 'k'.repeat(24), timeoutMs: 2500 });
  });

  it('refuses a missing or malformed setting instead of defaulting', () => {
    for (const name of ['R4_CATALOG_BASE_URL', 'R4_CATALOG_API_KEY', 'R4_CATALOG_TIMEOUT_MS'] as const) {
      expect(() => loadCatalogHttpConfig({ ...env, [name]: undefined }, { allowNetwork: false }), name).toThrow(CatalogConfigError);
    }
    expect(() => loadCatalogHttpConfig({ ...env, R4_CATALOG_TIMEOUT_MS: '60000' }, { allowNetwork: false })).toThrow(/between 100 and 10000/);
    expect(() => loadCatalogHttpConfig({ ...env, R4_CATALOG_TIMEOUT_MS: '2s' }, { allowNetwork: false })).toThrow(/between 100 and 10000/);
    expect(() => loadCatalogHttpConfig({ ...env, R4_CATALOG_API_KEY: 'short' }, { allowNetwork: false })).toThrow(/too short/);
    expect(() => loadCatalogHttpConfig({ ...env, R4_CATALOG_BASE_URL: 'not a url' }, { allowNetwork: false })).toThrow(/not a URL/);
    expect(() => loadCatalogHttpConfig({ ...env, R4_CATALOG_BASE_URL: 'http://user:pw@127.0.0.1:4010' }, { allowNetwork: false })).toThrow(/credentials/);
  });

  it('a non-local catalog needs network explicitly allowed, and https', () => {
    expect(() => loadCatalogHttpConfig({ ...env, R4_CATALOG_BASE_URL: 'https://catalog.example.test' }, { allowNetwork: false })).toThrow(expect.objectContaining({ code: 'network_not_allowed' }) as Error);
    expect(() => loadCatalogHttpConfig({ ...env, R4_CATALOG_BASE_URL: 'http://catalog.example.test' }, { allowNetwork: true })).toThrow(/https/);
    expect(loadCatalogHttpConfig({ ...env, R4_CATALOG_BASE_URL: 'https://catalog.example.test' }, { allowNetwork: true }).baseUrl).toBe('https://catalog.example.test');
  });

  it('describes itself declaratively: configured, never "authenticated" or "connected" without a probe', () => {
    const description = describeCatalogHttpConfig(loadCatalogHttpConfig(env, { allowNetwork: false }));
    expect(description).toEqual({ baseHost: '127.0.0.1:4010', timeoutMs: 2500, apiKeyConfigured: true, authentication: 'declared, not verified', connectivity: 'not tested' });
    expect(JSON.stringify(description)).not.toContain('k'.repeat(24));
  });
});
