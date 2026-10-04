import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRegistry, definitionContentHash, type AgentDefinitionStore } from '@r4/agent-registry';
import { CapabilityInvoker } from '@r4/capability-runtime';
import { systemClock, type RegisteredAgentDefinition } from '@r4/contracts';
import { assertProductionProfile, availableCapabilities, capabilityAvailability, loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { createSilentLogger } from '@r4/observability';
import { FixtureShipping, type CatalogPort } from '@r4-adapters/domains';
import { ProductionShippingAdapter, SHIPPING_ENV, loadShippingHttpConfig, type ShippingFetch } from '@r4-adapters/shipping-http';
import { CAPABILITY_IDS, SALES_AGENT_DEFINITION_FILES, SALES_AGENT_DIR, SALES_AGENT_LATEST_VERSION, loadSalesAgentDefinition } from '@r4-sales/agent';
import {
  SALES_DOMAINS,
  SALES_PRODUCTION_AGENT_VERSIONS,
  SALES_PRODUCTION_PROFILE,
  SALES_PRODUCTION_PROFILE_V2_CANDIDATE,
  SALES_PRODUCTION_PROFILE_V3,
  SALES_PRODUCTION_PROFILE_V3_GATE,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_V3_SHIPPING_BINDING,
  composeSalesProductionWorker,
  salesConversationTaskFactory,
  salesProductionAgentVersion,
  salesShippingPlan,
} from '@r4-sales/agent/production';
import { FakeClock, idsFrom } from '../support/deterministic.js';
import { InMemoryObservationStore } from '../support/memory-observation-store.js';

/**
 * R4-J2D: sales-production@3 = sales-production@2 + Shipping REAL (pc-carrier,
 * read-only) + shipping.quote + Sales definition v4. v1/v2 and Sales v3 are
 * immutable deployed artifacts: their fingerprints are pinned here.
 */
const V1_FINGERPRINT = 'bd30523fba7cd17b2996af8205862e30c6756b4efb812777d00c2a5f9f84d313';
const V2_FINGERPRINT = '2430a3e05c384a61a581707a2d397bcf64a72a703e7e08abbc713535988da3a8';
const V3_FINGERPRINT = '847aa0efda66782e393305d62370b8ab130189d949b4622ca6449da0072a8d95';
const SALES_V3_CONTENT_HASH = '44b5b0935c0c20d0304cc7c41a873e8b31252bce8a3c3df3bce8b64247db462a';
const SALES_V4_CONTENT_HASH = 'c91f0e9da593a30cec1c0294f368cb3f922f2c8a261403e57acf47371aa3f020';

const ROOT = join(import.meta.dirname, '..', '..');
const SHIPPING_FIXTURES = join(ROOT, 'adapters', 'domains', 'shipping', 'http', 'fixtures');
const shippingFixture = (name: string) => readFileSync(join(SHIPPING_FIXTURES, name), 'utf8');
const SHIPPING_ENV_OK = { R4_SHIPPING_MODE: 'real', R4_SHIPPING_BASE_URL: 'https://ms.pesaschile.cl/api/pc-carrier', R4_SHIPPING_TIMEOUT_MS: '5000' };

class MemoryAgentStore implements AgentDefinitionStore {
  readonly rows = new Map<string, RegisteredAgentDefinition>();
  register(definition: RegisteredAgentDefinition) {
    const key = `${definition.agentId}@${definition.version}`;
    const existing = this.rows.get(key);
    if (existing) return Promise.resolve({ stored: existing, inserted: false });
    this.rows.set(key, definition);
    return Promise.resolve({ stored: definition, inserted: true });
  }
  get(agentId: string, version: number) {
    return Promise.resolve(this.rows.get(`${agentId}@${version}`) ?? null);
  }
  getLatest(agentId: string) {
    return Promise.resolve([...this.rows.values()].filter((r) => r.agentId === agentId).sort((a, b) => b.version - a.version)[0] ?? null);
  }
  listLatest() {
    return Promise.resolve([...this.rows.values()]);
  }
}

describe('A. Sales definitions: v3 immutable, v4 independent', () => {
  it('v3 is byte-for-byte the deployed definition; v4 has its own version and fingerprint', () => {
    expect(SALES_AGENT_DEFINITION_FILES).toEqual({ 3: 'sales.agent.json', 4: 'sales.v4.agent.json' });
    expect(loadSalesAgentDefinition(3)).toMatchObject({ agentId: 'sales', version: 3 });
    expect(loadSalesAgentDefinition(4)).toMatchObject({ agentId: 'sales', version: 4 });
    expect(definitionContentHash(loadSalesAgentDefinition(3))).toBe(SALES_V3_CONTENT_HASH);
    expect(definitionContentHash(loadSalesAgentDefinition(4))).toBe(SALES_V4_CONTENT_HASH);
    expect(SALES_AGENT_LATEST_VERSION).toBe(4);
  });

  it('v4 differs from v3 only in its version and the shipping.quote instruction', () => {
    const v3 = readFileSync(join(SALES_AGENT_DIR, 'sales.agent.json'), 'utf8');
    const v4 = readFileSync(join(SALES_AGENT_DIR, 'sales.v4.agent.json'), 'utf8');
    const v3Line = /- shipping\.quote:[^\\]*/.exec(v3)![0];
    const v4Line = /- shipping\.quote:[^\\]*/.exec(v4)![0];
    expect(v4.replace('"version": 4,', '"version": 3,').replace(v4Line, v3Line)).toBe(v3);
    const [d3, d4] = [loadSalesAgentDefinition(3), loadSalesAgentDefinition(4)];
    const { version: _a, instructions: _b, ...rest3 } = d3;
    const { version: _c, instructions: _d, ...rest4 } = d4;
    expect(rest4).toEqual(rest3);
  });

  it('the registry accepts v3 and v4 together, and still refuses an edited v3', async () => {
    const store = new MemoryAgentStore();
    const registry = new AgentRegistry({ store, clock: systemClock, logger: createSilentLogger() });
    expect(await registry.sync([loadSalesAgentDefinition(3), loadSalesAgentDefinition(4)])).toEqual({ registered: ['sales@3', 'sales@4'], unchanged: [] });
    expect(await registry.sync([loadSalesAgentDefinition(3), loadSalesAgentDefinition(4)])).toEqual({ registered: [], unchanged: ['sales@3', 'sales@4'] });
    const edited = { ...loadSalesAgentDefinition(3), description: 'edited without a version bump' };
    await expect(registry.sync([edited])).rejects.toMatchObject({ code: 'agent_definition_version_immutable' });
  });
});

describe('G. Sales v4 instructions', () => {
  it('v4 carries the reference/order semantics; v3 does not', () => {
    const v3 = loadSalesAgentDefinition(3).instructions;
    const v4 = loadSalesAgentDefinition(4).instructions;
    for (const term of ['basis=reference', 'basis=order', 'referenceLowestGross', 'customerGross', 'serviceable=false', 'not a ranking', 'street address is not needed', 'not free shipping', 'never from you']) {
      expect(v4, term).toContain(term);
      expect(v3, term).not.toContain(term);
    }
    expect(v4).not.toMatch(/\bstep\s*\d|\bpaso\s*\d/i);
  });
});

describe('B. profile isolation', () => {
  it('v1 and v2 keep their deployed fingerprints, Shipping UNAVAILABLE and their available capability sets', () => {
    expect(profileFingerprint(SALES_PRODUCTION_PROFILE)).toBe(V1_FINGERPRINT);
    expect(profileFingerprint(SALES_PRODUCTION_PROFILE_V2_CANDIDATE)).toBe(V2_FINGERPRINT);
    for (const p of [SALES_PRODUCTION_PROFILE, SALES_PRODUCTION_PROFILE_V2_CANDIDATE]) expect(p.domains[SALES_DOMAINS.shipping]!.status).toBe('UNAVAILABLE');
    expect(availableCapabilities(SALES_PRODUCTION_PROFILE_V2_CANDIDATE).sort()).toEqual([CAPABILITY_IDS.catalogSearch, CAPABILITY_IDS.productContext, CAPABILITY_IDS.workspaceUpdate].sort());
    expect(capabilityAvailability(SALES_PRODUCTION_PROFILE_V2_CANDIDATE, CAPABILITY_IDS.shippingQuote)).toEqual({ available: false, reason: 'domain_unavailable' });
  });

  it('v3 = v2 + Shipping REAL: same channel, capabilities, writes; shipping.quote becomes a READ on a REAL domain', () => {
    const v3 = assertProductionProfile(SALES_PRODUCTION_PROFILE_V3);
    expect(profileLabel(v3)).toBe('sales-production@3');
    expect(profileFingerprint(v3)).toBe(V3_FINGERPRINT);
    const { [SALES_DOMAINS.shipping]: shipping, ...rest3 } = v3.domains;
    const { [SALES_DOMAINS.shipping]: _s2, ...rest2 } = SALES_PRODUCTION_PROFILE_V2_CANDIDATE.domains;
    expect(rest3).toEqual(rest2);
    expect(shipping).toMatchObject({ status: 'REAL', contractRef: expect.stringContaining('pc-carrier') as string });
    expect(v3.capabilities).toEqual(SALES_PRODUCTION_PROFILE_V2_CANDIDATE.capabilities);
    expect(v3.channel).toEqual(SALES_PRODUCTION_PROFILE_V2_CANDIDATE.channel);
    expect(v3.capabilities.find((c) => c.capabilityId === CAPABILITY_IDS.shippingQuote)).toEqual({ capabilityId: CAPABILITY_IDS.shippingQuote, domain: SALES_DOMAINS.shipping, effect: 'read' });
    expect(capabilityAvailability(v3, CAPABILITY_IDS.shippingQuote)).toEqual({ available: true, reason: 'read_real' });
    expect(availableCapabilities(v3).sort()).toEqual([CAPABILITY_IDS.catalogSearch, CAPABILITY_IDS.productContext, CAPABILITY_IDS.shippingQuote, CAPABILITY_IDS.workspaceUpdate].sort());
    expect(capabilityAvailability(v3, CAPABILITY_IDS.quoteCreate).available).toBe(false);
    expect(v3.capabilities.find((c) => c.capabilityId === CAPABILITY_IDS.quoteCreate)).toMatchObject({ effect: 'write', decision: 'REQUIRE_APPROVAL' });
  });

  it('every profile pins its Sales definition: v1/v2 run v3, v3 runs v4 (never "latest")', () => {
    expect(SALES_PRODUCTION_PROFILES.map(profileLabel)).toEqual(['sales-production@1', 'sales-production@2', 'sales-production@3']);
    expect(SALES_PRODUCTION_AGENT_VERSIONS).toEqual({ 'sales-production@1': 3, 'sales-production@2': 3, 'sales-production@3': 4 });
    expect(SALES_PRODUCTION_PROFILES.map(salesProductionAgentVersion)).toEqual([3, 3, 4]);
    const pool = {} as never;
    expect(salesConversationTaskFactory(pool, 3).request({ bindingId: 'b1', channel: 'whatsapp' })).toMatchObject({ agentId: 'sales', agentVersion: 3 });
    expect(salesConversationTaskFactory(pool, 4).request({ bindingId: 'b1', channel: 'whatsapp' })).toMatchObject({ agentId: 'sales', agentVersion: 4 });
  });

  it('declares the read-only Shipping binding, its env and its deployment gate', () => {
    const b = SALES_PRODUCTION_V3_SHIPPING_BINDING;
    expect(b).toMatchObject({ binding: 'http', endpoints: ['GET /location', 'GET /carrier/v1/all'], authority: { effect: 'read', modelCapabilities: [CAPABILITY_IDS.shippingQuote] }, authentication: expect.stringContaining('none') as string });
    expect(Object.keys(b.requiredEnv).sort()).toEqual([...SHIPPING_ENV].sort());
    expect(SALES_PRODUCTION_PROFILE_V3_GATE.every((g) => g.blocking)).toBe(true);
    expect(SALES_PRODUCTION_PROFILE_V3_GATE.map((g) => g.id)).toContain('explicit-authorization');
  });
});

const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const noStore = { readControls: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const httpCatalog = { bindingKind: 'http', search: () => Promise.reject(new Error('unused')), getProductContext: () => Promise.reject(new Error('unused')), getItemContext: () => Promise.reject(new Error('unused')) } as CatalogPort & { bindingKind: string };

/** The real production adapter over a recording fake owner (captured pc-carrier answers). */
function realShipping() {
  const calls: { url: URL; method: string }[] = [];
  const fetch: ShippingFetch = (url, init) => {
    calls.push({ url: new URL(url), method: init.method });
    const body = new URL(url).pathname.endsWith('/location') ? shippingFixture('location.json') : shippingFixture('quote-nunoa-reference.json');
    return Promise.resolve({ status: new URL(url).pathname.endsWith('/location') ? 200 : 202, text: () => Promise.resolve(body) });
  };
  const adapter = new ProductionShippingAdapter({ config: loadShippingHttpConfig(SHIPPING_ENV_OK, { allowNetwork: true }), fetch });
  return { adapter, calls };
}

function compose(profile: string, bindings: { catalog?: CatalogPort & { bindingKind: string }; shipping?: NonNullable<Parameters<typeof composeSalesProductionWorker>[0]['shipping']> } = {}) {
  return composeSalesProductionWorker({ pool: { query: () => Promise.reject(new Error('no db')) } as never, store: noStore, production: env(profile), modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) }, logger: createSilentLogger(), ...bindings });
}

