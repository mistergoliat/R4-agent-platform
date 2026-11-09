import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { capabilityAvailability, loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS, LANE_CAPABILITY_IDS, SALES_AGENT_DIR, createQuoteParityGuard, loadSalesAgentDefinition, type AutonomousQuoteLimitsV6 } from '@r4-sales/agent';
import {
  SALES_CANARY_ONLY_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_LANE_PROFILES,
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V12,
  SALES_PRODUCTION_PROFILE_V13,
  SALES_PRODUCTION_PROFILE_V14,
  SALES_PRODUCTION_PROFILE_V14_GATE,
  assertF1CanaryWriteCeiling,
  composeSalesProductionWorker,
  salesCatalogSourceOf,
  salesProductionActionPolicy,
  salesProductionAgentVersion,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * R4 Quote V2 + Checkout E2E (owner mandate, 2026-11-06): sales-production@14, the E2 quote lane profile. It is @12's
 * quote issuance (deterministic offer, P-1 parity, F1 ceilings, kill switch) with @13's Catalog V2 and Discover,
 * served only as a lane (ADR-045), running definition v14 (v12 + the v13 Discover line). No customer identity, cart,
 * Checkout or payment capability is reachable.
 */
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const evidence = { schemaVersion: 1, items: [{ itemKey: 'BAR-OLY20', productRef: '105', variantRef: null, sku: 'SC-BO20-28', finalGross: 129_990, availableQuantity: 5, verifiedAt: new Date().toISOString(), source: 'contract-test' }] };
const parity = createQuoteParityGuard({ evidence, maxAgeSeconds: 3600 });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const compose = (options: { limits?: AutonomousQuoteLimitsV6; parity?: boolean; discover?: CatalogDiscoverPort | null } = {}) =>
  composeSalesProductionWorker({
    pool: { query: () => Promise.reject(new Error('no db')) } as never,
    store: noStore,
    production: env('sales-production@14'),
    modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) },
    logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort),
    ...(options.discover === null ? {} : { catalogDiscover: options.discover ?? discover }),
    shipping: http(new FixtureShipping() as ShippingService),
    quotes: http(new FixtureQuoteV2Service() as QuoteV2Service),
    autonomousQuoteLimits: options.limits ?? SALES_F1_CANARY_LIMITS,
    ...(options.parity === false ? {} : { quoteParity: parity }),
  });

