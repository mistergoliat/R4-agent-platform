import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpCatalogAdapter, catalogItemContextResponseSchema, catalogProductContextResponseSchema, catalogSearchResponseSchema, type CatalogFetch } from '@r4-adapters/catalog-http';
import { DomainError } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { catalogCapabilities } from '@r4-sales/agent';
import { idsFrom } from '../support/deterministic.js';
import { InMemoryObservationStore } from '../support/memory-observation-store.js';

/**
 * R4-J1C real HTTP contract integration: the R4 Catalog adapter against a
 * RUNNING catalog-service (J1A+J1C) — no mock between them. Opt-in (skipped
 * unless the environment names the instances), never production:
 *
 *   R4_CATALOG_IT_BASE_URL        main instance (synthetic PrestaShop-schema DB)
 *   R4_CATALOG_IT_API_KEY         its API key
 *   R4_CATALOG_IT_RATE_LIMITED_URL  instance with RATE_LIMIT_MAX=3
 *   R4_CATALOG_IT_DB_DOWN_URL     instance whose DB port is closed
 *   R4_CATALOG_IT_DB_SILENT_URL   instance whose DB accepts TCP and never answers
 *
 * The only non-owner hop is an explicit fault injector (last test) used to
 * produce a malformed body the real service cannot emit; it forwards to the
 * real service and records what crossed the wire.
 */
const env = process.env;
const BASE = env.R4_CATALOG_IT_BASE_URL;
const KEY = env.R4_CATALOG_IT_API_KEY ?? '';
const nodeFetch: CatalogFetch = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, text: () => response.text() };
};
const adapter = (baseUrl = BASE!, overrides: { apiKey?: string; timeoutMs?: number } = {}) =>
  new HttpCatalogAdapter({ config: { baseUrl, apiKey: overrides.apiKey ?? KEY, timeoutMs: overrides.timeoutMs ?? 3_000 }, fetch: nodeFetch });

async function failure(call: Promise<unknown>): Promise<DomainError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

