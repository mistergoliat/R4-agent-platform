import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpCatalogDiscoverAdapter, loadCatalogDiscoverConfig } from '@r4-adapters/catalog-http';
import { type CatalogDiscoverError, type CatalogDiscoverRequest } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { catalogDiscoverCapability, type CatalogDiscoverView } from '@r4-sales/agent';
import { DISCOVER_OWNER_AS_OF, discoverFixture, discoverManifest, fixedDiscover, turnFixture, type DiscoverFixture } from '../support/catalog-discover-contract.js';
import { FakeClock, idsFrom } from '../support/deterministic.js';
import { InMemoryObservationStore } from '../support/memory-observation-store.js';

/**
 * R4-DISCOVER-I1 — CROSS-PROCESS contract test: R4's real HTTP adapter and capability against the
 * Catalog OWNER's real HTTP app and Discover runtime (scripts/catalog-discover/serve-owner.mts),
 * over real TCP. The owner's catalog and index are SYNTHETIC (no database): this is NOT an
 * end-to-end test against a deployed Catalog (REAL_CATALOG_E2E stays NOT_RUN).
 *
 * Runs only when R4_DISCOVER_OWNER_REPO points at a catalog-service checkout (its node_modules
 * installed); otherwise the suite is reported as skipped.
 */
const OWNER_REPO = process.env.R4_DISCOVER_OWNER_REPO;
const SERVE = fileURLToPath(new URL('../../scripts/catalog-discover/serve-owner.mts', import.meta.url));
const DISCOVER_KEY = 'r4-discover-e2e-key-0001';
const CATALOG_ONLY_KEY = 'r4-catalog-only-key-01';
const ENABLED_PORT = 4612;
const DISABLED_PORT = 4613;

const servers: ChildProcess[] = [];