describe('C. production composition', () => {
  it('v3 composes the real pc-carrier adapter and registers shipping.quote next to the v2 capabilities', () => {
    const { bindings, report } = compose('sales-production@3', { catalog: httpCatalog, shipping: realShipping().adapter });
    expect(bindings.capabilities.list().map((c) => c.capabilityId).sort()).toEqual([CAPABILITY_IDS.catalogSearch, CAPABILITY_IDS.productContext, CAPABILITY_IDS.shippingQuote, CAPABILITY_IDS.workspaceUpdate].sort());
    expect(report).toMatchObject({ profile: 'sales-production@3', profileFingerprint: V3_FINGERPRINT, domains: { catalog: 'REAL', shipping: 'REAL', customer: 'UNAVAILABLE', quote: 'UNAVAILABLE', 'sales-workspace': 'INTERNAL' } });
    expect(report.capabilities.find((c) => c.capabilityId === CAPABILITY_IDS.shippingQuote)).toEqual({ capabilityId: CAPABILITY_IDS.shippingQuote, available: true, reason: 'read_real' });
    expect(report.writes).toEqual({ allow: [CAPABILITY_IDS.workspaceUpdate], requireApproval: [CAPABILITY_IDS.quoteCreate], deny: [] });
    expect(bindings.presence).toEqual({ executionMode: 'production', runtimeProfile: 'sales-production@3' });
  });

  it('v3 fails closed without the pc-carrier binding, with a fixture, or without REAL Catalog', () => {
    expect(() => compose('sales-production@3', { catalog: httpCatalog })).toThrow(/binds Shipping REAL but no pc-carrier binding/);
    expect(() => compose('sales-production@3', { catalog: httpCatalog, shipping: new FixtureShipping() })).toThrow(/no pc-carrier binding/);
    expect(() => compose('sales-production@3', { shipping: realShipping().adapter })).toThrow(/catalog-service binding/);
  });

  it('v2 ignores a provided Shipping binding: capability set and fingerprint unchanged', () => {
    const { bindings, report } = compose('sales-production@2', { catalog: httpCatalog, shipping: realShipping().adapter });
    expect(bindings.capabilities.list().map((c) => c.capabilityId).sort()).toEqual([CAPABILITY_IDS.catalogSearch, CAPABILITY_IDS.productContext, CAPABILITY_IDS.workspaceUpdate].sort());
    expect(report).toMatchObject({ profileFingerprint: V2_FINGERPRINT, domains: { shipping: 'UNAVAILABLE' } });
    expect(compose('sales-production@1', { catalog: httpCatalog, shipping: realShipping().adapter }).bindings.capabilities.list().map((c) => c.capabilityId)).toEqual([CAPABILITY_IDS.workspaceUpdate]);
  });
});

