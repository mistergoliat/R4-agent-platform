import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { SALES_F1_CANARY_LIMITS, composeSalesProductionWorker } from '@r4-sales/agent/production';

/**
 * The descriptive freshness switch reaches ONE thing: the Sales workspace context source. Every capability — the
 * catalog reads with their owner validity (ADR-030), quote.preview and quote.create with their own Catalog re-reads,
 * price and promotion checks — is registered identically with the switch on and off.
 */
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const composed = (profile: string, catalogDescriptiveWindowMs: number | null) =>
  composeSalesProductionWorker({
    pool: { query: () => Promise.reject(new Error('no db')) } as never,
    store: noStore,
    production: loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' }),
    modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) },
    logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort),
    catalogDiscover: discover,
    shipping: http(new FixtureShipping() as ShippingService),
    quotes: http(new FixtureQuoteV2Service() as QuoteV2Service),
    autonomousQuoteLimits: SALES_F1_CANARY_LIMITS,
    catalogDescriptiveWindowMs,
  });

describe('catalog descriptive freshness: composition boundary', () => {
  for (const profile of ['sales-production@19', 'sales-production@21', 'sales-production@22']) {
    it(`${profile}: same capabilities (quote.preview and quote.create included), same definitions, same policy, on or off`, () => {
      const off = composed(profile, null).bindings;
      const on = composed(profile, 300_000).bindings;
      const ids = off.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`);
      expect(ids).toEqual(expect.arrayContaining([expect.stringMatching(/^quote\.preview@/u), expect.stringMatching(/^quote\.create@/u), expect.stringMatching(/^catalog\.get_product_context@/u), 'catalog.discover@1']));
      expect(on.capabilities.list()).toEqual(off.capabilities.list());
      expect(on.actionPolicy).toBe(off.actionPolicy);
      expect(on.contextSources?.map((s) => s.id)).toEqual(off.contextSources?.map((s) => s.id));
      expect(on.servedAgents).toEqual(off.servedAgents);
    });
  }
});
