import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATALOG_V2_DISCOVER_KEY_ENV, CatalogConfigError, DISCOVER_CONTRACT_PIN, HttpCatalogAdapter, catalogDiscoverResponseSchema, describeCatalogHttpConfig, loadCatalogHttpConfig } from '@r4-adapters/catalog-http';
import { DomainError } from '@r4-adapters/domains';
import { catalogDiscoverView } from '../../../agents/sales/src/capabilities/catalog-discover.js';
import { fakeCatalogFetch, json } from '../../support/catalog-contract.js';

/**
 * (ADR-045) Catalog V2 Discover through the existing adapter. The contract is the owner's v1b1 DRAFT pinned by the
 * hashes of its manifest (Catalog 5f2c086); the golden fixtures are an unchanged copy. Real HTTP is the E1 probe.
 */
const FIXTURE = fileURLToPath(new URL('../../../adapters/domains/catalog/http/fixtures/discover/catalog-discover.fixtures.v1b1.json', import.meta.url));
const fixtureText = readFileSync(FIXTURE, 'utf8');
const fixtures = JSON.parse(fixtureText) as {
  contractVersion: string;
  answers: { key: string; httpStatus: number; request: Record<string, unknown>; response: Record<string, unknown> }[];
  errors: { case: string; httpStatus: number; body: unknown }[];
};

const GENERAL = 'k'.repeat(24);
const DISCOVER = 'd'.repeat(24);
const V2_ENV = { R4_CATALOG_V2_BASE_URL: 'http://127.0.0.1:4011', R4_CATALOG_V2_API_KEY: GENERAL, R4_CATALOG_V2_TIMEOUT_MS: '5000' };
const V1_ENV = { R4_CATALOG_BASE_URL: 'http://127.0.0.1:4010', R4_CATALOG_API_KEY: 'j'.repeat(24), R4_CATALOG_TIMEOUT_MS: '2500', [CATALOG_V2_DISCOVER_KEY_ENV]: DISCOVER };

const adapter = (env: Record<string, string>, respond: () => { status: number; body: string }, source: 'v1' | 'v2' = 'v2') => {
  const transport = fakeCatalogFetch(respond);
  return { catalog: new HttpCatalogAdapter({ config: loadCatalogHttpConfig(env, { allowNetwork: false, source }), fetch: transport.fetch }), requests: transport.requests };
};

describe('pinned contract', () => {
  it('the vendored golden fixtures are byte-identical to the owner manifest (sha256, LF)', () => {
    expect(createHash('sha256').update(fixtureText).digest('hex')).toBe(DISCOVER_CONTRACT_PIN.sha256Lf.goldenFixtures);
    expect(fixtures.contractVersion).toBe(DISCOVER_CONTRACT_PIN.contractVersion);
  });

  it('every owner answer parses with R4 tolerant schema', () => {
    expect(fixtures.answers.length).toBe(24);
    for (const a of fixtures.answers.filter((x) => x.httpStatus === 200)) expect(catalogDiscoverResponseSchema.safeParse(a.response).success, a.key).toBe(true);
  });

  it('is tolerant to additive fields and strict on closed enums', () => {
    const base = fixtures.answers.find((a) => a.httpStatus === 200)!.response;
    expect(catalogDiscoverResponseSchema.safeParse({ ...base, futureField: { x: 1 } }).success).toBe(true);
    expect(catalogDiscoverResponseSchema.safeParse({ ...base, status: 'SOMETHING_NEW' }).success).toBe(false);
  });
});

describe('configuration: the Discover key is its own, V2 only', () => {
  it('reads R4_CATALOG_V2_DISCOVER_API_KEY only for v2 and never echoes it', () => {
    const v2 = loadCatalogHttpConfig({ ...V2_ENV, [CATALOG_V2_DISCOVER_KEY_ENV]: DISCOVER }, { allowNetwork: false, source: 'v2' });
    expect(v2.discoverApiKey).toBe(DISCOVER);
    expect(describeCatalogHttpConfig(v2)).toMatchObject({ source: 'v2', discoverKeyConfigured: true });
    expect(JSON.stringify(describeCatalogHttpConfig(v2))).not.toContain(DISCOVER);
    expect(loadCatalogHttpConfig(V1_ENV, { allowNetwork: false })).not.toHaveProperty('discoverApiKey');
    expect(describeCatalogHttpConfig(loadCatalogHttpConfig(V1_ENV, { allowNetwork: false }))).not.toHaveProperty('discoverKeyConfigured');
  });

  it('refuses a short key or the general key reused as the Discover key', () => {
    expect(() => loadCatalogHttpConfig({ ...V2_ENV, [CATALOG_V2_DISCOVER_KEY_ENV]: 'short' }, { allowNetwork: false, source: 'v2' })).toThrow(CatalogConfigError);
    expect(() => loadCatalogHttpConfig({ ...V2_ENV, [CATALOG_V2_DISCOVER_KEY_ENV]: GENERAL }, { allowNetwork: false, source: 'v2' })).toThrow(/not the general R4 key/);
  });
});