describe('F. read-only safety of the composed Shipping path', () => {
  it('a shipping.quote executed through the v3 composition reaches only GET /location and GET /carrier/v1/all', async () => {
    const shipping = realShipping();
    const { bindings } = compose('sales-production@3', { catalog: httpCatalog, shipping: shipping.adapter });
    const clock = new FakeClock();
    const invoker = new CapabilityInvoker({ registry: bindings.capabilities, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
    const context = { taskId: '0190a0a0-0000-7000-8000-0000000000aa', runId: '0190a0a0-0000-7000-8000-0000000000bb', agentId: 'sales', agentVersion: 4, correlationId: 'c', grantedScopes: ['shipping.read'] };
    const o = await invoker.invoke({ capabilityId: CAPABILITY_IDS.shippingQuote, arguments: { destination: { commune: 'Ñuñoa' }, basis: 'reference' } }, context);
    expect(o).toMatchObject({ outcome: 'succeeded', payload: { destination: { communeName: 'Ñuñoa' }, referenceLowestGross: { amount: 3778 } } });
    expect(shipping.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['GET /api/pc-carrier/location', 'GET /api/pc-carrier/carrier/v1/all']);
  });

  it('no production composition source names an owner mutation route or a generic request', () => {
    const dir = join(ROOT, 'agents', 'sales', 'src', 'production');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const forbidden of ['/shipping/v1', '/sap/', '/shipping-method', 'PcCarrierClient(']) expect(source, `${file}: ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('D. production plan (Shipping section; declarative, nothing sent)', () => {
  it('v3 reports Shipping REAL with non-secret metadata and no authentication', () => {
    expect(salesShippingPlan(SALES_PRODUCTION_PROFILE_V3, SHIPPING_ENV_OK, { allowNetwork: true })).toEqual({ binding: 'REAL', baseHost: 'ms.pesaschile.cl', timeoutMs: 5000, authentication: 'none', connectivity: 'not tested', profile: 'REAL: pc-carrier over HTTP (read-only)' });
  });

  it('v2 reports Shipping UNAVAILABLE even when the env is configured; unset env says so', () => {
    expect(salesShippingPlan(SALES_PRODUCTION_PROFILE_V2_CANDIDATE, SHIPPING_ENV_OK, { allowNetwork: true })).toMatchObject({ binding: 'UNAVAILABLE', profile: 'UNAVAILABLE in this profile (not composed)' });
    expect(salesShippingPlan(SALES_PRODUCTION_PROFILE_V2_CANDIDATE, {}, { allowNetwork: true })).toEqual({ binding: 'not configured (R4_SHIPPING_MODE unset)', profile: 'UNAVAILABLE in this profile (not composed)' });
  });

  it('v3 with an unusable configuration is reported as not usable, never as REAL', () => {
    expect(salesShippingPlan(SALES_PRODUCTION_PROFILE_V3, {}, { allowNetwork: true })).toMatchObject({ binding: expect.stringContaining('not usable') as string });
    expect(salesShippingPlan(SALES_PRODUCTION_PROFILE_V3, SHIPPING_ENV_OK, { allowNetwork: false })).toMatchObject({ configuration: expect.stringContaining('R4_PROD_ALLOW_NETWORK') as string });
  });
});

describe('E. Shipping production config', () => {
  it('accepts the production values and fails closed otherwise', () => {
    expect(loadShippingHttpConfig(SHIPPING_ENV_OK, { allowNetwork: true })).toEqual({ baseUrl: 'https://ms.pesaschile.cl/api/pc-carrier', timeoutMs: 5000 });
    const bad: readonly Record<string, string>[] = [
      { ...SHIPPING_ENV_OK, R4_SHIPPING_BASE_URL: '' },
      { ...SHIPPING_ENV_OK, R4_SHIPPING_BASE_URL: 'not a url' },
      { ...SHIPPING_ENV_OK, R4_SHIPPING_TIMEOUT_MS: '0' },
      { ...SHIPPING_ENV_OK, R4_SHIPPING_TIMEOUT_MS: '-5000' },
      { ...SHIPPING_ENV_OK, R4_SHIPPING_TIMEOUT_MS: 'Infinity' },
      { ...SHIPPING_ENV_OK, R4_SHIPPING_TIMEOUT_MS: '5000.5' },
      { ...SHIPPING_ENV_OK, R4_SHIPPING_MODE: 'fixture' },
      { ...SHIPPING_ENV_OK, R4_SHIPPING_MODE: '' },
    ];
    for (const values of bad) expect(() => loadShippingHttpConfig(values, { allowNetwork: true }), JSON.stringify(values)).toThrow();
  });
});