describe('A. @14 is @12 with the lane Catalog (V2 + Discover), and a lane profile only', () => {
  const v14 = SALES_PRODUCTION_PROFILE_V14;

  it('domains: @12, with the Catalog domain of @13; capabilities: @12 plus catalog.discover', () => {
    expect(profileLabel(v14)).toBe('sales-production@14');
    expect(v14.domains).toEqual({ ...SALES_PRODUCTION_PROFILE_V12.domains, catalog: SALES_PRODUCTION_PROFILE_V13.domains.catalog });
    expect(v14.capabilities).toEqual([...SALES_PRODUCTION_PROFILE_V12.capabilities, { capabilityId: LANE_CAPABILITY_IDS.catalogDiscover, domain: 'catalog', effect: 'read' }]);
    expect(v14.channel).toEqual(SALES_PRODUCTION_PROFILE_V13.channel);
    expect(capabilityAvailability(v14, CAPABILITY_IDS.quoteCreate).available).toBe(true);
    expect(capabilityAvailability(v14, CAPABILITY_IDS.customerContext).available).toBe(false);
    for (const p of [SALES_PRODUCTION_PROFILE_V12, SALES_PRODUCTION_PROFILE_V13]) expect(profileFingerprint(p)).not.toBe(profileFingerprint(v14));
  });

  it('is selectable only by a worker (lane), never as a production, canary or gateway main profile; pinned to v14; autonomous policy; Catalog V2', () => {
    expect(SALES_LANE_PROFILES.map(profileLabel)).toEqual(['sales-production@13', 'sales-production@14', 'sales-production@15', 'sales-production@16', 'sales-production@17']);
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@14');
    expect(() => selectedSalesProductionProfile(env('sales-production@14').config)).toThrow(/not a Sales production profile/);
    expect(() => selectedSalesProductionProfile(env('sales-production@14').config, { canary: true })).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@14').config, { lane: true })).toBe(v14);
    expect(salesProductionAgentVersion(v14)).toBe(14);
    expect(salesProductionActionPolicy(v14)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(salesCatalogSourceOf(v14)).toBe('v2');
  });

  it('its gate is all blocking and names R1.7, A10 lockstep, the R4 principal, P-1, F-E1-1, L3 and the authorization', () => {
    expect(SALES_PRODUCTION_PROFILE_V14_GATE.every((g) => g.blocking)).toBe(true);
    expect(SALES_PRODUCTION_PROFILE_V14_GATE.map((g) => g.id)).toEqual(expect.arrayContaining(['quote-r17', 'quote-candidate-sha', 'a10-lockstep', 'r4-principal', 'parity-evidence', 'consultation-path', 'l3', 'explicit-authorization']));
  });
});

describe('B. the lane worker composition', () => {
  it('composes Discover and the deterministic offer (quote.preview@3, quote.create@5, workspace.update@2), and nothing of Customer, CIA, cart, Checkout or payment', () => {
    const registry = compose().bindings.capabilities;
    expect(registry.resolve(CAPABILITY_IDS.quoteCreate)!.definition.version).toBe(5);
    expect(registry.resolve(AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview)!.definition.version).toBe(3);
    expect(registry.resolve(CAPABILITY_IDS.workspaceUpdate)!.definition.version).toBe(2);
    expect(registry.resolve(LANE_CAPABILITY_IDS.catalogDiscover)).toBeDefined();
    const ids = registry.list().map((c) => c.capabilityId);
    expect(ids.filter((id) => /customer|identity|checkout|cart|payment/i.test(id))).toEqual([]);
    expect(compose().bindings.servedAgents).toEqual([{ agentId: 'sales', version: 14 }]);
  });

  it('refuses without the P-1 parity guard, without Discover, or with limits looser than the F1 ceilings', () => {
    expect(() => compose({ parity: false })).toThrow(/parity-verified SKU set/);
    expect(() => compose({ discover: null })).toThrow(/requires Catalog V2 Discover/);
    expect(() => compose({ discover: { ...discover, discoverConfigured: false } })).toThrow(/requires Catalog V2 Discover/);
    expect(() => compose({ limits: { ...SALES_F1_CANARY_LIMITS, maxGrossClp: 100_000 } })).not.toThrow();
    for (const key of Object.keys(SALES_F1_CANARY_LIMITS) as (keyof AutonomousQuoteLimitsV6)[]) {
      expect(() => compose({ limits: { ...SALES_F1_CANARY_LIMITS, [key]: SALES_F1_CANARY_LIMITS[key] + 1 } }), key).toThrow(new RegExp(`sales-production@14 runs within .*looser: ${key}=`));
    }
  });

  it('the worker write ceiling is 1..6 for @14 too (0 cannot issue a quote)', () => {
    for (const ok of [1, 6]) expect(() => assertF1CanaryWriteCeiling(ok, 'sales-production@14')).not.toThrow();
    for (const bad of [0, 7]) expect(() => assertF1CanaryWriteCeiling(bad, 'sales-production@14')).toThrow(/sales-production@14 runs with maxWriteActions between 1 and 6/);
  });
});

describe('C. definition v14 = v12 + exactly the v13 Discover line', () => {
  const v12 = loadSalesAgentDefinition(12);
  const v13 = loadSalesAgentDefinition(13);
  const v14 = loadSalesAgentDefinition(14);

  it('adds one line, the very line v13 added, right after the catalog.* line; everything else is v12', () => {
    const lines = v14.instructions.split('\n');
    const added = lines.filter((l) => !v12.instructions.split('\n').includes(l));
    expect(added).toEqual(v13.instructions.split('\n').filter((l) => l.startsWith('- catalog.discover: ')));
    expect(lines[lines.indexOf(added[0]!) - 1]).toMatch(/^- catalog\.\*: /);
    expect(v14.instructions.replace(`${added[0]}\n`, '')).toBe(v12.instructions);
    const { instructions: _a, version: _b, description: _c, ...rest14 } = v14;
    const { instructions: _d, version: _e, description: _f, ...rest12 } = v12;
    expect(rest14).toEqual(rest12);
    expect(v14.instructions).not.toMatch(/customer\.get_context|identity\.|checkout\.|cart\./i);
  });

  it('is a candidate file: the plain bootstrap never registers it, nor makes it "latest"', async () => {
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@14');
    expect(Math.max(...loaded.filter((e) => e.definition.agentId === 'sales').map((e) => e.definition.version))).toBe(8);
  });
});
