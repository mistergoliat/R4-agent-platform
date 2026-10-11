import { describe, expect, it } from 'vitest';
import { CatalogConfigError, HttpCatalogDiscoverAdapter, loadCatalogDiscoverConfig, type CatalogDiscoverTelemetry } from '@r4-adapters/catalog-http';
import { CatalogDiscoverError } from '@r4-adapters/domains';
import { TEST_DISCOVER_CONFIG, fakeDiscoverFetch, scenarioFixture } from '../../support/catalog-discover-contract.js';

/** R4-DISCOVER-I1: the catalog.discover HTTP adapter over a fake transport (no live catalog-service). */

const ok = () => ({ status: 200, body: scenarioFixture(3).http.body });

function adapter(respond: Parameters<typeof fakeDiscoverFetch>[0], config = TEST_DISCOVER_CONFIG) {
  const transport = fakeDiscoverFetch(respond);
  const events: CatalogDiscoverTelemetry[] = [];
  return { port: new HttpCatalogDiscoverAdapter({ config, fetch: transport.fetch, onCall: (e) => events.push(e) }), requests: transport.requests, events };
}

const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => e as CatalogDiscoverError);

describe('HttpCatalogDiscoverAdapter — request', () => {
  it('POSTs the owner\'s request shape: schemaVersion 1, the trimmed need, typed constraints, hints, selected units; key and correlation as headers', async () => {
    const { port, requests } = adapter(ok);
    await port.discover({ need: '  máquina para entrenar espalda poco espacio ', limit: 5, constraints: { maxUnitPriceClp: 300_000 }, productKeys: ['P7'], selectedItemKeys: ['P7-V2'] }, { correlationId: 'corr-1' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('http://127.0.0.1:4010/v2/catalog/discover');
    expect(requests[0]!.headers).toMatchObject({ 'x-api-key': TEST_DISCOVER_CONFIG.apiKey, 'x-correlation-id': 'corr-1', 'content-type': 'application/json' });
    expect(requests[0]!.body).toEqual({ schemaVersion: 1, need: 'máquina para entrenar espalda poco espacio', limit: 5, constraints: { maxUnitPriceClp: 300_000 }, hints: { productKeys: ['P7'] }, selectedItemKeys: ['P7-V2'], context: { correlationId: 'corr-1' } });
  });

  it('never sends a field the owner does not define (no identity, no action, no conversation)', async () => {
    const { port, requests } = adapter(ok);
    await port.discover({ need: 'kettlebell', ...({ customerId: 'C1', action: 'reserve', transcript: 'x' } as object) });
    expect(Object.keys(requests[0]!.body).sort()).toEqual(['need', 'schemaVersion']);
  });

  it('drops a correlation id the owner would reject (it is transport context, never data)', async () => {
    const { port, requests } = adapter(ok);
    await port.discover({ need: 'kettlebell' }, { correlationId: 'has spaces & symbols!' });
    expect(requests[0]!.body.context).toBeUndefined();
  });

  it.each([
    ['an empty need', { need: '   ' }, 'need_out_of_bounds'],
    ['a need over 300 characters', { need: 'a'.repeat(301) }, 'need_out_of_bounds'],
    ['limit 9 (never clamped)', { need: 'x', limit: 9 }, 'limit_out_of_range'],
    ['nine product keys', { need: 'x', productKeys: Array.from({ length: 9 }, (_v, i) => `P${i + 1}`) }, 'too_many_keys'],
    ['a key that is not a catalog key', { need: 'x', selectedItemKeys: ['../etc'] }, 'invalid_key'],
  ])('refuses %s locally (nothing is sent)', async (_name, request, code) => {
    const { port, requests } = adapter(ok);
    const error = await caught(port.discover(request));
    expect(error).toMatchObject({ failure: 'INVALID_REQUEST', code, retryable: false });
    expect(requests).toHaveLength(0);
  });
});

describe('HttpCatalogDiscoverAdapter — failures', () => {
  it('maps 401 and 403 (Discover allowlist) to AUTH_FAILED, never retryable, never echoing the key', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden']] as const) {
      const { port, events } = adapter(() => ({ status, body: { error: { code, message: 'no', correlationId: 'c', retryable: false } } }));
      const error = await caught(port.discover({ need: 'kettlebell' }));
      expect(error).toMatchObject({ failure: 'AUTH_FAILED', category: 'unauthorized', code, retryable: false });
      expect(JSON.stringify({ error: { ...error, message: error.message }, events })).not.toContain(TEST_DISCOVER_CONFIG.apiKey);
    }
  });

  it('saturation is reported with Retry-After and never retried by the adapter', async () => {
    const { port, requests } = adapter(() => ({ status: 503, body: { error: { code: 'capability_saturated', message: 'm', correlationId: 'c', retryable: true } }, headers: { 'retry-after': '1' } }));
    const error = await caught(port.discover({ need: 'kettlebell' }));
    expect(error).toMatchObject({ failure: 'SATURATED', retryable: true, details: { retryAfterSeconds: 1, httpStatus: 503 } });
    expect(requests).toHaveLength(1);
  });

  it('a 503 is never read as "no products": disabled, not ready and saturated are distinct', async () => {
    const kinds = [];
    for (const [code, retryable] of [['capability_disabled', false], ['capability_not_ready', true], ['capability_not_ready', false], ['index_incompatible', false]] as const) {
      const { port } = adapter(() => ({ status: 503, body: { error: { code, message: 'm', correlationId: 'c', retryable } } }));
      const error = await caught(port.discover({ need: 'kettlebell' }));
      expect(error.retryable).toBe(retryable);
      kinds.push(error.failure);
    }
    expect(kinds).toEqual(['DISABLED', 'NOT_READY', 'NOT_READY', 'NOT_READY']);
  });

  it('a 500 is a terminal service error; a 503 without an owner envelope stays retryable', async () => {
    expect(await caught(adapter(() => ({ status: 500, body: { error: { code: 'internal_error', message: 'm', correlationId: 'c', retryable: false } } })).port.discover({ need: 'x' }))).toMatchObject({ failure: 'SERVICE_ERROR', retryable: false });
    expect(await caught(adapter(() => ({ status: 502, body: '<html>bad gateway</html>' })).port.discover({ need: 'x' }))).toMatchObject({ failure: 'SERVICE_ERROR', retryable: true });
  });

  it('times out at its own deadline (TIMEOUT, retryable) and honours the caller\'s abort', async () => {
    const hang = (_r: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const slow = adapter(hang, { ...TEST_DISCOVER_CONFIG, timeoutMs: 50 });
    expect(await caught(slow.port.discover({ need: 'kettlebell' }))).toMatchObject({ failure: 'TIMEOUT', category: 'timeout', retryable: true });
    const caller = new AbortController();
    const pending = adapter(hang).port.discover({ need: 'kettlebell' }, { signal: caller.signal });
    caller.abort();
    expect(await caught(pending)).toMatchObject({ failure: 'TIMEOUT' });
  });

  it('an unreachable owner is UNREACHABLE (retryable)', async () => {
    const { port } = adapter(() => { throw new TypeError('fetch failed'); });
    expect(await caught(port.discover({ need: 'kettlebell' }))).toMatchObject({ failure: 'UNREACHABLE', retryable: true });
  });

  it('telemetry carries outcome, status and the need LENGTH only (no text, no keys)', async () => {
    const { port, events } = adapter(ok);
    await port.discover({ need: 'necesito entrenar espalda' }, { correlationId: 'corr-2' });
    expect(events).toEqual([expect.objectContaining({ operation: 'discover', outcome: 'ok', httpStatus: 200, answerStatus: 'COMPLETE', needLength: 25, correlationId: 'corr-2' })]);
    expect(JSON.stringify(events)).not.toMatch(/espalda|r4-discover-test-key/);
  });

  it('is a CatalogDiscoverError (a DomainError) so the capability runtime records a typed failed observation', async () => {
    const error = await caught(adapter(() => ({ status: 429, body: { error: { code: 'rate_limited', message: 'm', correlationId: 'c' } } })).port.discover({ need: 'x' }));
    expect(error).toBeInstanceOf(CatalogDiscoverError);
    expect(error).toMatchObject({ failure: 'RATE_LIMITED', category: 'temporarily_unavailable', retryable: true });
  });
});

describe('loadCatalogDiscoverConfig', () => {
  const base = { R4_CATALOG_BASE_URL: 'http://127.0.0.1:4010', R4_CATALOG_API_KEY: 'r4-catalog-key-000001', R4_CATALOG_TIMEOUT_MS: '2000' };

  it('is OFF by default: no Discover binding unless explicitly enabled', () => {
    expect(loadCatalogDiscoverConfig(base, { allowNetwork: false })).toBeNull();
    expect(loadCatalogDiscoverConfig({ ...base, R4_CATALOG_DISCOVER_ENABLED: 'yes' }, { allowNetwork: false })).toBeNull();
  });

  it('enabled: reuses the Catalog base URL, defaults to a 4500 ms deadline, and may use a dedicated allowlisted key', () => {
    expect(loadCatalogDiscoverConfig({ ...base, R4_CATALOG_DISCOVER_ENABLED: 'true' }, { allowNetwork: false })).toEqual({ baseUrl: 'http://127.0.0.1:4010', apiKey: 'r4-catalog-key-000001', timeoutMs: 4_500 });
    expect(loadCatalogDiscoverConfig({ ...base, R4_CATALOG_DISCOVER_ENABLED: 'true', R4_CATALOG_DISCOVER_API_KEY: 'r4-discover-key-00001', R4_CATALOG_DISCOVER_TIMEOUT_MS: '6000' }, { allowNetwork: false })).toMatchObject({ apiKey: 'r4-discover-key-00001', timeoutMs: 6_000 });
  });

  it('fails closed on a bad deadline, a non-local URL without network permission, or a short key', () => {
    expect(() => loadCatalogDiscoverConfig({ ...base, R4_CATALOG_DISCOVER_ENABLED: 'true', R4_CATALOG_DISCOVER_TIMEOUT_MS: '500' }, { allowNetwork: false })).toThrow(CatalogConfigError);
    expect(() => loadCatalogDiscoverConfig({ ...base, R4_CATALOG_DISCOVER_ENABLED: 'true', R4_CATALOG_BASE_URL: 'https://catalog.example.com' }, { allowNetwork: false })).toThrow(/R4_PROD_ALLOW_NETWORK/);
    expect(() => loadCatalogDiscoverConfig({ ...base, R4_CATALOG_DISCOVER_ENABLED: 'true', R4_CATALOG_DISCOVER_API_KEY: 'short' }, { allowNetwork: false })).toThrow(/too short/);
  });
});