describe('adapter.discover', () => {
  const answer = fixtures.answers.find((a) => a.httpStatus === 200)!;

  it('POSTs the contract request with the Discover key (never the general key) and returns the owner answer as sent', async () => {
    const { catalog, requests } = adapter({ ...V2_ENV, [CATALOG_V2_DISCOVER_KEY_ENV]: DISCOVER }, () => json(200, answer.response));
    const result = await catalog.discover({ schemaVersion: 1, need: 'kettlebell', limit: 3 }, { correlationId: 'corr-1' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('http://127.0.0.1:4011/v2/catalog/discover');
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.headers['x-api-key']).toBe(DISCOVER);
    expect(JSON.parse(requests[0]!.body!)).toEqual({ schemaVersion: 1, need: 'kettlebell', limit: 3, context: { correlationId: 'corr-1' } });
    expect(result.requestId).toBe((answer.response as { requestId: string }).requestId);
    expect(result.verified.map((c) => c.productKey)).toEqual((answer.response as { verified: { productKey: string }[] }).verified.map((c) => c.productKey));
  });

  it('is refused locally (no call) on V1, without the Discover key, or for a request outside the contract', async () => {
    const v1 = adapter(V1_ENV, () => json(200, answer.response), 'v1');
    await expect(v1.catalog.discover({ schemaVersion: 1, need: 'kettlebell' })).rejects.toMatchObject({ category: 'unauthorized', code: 'discover_not_configured' });
    const noKey = adapter(V2_ENV, () => json(200, answer.response));
    await expect(noKey.catalog.discover({ schemaVersion: 1, need: 'kettlebell' })).rejects.toMatchObject({ code: 'discover_not_configured' });
    const keyed = adapter({ ...V2_ENV, [CATALOG_V2_DISCOVER_KEY_ENV]: DISCOVER }, () => json(200, answer.response));
    await expect(keyed.catalog.discover({ schemaVersion: 1, need: 'x'.repeat(301) })).rejects.toMatchObject({ category: 'validation' });
    await expect(keyed.catalog.discover({ schemaVersion: 1, need: 'barra', limit: 9 })).rejects.toMatchObject({ category: 'validation' });
    expect([...v1.requests, ...noKey.requests, ...keyed.requests]).toHaveLength(0);
  });

  it('maps the owner errors: 403 names the Discover key, 503 saturated is retryable, invalid body is a contract violation', async () => {
    const env = { ...V2_ENV, [CATALOG_V2_DISCOVER_KEY_ENV]: DISCOVER };
    const forbidden = fixtures.errors.find((e) => e.httpStatus === 403)!;
    const e403 = await adapter(env, () => json(403, forbidden.body)).catalog.discover({ schemaVersion: 1, need: 'kettlebell' }).catch((e: unknown) => e);
    expect(e403).toBeInstanceOf(DomainError);
    expect(e403).toMatchObject({ category: 'unauthorized' });
    expect((e403 as Error).message).toContain(CATALOG_V2_DISCOVER_KEY_ENV);
    const e503 = await adapter(env, () => json(503, { error: { code: 'capability_saturated' } })).catalog.discover({ schemaVersion: 1, need: 'kettlebell' }).catch((e: unknown) => e);
    expect(e503).toMatchObject({ category: 'temporarily_unavailable', code: 'capability_saturated' });
    const bad = await adapter(env, () => json(200, { ...answer.response, verified: 'nope' })).catalog.discover({ schemaVersion: 1, need: 'kettlebell' }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ category: 'contract_violation' });
    const failed = await adapter(env, () => json(200, { ...answer.response, status: 'FAILED' })).catalog.discover({ schemaVersion: 1, need: 'kettlebell' }).catch((e: unknown) => e);
    expect(failed).toMatchObject({ category: 'contract_violation', code: 'failed_answer_as_success' });
  });

  it('discoverConfigured is true only for V2 with the Discover key (what the lane composition requires)', () => {
    const answer200 = () => json(200, answer.response);
    expect(adapter({ ...V2_ENV, [CATALOG_V2_DISCOVER_KEY_ENV]: DISCOVER }, answer200).catalog.discoverConfigured).toBe(true);
    expect(adapter(V2_ENV, answer200).catalog.discoverConfigured).toBe(false);
    expect(adapter(V1_ENV, answer200, 'v1').catalog.discoverConfigured).toBe(false);
  });
});

describe('catalog.discover projection (no ranking, no filtering in R4)', () => {
  it('keeps every candidate in the owner order, for every golden answer', () => {
    for (const a of fixtures.answers.filter((x) => x.httpStatus === 200)) {
      const parsed = catalogDiscoverResponseSchema.parse(a.response);
      const view = catalogDiscoverView(parsed, 'need');
      expect(view.verified.map((c) => c.productKey), a.key).toEqual(parsed.verified.map((c) => c.productKey));
      expect(view.possible.map((c) => c.productKey), a.key).toEqual(parsed.possible.map((c) => c.productKey));
      expect(view.exactMatch?.productKey ?? null, a.key).toBe(parsed.exactMatch?.productKey ?? null);
      expect(view.interpretation?.ambiguities.length ?? 0, a.key).toBe(parsed.interpretation?.ambiguities.length ?? 0);
    }
  });
});
