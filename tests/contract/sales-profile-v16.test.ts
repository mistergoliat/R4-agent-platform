import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { SALES_AGENT_DIR, createQuoteParityGuard, loadSalesAgentDefinition } from '@r4-sales/agent';
import { CANARY_PROFILES } from '@r4-sales/agent/canary';
import {
  SALES_CANARY_ONLY_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_LANE_PROFILES,
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V14,
  SALES_PRODUCTION_PROFILE_V16,
  SALES_PRODUCTION_PROFILE_V16_GATE,
  composeSalesProductionWorker,
  isQuoteLaneProfile,
  salesCatalogSourceOf,
  salesProductionActionPolicy,
  salesProductionAgentVersion,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * F-WA-1 (owner mandate «R4 — PR #55 Final Acceptance» §C, 2026-11-09): sales-production@16 is exactly @14 running
 * definition v16 = v14 + one quantity-availability rule. @14 itself is not changed; no capability is added.
 */
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const parity = createQuoteParityGuard({ evidence: { schemaVersion: 1, items: [{ itemKey: 'BAR-OLY20', productRef: '105', variantRef: null, sku: 'SC-BO20-28', finalGross: 129_990, availableQuantity: 5, verifiedAt: new Date().toISOString(), source: 'contract-test' }] }, maxAgeSeconds: 3600 });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const compose = (profile: string, withParity = true) =>
  composeSalesProductionWorker({
    pool: { query: () => Promise.reject(new Error('no db')) } as never,
    store: noStore,
    production: env(profile),
    modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) },
    logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort),
    catalogDiscover: discover,
    shipping: http(new FixtureShipping() as ShippingService),
    quotes: http(new FixtureQuoteV2Service() as QuoteV2Service),
    autonomousQuoteLimits: SALES_F1_CANARY_LIMITS,
    ...(withParity ? { quoteParity: parity } : {}),
  });

describe('A. @16 is @14 with definition v16, a lane (and isolated canary) profile only', () => {
  const v16 = SALES_PRODUCTION_PROFILE_V16;
  it('same domains, channel and capabilities as @14; its own version and fingerprint; @14 unchanged', () => {
    expect(v16.version).toBe(16);
    expect(v16.domains).toEqual(SALES_PRODUCTION_PROFILE_V14.domains);
    expect(v16.channel).toEqual(SALES_PRODUCTION_PROFILE_V14.channel);
    expect(v16.capabilities).toEqual(SALES_PRODUCTION_PROFILE_V14.capabilities);
    expect(profileFingerprint(v16)).not.toBe(profileFingerprint(SALES_PRODUCTION_PROFILE_V14));
    expect(SALES_PRODUCTION_PROFILE_V14.version).toBe(14);
    expect(salesProductionAgentVersion(SALES_PRODUCTION_PROFILE_V14)).toBe(14);
  });

  it('lane and canary only (never production, canary-only or gateway main); pinned to v16; autonomous policy; Catalog V2; quote-lane ceilings', () => {
    expect(SALES_LANE_PROFILES.map(profileLabel)).toContain('sales-production@16');
    expect(CANARY_PROFILES.map(profileLabel)).toContain('sales-production@16');
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@16');
    expect(() => selectedSalesProductionProfile(env('sales-production@16').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@16').config, { lane: true })).toBe(v16);
    expect(salesProductionAgentVersion(v16)).toBe(16);
    expect(salesProductionActionPolicy(v16)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(salesCatalogSourceOf(v16)).toBe('v2');
    expect(isQuoteLaneProfile(v16)).toBe(true);
    expect(SALES_PRODUCTION_PROFILE_V16_GATE.every((g) => g.blocking)).toBe(true);
  });

  it('composes exactly the capabilities of @14, pinned to sales@16, and still requires the P-1 parity guard', () => {
    const ids = (profile: string) => compose(profile).bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();
    expect(ids('sales-production@16')).toEqual(ids('sales-production@14'));
    expect(compose('sales-production@16').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 16 }]);
    expect(() => compose('sales-production@16', false)).toThrow(/parity-verified SKU set/);
  });
});

describe('B. definition v16 = v14 + exactly the quantity-availability rule', () => {
  const v14 = loadSalesAgentDefinition(14);
  const v16 = loadSalesAgentDefinition(16);
  it('adds one line right after the observations rule; everything else is v14', () => {
    const lines = v16.instructions.split('\n');
    const added = lines.filter((l) => !v14.instructions.split('\n').includes(l));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^- Quantity availability: .*never how many units are in stock.*confirmed only by quote\.preview/);
    expect(lines[lines.indexOf(added[0]!) - 1]).toMatch(/^- Products, specifications, prices, stock, shipping costs and quotes exist for you only through observations/);
    expect(v16.instructions.replace(`${added[0]}\n`, '')).toBe(v14.instructions);
    const { instructions: _a, version: _b, description: _c, ...rest16 } = v16;
    const { instructions: _d, version: _e, description: _f, ...rest14 } = v14;
    expect(rest16).toEqual(rest14);
  });

  it('is a candidate file: the plain bootstrap never registers it', async () => {
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@16');
  });
});