/** Walks a value and returns the paths of every `key`. */
function pathsOf(value: unknown, key: string, at = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => pathsOf(v, key, `${at}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => [...(k === key ? [`${at}.${k}`] : []), ...pathsOf(v, key, `${at}.${k}`)]);
}

describe.skipIf(!BASE)('R4 Catalog adapter ↔ real catalog-service v2 (local, synthetic DB)', () => {
  it('search: product-level results (productKey, never itemKey), owner order, completeness, owner freshness', async () => {
    const answer = await adapter().search({ query: 'barra', limit: 2 }, { correlationId: 'j1c-it-search' });
    expect(answer.results.length).toBe(2);
    expect(answer.completeness).toEqual({ totalMatches: 3, truncated: true });
    expect(pathsOf(answer, 'itemKey')).toEqual([]);
    for (const r of answer.results) expect(r.productKey).toMatch(/^P\d+$/);
    // Inactive (P40), unlisted (P41) and the excluded internal product (P444) are never offered.
    const all = await adapter().search({ query: 'barra', limit: 10 });
    expect(all.results.map((r) => r.productKey).sort()).toEqual(['P10', 'P12', 'P20']);
    const variants = all.results.find((r) => r.productKey === 'P20')!;
    expect(variants).toMatchObject({ variants: { count: 2, requiresSelection: true }, priceSummary: { kind: 'from' }, availabilitySummary: { sellableVariants: 1 } });
    expect(Date.parse(answer.freshness.validUntil!) - Date.parse(answer.freshness.asOf)).toBe(15_000);
  });

  it('search: zero stock stays visible; sellableOnly is the owner\'s filter; LIKE wildcards are literal; empty is complete', async () => {
    const discs = await adapter().search({ query: 'disco', limit: 10 });
    expect(discs.results.map((r) => [r.productKey, r.availabilitySummary.sellability]).sort()).toEqual([['P50', 'check_with_staff'], ['P51', 'backorder']]);
    expect((await adapter().search({ query: 'disco', filters: { sellableOnly: true }, limit: 10 })).results).toEqual([]);
    expect(await adapter().search({ query: '50%_x', limit: 5 })).toMatchObject({ results: [], completeness: { totalMatches: 0, truncated: false } });
  });

  it('product context: simple / with variants / inactive / not listed / stock unknown / backorder / not found', async () => {
    const c = adapter();
    const simple = await c.getProductContext('P10');
    expect(simple).toMatchObject({ status: 'found', productKey: 'P10', facts: { sellableItem: { itemKey: 'P10', ref: { productId: '10', variantId: null } }, variantOptions: [], specifications: [{ name: 'Largo', value: '220 cm' }] }, derived: { priceSummary: { kind: 'exact', finalGross: { amount: 119_000 } } } });
    const variants = await c.getProductContext('P20');
    expect(variants).toMatchObject({ status: 'found', facts: { sellableItem: null, variantOptions: [{ itemKey: 'P20-V7', ref: { variantId: '7' } }, { itemKey: 'P20-V8', ref: { variantId: '8' } }] }, derived: { priceSummary: { kind: 'from' }, availability: { sellableVariants: 1 } } });
    expect(pathsOf(variants, 'itemKey')).toEqual(['.facts.variantOptions[0].itemKey', '.facts.variantOptions[1].itemKey']);
    expect(await c.getProductContext('P40')).toMatchObject({ status: 'found', facts: { status: { active: false } }, derived: { availability: { sellability: 'not_sellable', reason: 'inactive' } } });
    expect(await c.getProductContext('P41')).toMatchObject({ status: 'found', facts: { status: { listed: false } }, derived: { availability: { reason: 'not_listed' } } });
    expect(await c.getProductContext('P50')).toMatchObject({ derived: { availability: { sellability: 'check_with_staff', reason: 'stock_unknown' } } });
    expect(await c.getProductContext('P51')).toMatchObject({ derived: { availability: { sellability: 'backorder', reason: 'backorder_allowed' } } });
    expect(await c.getProductContext('P999')).toEqual({ status: 'not_found', productKey: 'P999' });
    // The excluded internal product does not exist for R4.
    expect(await c.getProductContext('P444')).toEqual({ status: 'not_found', productKey: 'P444' });
  });

  it('item context: variant_required for P{id} of a product with variants; concrete variants; quantity tiers; not found', async () => {
    const c = adapter();
    expect(await c.getItemContext({ itemKey: 'P20', quantity: 1 })).toEqual({ status: 'variant_required', itemKey: 'P20', productKey: 'P20' });
    expect(await c.getItemContext({ itemKey: 'P20-V7', quantity: 3 })).toMatchObject({ status: 'found', ref: { productId: '20', variantId: '7' }, parentProduct: { productKey: 'P20' }, variant: { variantId: '7' }, pricing: { quantity: 3, finalGross: { amount: 130_900 } }, availability: { sellability: 'sellable', availableQuantity: 2 } });
    expect(await c.getItemContext({ itemKey: 'P20-V8', quantity: 1 })).toMatchObject({ availability: { sellability: 'not_sellable', reason: 'out_of_stock' } });
    // availableQuantity is net of reservations (quantity 4, physical 6, reserved 2).
    expect(await c.getItemContext({ itemKey: 'P10', quantity: 1 })).toMatchObject({ status: 'found', availability: { availableQuantity: 4 } });
    // An unlimited PrestaShop promotion (zero datetimes) is applied by the owner.
    expect(await c.getItemContext({ itemKey: 'P12', quantity: 1 })).toMatchObject({ pricing: { regularGross: { amount: 119_000 }, finalGross: { amount: 107_100 }, promotion: { type: 'percentage', percentOff: 0.1, amountOffGross: null, validUntil: null } } });
    for (const key of ['P10-V7', 'P20-V99', 'P999']) expect(await c.getItemContext({ itemKey: key, quantity: 1 }), key).toEqual({ status: 'not_found', itemKey: key });
  });

  it('every real answer validates against the R4 wire schema (and would with any additive owner field)', async () => {
    const raw = async (path: string, init?: RequestInit) => (await fetch(`${BASE}${path}`, { ...init, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(init?.headers ?? {}) } })).json();
    expect(catalogSearchResponseSchema.safeParse(await raw('/v2/catalog/search', { method: 'POST', body: JSON.stringify({ query: 'barra', limit: 10 }) })).success).toBe(true);
    for (const k of ['P10', 'P12', 'P20', 'P40', 'P41', 'P50', 'P51', 'P999']) expect(catalogProductContextResponseSchema.safeParse(await raw(`/v2/catalog/products/${k}/context`)).success, k).toBe(true);
    for (const k of ['P10', 'P12', 'P20', 'P20-V7', 'P20-V8', 'P50', 'P51', 'P999']) expect(catalogItemContextResponseSchema.safeParse(await raw(`/v2/catalog/items/${k}/context?quantity=2`)).success, k).toBe(true);
  });

  it('Sales capabilities over the real service: the observation is bounded by the owner window (ADR-030)', async () => {
    const registry = new CapabilityRegistry();
    for (const r of catalogCapabilities(adapter())) registry.register(r as never);
    const clock = { now: () => new Date() };
    const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
    const context = { taskId: '0190a0a0-0000-7000-8000-0000000000c1', runId: '0190a0a0-0000-7000-8000-0000000000c2', agentId: 'sales', agentVersion: 1, correlationId: 'j1c-it-cap', grantedScopes: ['catalog.read'] };
    const o = await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P20' } }, context);
    expect(o.outcome).toBe('succeeded');
    const payload = o.payload as { freshness: { validUntil: string } };
    expect(o.validUntil).toBe(new Date(payload.freshness.validUntil).toISOString());
    expect(Date.parse(o.validUntil!) - Date.parse(o.observedAt)).toBeLessThanOrEqual(15_000);
    expect(o.provenance).toMatchObject({ freshness: { bound: 'owner' } });
  });

  it('owner-side failures: 400, 401, 404 (wrong route), unknown key shapes', async () => {
    expect(await failure(adapter().search({ query: 'x' }))).toMatchObject({ category: 'validation', code: 'invalid_request', retryable: false });
    expect(await failure(adapter(BASE, { apiKey: 'wrong-key-0123456789abcdef' }).getProductContext('P10'))).toMatchObject({ category: 'unauthorized', code: 'unauthorized', retryable: false });
    expect(await failure(adapter(`${BASE}/not-a-prefix`).getProductContext('P10'))).toMatchObject({ category: 'contract_violation', code: 'unexpected_status', retryable: false });
    // A key R4's transport pattern admits but the owner does not recognize: the owner refuses it (400), R4 never rewrites it.
    expect(await failure(adapter().getProductContext('P20-V7'))).toMatchObject({ category: 'validation', code: 'invalid_request' });
    expect(await failure(adapter().getItemContext({ itemKey: 'sku.BAR-10', quantity: 1 }))).toMatchObject({ category: 'validation', code: 'invalid_request' });
  });

  it.skipIf(!env.R4_CATALOG_IT_RATE_LIMITED_URL)('429: the owner rate limit is retryable, with its own code', async () => {
    const c = adapter(env.R4_CATALOG_IT_RATE_LIMITED_URL);
    let last: DomainError | null = null;
    for (let i = 0; i < 6 && last === null; i += 1) {
      try {
        await c.getProductContext('P10');
      } catch (error) {
        last = error as DomainError;
      }
    }
    expect(last).toMatchObject({ category: 'temporarily_unavailable', code: 'rate_limited', retryable: true });
  });

  it.skipIf(!env.R4_CATALOG_IT_DB_DOWN_URL)('503: the owner source is down → typed, retryable', async () => {
    expect(await failure(adapter(env.R4_CATALOG_IT_DB_DOWN_URL).getItemContext({ itemKey: 'P10', quantity: 1 }))).toMatchObject({ category: 'temporarily_unavailable', code: 'catalog_source_unavailable', retryable: true });
  });

  it.skipIf(!env.R4_CATALOG_IT_DB_SILENT_URL)('timeout: a hung owner is cut at R4\'s deadline', async () => {
    const started = Date.now();
    expect(await failure(adapter(env.R4_CATALOG_IT_DB_SILENT_URL, { timeoutMs: 500 }).getProductContext('P10'))).toMatchObject({ category: 'timeout', code: 'deadline_exceeded', retryable: true });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  describe('through an explicit fault injector in front of the real service', () => {
    let proxy: Server;
    let proxyUrl = '';
    let mode: 'pass' | 'truncate' = 'pass';
    const seen: { requestHeaders: Record<string, unknown>; responseCorrelationId: unknown; path: string }[] = [];
    beforeAll(async () => {
      const upstream = new URL(BASE!);
      proxy = createServer((req, res) => {
        const forward = httpRequest({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
          const chunks: Buffer[] = [];
          up.on('data', (c: Buffer) => chunks.push(c));
          up.on('end', () => {
            seen.push({ requestHeaders: req.headers, responseCorrelationId: up.headers['x-correlation-id'], path: req.url ?? '' });
            const body = Buffer.concat(chunks);
            res.writeHead(up.statusCode ?? 502, { 'content-type': 'application/json' });
            res.end(mode === 'truncate' ? body.subarray(0, Math.floor(body.length / 2)) : body);
          });
        });
        req.pipe(forward);
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((resolve) => proxy.close(() => resolve())));

    it('auth, correlation id and URL encoding cross the wire as sent; the owner echoes the correlation id', async () => {
      mode = 'pass';
      await adapter(proxyUrl).getItemContext({ itemKey: 'P20-V7', quantity: 2 }, { correlationId: 'j1c-it-corr-7' });
      const last = seen.at(-1)!;
      expect(last.path).toBe('/v2/catalog/items/P20-V7/context?quantity=2');
      expect(last.requestHeaders['x-api-key']).toBe(KEY);
      expect(last.requestHeaders['x-correlation-id']).toBe('j1c-it-corr-7');
      expect(last.responseCorrelationId).toBe('j1c-it-corr-7');
    });

    it('a malformed (truncated) real answer is a non-retryable contract violation, never repaired', async () => {
      mode = 'truncate';
      expect(await failure(adapter(proxyUrl).getProductContext('P20'))).toMatchObject({ category: 'contract_violation', code: 'unparseable_response', retryable: false });
      mode = 'pass';
    });
  });
});