function serve(port: number, mode: 'enabled' | 'disabled'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(`npx tsx "${SERVE}" ${port} ${mode}`, { cwd: OWNER_REPO, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(child);
    let out = '';
    const timer = setTimeout(() => reject(new Error(`owner server did not start: ${out}`)), 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('"listening"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); if (!out.includes('"listening"')) reject(new Error(`owner server exited ${code}: ${out}`)); });
  });
}

const adapter = (port: number, apiKey = DISCOVER_KEY) => {
  const config = loadCatalogDiscoverConfig({ R4_CATALOG_DISCOVER_ENABLED: 'true', R4_CATALOG_BASE_URL: `http://127.0.0.1:${port}`, R4_CATALOG_API_KEY: apiKey.padEnd(16, '0'), R4_CATALOG_TIMEOUT_MS: '2000' }, { allowNetwork: false })!;
  return new HttpCatalogDiscoverAdapter({ config: { ...config, apiKey }, fetch: (url, init) => fetch(url, init) });
};
const withoutRequestId = (body: Record<string, unknown>) => ({ ...body, requestId: 'X' });
const portRequest = (owner: Record<string, unknown>): CatalogDiscoverRequest => {
  const { schemaVersion: _, hints, ...rest } = owner as { schemaVersion: 1; hints?: { productKeys: string[] } } & Record<string, unknown>;
  return { ...(rest as unknown as CatalogDiscoverRequest), ...(hints ? { productKeys: hints.productKeys } : {}) };
};
/** The fixture read through the same R4 adapter (fake transport): both sides parsed identically. */
const recorded = async (fixture: DiscoverFixture) => JSON.parse(JSON.stringify(await fixedDiscover({ status: 200, body: fixture.http.body }).port.discover(portRequest(fixture.request)))) as Record<string, unknown>;
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => e as CatalogDiscoverError);

describe.skipIf(!OWNER_REPO)('catalog.discover across processes: R4 adapter ↔ Catalog owner HTTP app (synthetic catalog)', () => {
  beforeAll(async () => {
    await Promise.all([serve(ENABLED_PORT, 'enabled'), serve(DISABLED_PORT, 'disabled')]);
  }, 90_000);

  afterAll(() => {
    for (const child of servers) if (child.pid) spawnSync(process.platform === 'win32' ? `taskkill /pid ${child.pid} /T /F` : `kill -TERM -${child.pid}`, { shell: true });
  });

  it('the five R4 turns: the owner answers over HTTP exactly what the vendored fixtures record', async () => {
    const port = adapter(ENABLED_PORT);
    for (const turn of [1, 2, 3, 4, 5]) {
      const fixture = turnFixture(turn);
      const answer = await port.discover(portRequest(fixture.request));
      expect(withoutRequestId(JSON.parse(JSON.stringify(answer))), `turn ${turn}`).toEqual(withoutRequestId(await recorded(fixture)));
    }
  });

  it('owner scenarios served by the default synthetic catalog match their fixtures over HTTP', async () => {
    const port = adapter(ENABLED_PORT);
    const served = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 21, 23];
    for (const id of served) {
      const fixture = discoverFixture(discoverManifest().scenarios.find((s) => s.id === id)!.file);
      const answer = await port.discover(portRequest(fixture.request));
      expect(withoutRequestId(JSON.parse(JSON.stringify(answer))), `scenario ${id}`).toEqual(withoutRequestId(await recorded(fixture)));
    }
  });

  it('authentication and authorization: unknown key → 401, authenticated key outside the Discover allowlist → 403', async () => {
    expect(await caught(adapter(ENABLED_PORT, 'not-a-service-key-000').discover({ need: 'kettlebell' }))).toMatchObject({ failure: 'AUTH_FAILED', code: 'unauthorized', retryable: false, details: { httpStatus: 401 } });
    expect(await caught(adapter(ENABLED_PORT, CATALOG_ONLY_KEY).discover({ need: 'kettlebell' }))).toMatchObject({ failure: 'AUTH_FAILED', code: 'forbidden', retryable: false, details: { httpStatus: 403 } });
  });

  it('a disabled capability is DISABLED (503, not retryable), never "no products"', async () => {
    expect(await caught(adapter(DISABLED_PORT).discover({ need: 'kettlebell' }))).toMatchObject({ failure: 'DISABLED', code: 'capability_disabled', retryable: false, details: { httpStatus: 503 } });
  });

  it('customer data the R4 guard does not catch is still refused by the owner (400 PERSONAL_DATA), without echo', async () => {
    const error = await caught(adapter(ENABLED_PORT).discover({ need: 'kettlebell para ana@example.com' }));
    expect(error).toMatchObject({ failure: 'INVALID_REQUEST', retryable: false, details: { httpStatus: 400 } });
    expect(String(error.details.issues)).toContain('PERSONAL_DATA');
    expect(JSON.stringify(error.details)).not.toContain('ana@example');
  });

  it('the whole capability chain (invoker → guard → workspace coherence → adapter → owner → view) over TCP', async () => {
    const clock = new FakeClock(DISCOVER_OWNER_AS_OF);
    const registry = new CapabilityRegistry();
    const workspaces = { workspace: () => Promise.resolve({ state: { facts: { budget: { value: { amount: 300_000, currency: 'CLP' }, statedBy: 'customer' as const, note: null, sinceVersion: 1, updatedAt: DISCOVER_OWNER_AS_OF } }, delivery: null, items: [] } }) };
    registry.register(catalogDiscoverCapability({ discover: adapter(ENABLED_PORT), workspaces, now: () => clock.now() }) as never);
    const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
    const o = await invoker.invoke({ capabilityId: 'catalog.discover', arguments: { need: 'máquina para entrenar espalda', useContext: 'poco espacio', constraints: { maxUnitPriceClp: 300_000 }, limit: 8 } },
      { taskId: '0190a0a0-0000-7000-8000-0000000000aa', runId: '0190a0a0-0000-7000-8000-0000000000bb', agentId: 'sales', agentVersion: 1, correlationId: 'corr-i1-e2e', grantedScopes: ['catalog.read'] });
    expect(o.outcome).toBe('succeeded');
    const view = o.payload as CatalogDiscoverView;
    expect(view.candidates.map((c) => c.productKey)).toEqual(['P7', 'P6']);
    expect(view.interpretation.structuredApplied).toEqual(['price<=300000CLP']);
    expect(view.request.budgetFromWorkspace).toBe('budget');
  });
});
