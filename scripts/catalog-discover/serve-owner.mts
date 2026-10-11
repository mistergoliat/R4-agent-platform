/*
 * R4-DISCOVER-I1 — serves the Catalog OWNER's real HTTP app for a cross-process contract test.
 *
 * Run FROM the catalog-service working directory (imports the owner's code by path; writes nothing there):
 *
 *   cd <MS-pesaschile-catalog-service>
 *   npx tsx <R4>/scripts/catalog-discover/serve-owner.mts [port] [enabled|disabled]
 *
 * What is real: the owner's Fastify app (buildApp: x-api-key authentication, error envelope,
 * rate limit, 413/415), its POST /v2/catalog/discover route, the DiscoverRuntime (flag,
 * allowlist, admission limiter, owner read gate), the OperationalDiscoverService and the J1 v2
 * commercial owner. What is SYNTHETIC: the catalog (the owner's agent-scenario products, held
 * in memory) and the Discover index (built from the owner's synthetic documents). No database,
 * no production data. This is NOT an end-to-end test against a deployed Catalog.
 *
 * Keys: CATALOG_API_KEYS = r4-discover-e2e-key-0001 (Discover-authorized), r4-catalog-only-key-01
 * (authenticated, NOT in CATALOG_DISCOVER_API_KEYS).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const owner = process.cwd();
const port = Number(process.argv[2] ?? 4610);
const mode = process.argv[3] ?? 'enabled';
const DISCOVER_KEY = 'r4-discover-e2e-key-0001';
const CATALOG_ONLY_KEY = 'r4-catalog-only-key-01';

process.env.CATALOG_API_KEYS = `${DISCOVER_KEY},${CATALOG_ONLY_KEY}`;
process.env.API_KEY = DISCOVER_KEY;
process.env.LOG_LEVEL = 'silent';
const imp = (rel: string) => import(pathToFileURL(join(owner, rel)).href);
await imp('tests/setup.ts'); // the owner's test-only environment defaults (no database is contacted)

const { buildApp } = await imp('src/interfaces/http/app.ts');
const { createDiscoverRuntime } = await imp('src/application/catalog/discover-v1b1/discoverRuntime.ts');
const { parseDiscoverConfig } = await imp('src/shared/discoverConfig.ts');
const { memoryDiscoverTelemetry } = await imp('src/application/catalog/discover-v1a/telemetry.ts');
const { syntheticIndex } = await imp('tests/unit/discover-v0/fixtures.ts');
const { memorySource } = await imp('tests/unit/discover-v1a/support.ts');
const { AGENT_DOCUMENTS, AGENT_PRODUCTS } = await imp('tests/contract/discover-agent/scenarios.ts');

const index = syntheticIndex(AGENT_DOCUMENTS, { degraded: [] });
const indexProvider = {
  current: () => index,
  start: async () => undefined,
  stop: () => undefined,
  status: () => ({ state: 'READY', reason: null, projectionBundleId: index.bundleId, activationId: null, sourceExtractionId: index.sourceExtractionId, builtAt: null, buildMs: null, documents: index.documents.size, universe: index.universe.length, degraded: [] }),
};
const source = memorySource(AGENT_PRODUCTS);
const config = parseDiscoverConfig(
  { CATALOG_DISCOVER_ENABLED: mode === 'enabled' ? 'true' : 'false', CATALOG_DISCOVER_SOURCE_DIR: 'synthetic', CATALOG_DISCOVER_API_KEYS: DISCOVER_KEY },
  { apiKeys: [DISCOVER_KEY, CATALOG_ONLY_KEY], dbConnectionLimit: 5 },
);
const runtime = createDiscoverRuntime({
  config,
  projections: { current: () => null, forRequest: () => null },
  owner: source.owner,
  sqlBulkhead: null,
  loadSource: async () => { throw new Error('the synthetic index needs no source'); },
  indexProvider,
  telemetry: memoryDiscoverTelemetry(),
  clock: source.time,
});
const unused = async () => { throw new Error('not served in this test'); };
const repository = new Proxy({}, { get: (_t, name) => (name === 'ping' ? async () => undefined : unused) });
const app = await buildApp({
  service: { searchProducts: unused, getProduct: unused, batchGetProducts: unused },
  repository,
  readyCheck: async () => ({ database: 'ok', redis: 'ok' }),
  discoverRuntime: runtime,
});
await runtime.start?.();
await app.listen({ host: '127.0.0.1', port });
process.stdout.write(`${JSON.stringify({ listening: `http://127.0.0.1:${port}`, mode, readiness: runtime.readiness().state })}\n`);
const stop = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
