import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { createQuoteParityGuard, productContextOutput, productContextView, productContextWithVariantAvailability } from '@r4-sales/agent';
import { CANARY_PROFILES } from '@r4-sales/agent/canary';
import {
  SALES_CANARY_ONLY_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_LANE_PROFILES,
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V16,
  SALES_PRODUCTION_PROFILE_V17,
  SALES_PRODUCTION_PROFILE_V17_GATE,
  SALES_VARIANT_AVAILABILITY_PROFILES,
  composeSalesProductionWorker,
  isQuoteLaneProfile,
  salesCatalogSourceOf,
  salesProductionActionPolicy,
  salesProductionAgentVersion,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * O-2 (owner mandate «R4 — F-WA-1 acceptance and F-WA-2 decision» §D, 2026-11-09): sales-production@17 is exactly @16
 * except that catalog.get_product_context@2 reports each variant's sellability for one unit, read from the owner's
 * item context. No quantity is exposed; an unreadable variant is unknown. @16 and every other profile keep @1.
 */
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const parity = createQuoteParityGuard({ evidence: { schemaVersion: 1, items: [{ itemKey: 'BAR-OLY20', productRef: '105', variantRef: null, sku: 'SC-BO20-28', finalGross: 129_990, availableQuantity: 5, verifiedAt: new Date().toISOString(), source: 'contract-test' }] }, maxAgeSeconds: 3600 });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const compose = (profile: string) =>
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
    quoteParity: parity,
  });
const call = { signal: new AbortController().signal, correlationId: 'o2-contract' };
const variantsOf = (view: Awaited<ReturnType<typeof productContextWithVariantAvailability>>) => (view.status === 'found' ? view.facts.variantOptions.map((o) => ({ itemKey: o.itemKey, availability: o.availability })) : null);

describe('A. @17 is @16 with catalog.get_product_context@2, a lane (and isolated canary) profile only', () => {
  const v17 = SALES_PRODUCTION_PROFILE_V17;
  it('same domains, channel and declared capabilities as @16; its own version and fingerprint; runs definition v16', () => {
    expect(v17.version).toBe(17);
    expect(v17.domains).toEqual(SALES_PRODUCTION_PROFILE_V16.domains);
    expect(v17.channel).toEqual(SALES_PRODUCTION_PROFILE_V16.channel);
    expect(v17.capabilities).toEqual(SALES_PRODUCTION_PROFILE_V16.capabilities);
    expect(profileFingerprint(v17)).not.toBe(profileFingerprint(SALES_PRODUCTION_PROFILE_V16));
    expect(salesProductionAgentVersion(v17)).toBe(16);
    expect([...SALES_VARIANT_AVAILABILITY_PROFILES]).toEqual(['sales-production@17', 'sales-production@18', 'sales-production@19']);
  });

  it('lane and canary only (never production, canary-only or gateway main); autonomous policy; Catalog V2; quote-lane ceilings', () => {
    expect(SALES_LANE_PROFILES.map(profileLabel)).toContain('sales-production@17');
    expect(CANARY_PROFILES.map(profileLabel)).toContain('sales-production@17');
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@17');
    expect(() => selectedSalesProductionProfile(env('sales-production@17').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@17').config, { lane: true })).toBe(v17);
    expect(salesProductionActionPolicy(v17)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(salesCatalogSourceOf(v17)).toBe('v2');
    expect(isQuoteLaneProfile(v17)).toBe(true);
    expect(SALES_PRODUCTION_PROFILE_V17_GATE.every((g) => g.blocking)).toBe(true);
  });

  it('composes the capabilities of @16 except catalog.get_product_context@2; @16 keeps @1', () => {
    const ids = (profile: string) => compose(profile).bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();
    const v16 = ids('sales-production@16');
    expect(v16).toContain('catalog.get_product_context@1');
    expect(ids('sales-production@17')).toEqual(v16.map((id) => (id === 'catalog.get_product_context@1' ? 'catalog.get_product_context@2' : id)).sort());
    expect(compose('sales-production@17').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 16 }]);
  });
});

describe('B. per-variant availability: the owner\'s sellability for one unit, never a quantity', () => {
  it('reports each variant as the owner evaluates it (KB-COMP: 12 kg in stock, 16 kg out of stock, 24 kg in stock)', async () => {
    const view = await productContextWithVariantAvailability(new FixtureCatalog(), 'KB-COMP', call);
    expect(productContextOutput.parse(view)).toEqual(view);
    expect(variantsOf(view)).toEqual([
      { itemKey: 'KB-COMP-12', availability: { status: 'reported', forQuantity: 1, sellability: 'sellable', reason: 'in_stock' } },
      { itemKey: 'KB-COMP-16', availability: { status: 'reported', forQuantity: 1, sellability: 'not_sellable', reason: 'out_of_stock' } },
      { itemKey: 'KB-COMP-24', availability: { status: 'reported', forQuantity: 1, sellability: 'sellable', reason: 'in_stock' } },
    ]);
    expect(JSON.stringify(view)).not.toMatch(/availableQuantity|stockCoverage|requestedQuantity/);
  });

  it('keeps the owner\'s unknown (stock_unknown) and marks a failed or unanswered item read unreadable, never not sellable', async () => {
    const catalog = new FixtureCatalog();
    catalog.setStock('KB-COMP-12', null);
    const flaky: CatalogPort = {
      search: (r, o) => catalog.search(r, o),
      getProductContext: (k, o) => catalog.getProductContext(k, o),
      getItemContext: (r, o) => (r.itemKey === 'KB-COMP-16' ? Promise.reject(new Error('owner unavailable')) : r.itemKey === 'KB-COMP-24' ? Promise.resolve({ status: 'not_found', itemKey: r.itemKey }) : catalog.getItemContext(r, o)),
    };
    expect(variantsOf(await productContextWithVariantAvailability(flaky, 'KB-COMP', call))).toEqual([
      { itemKey: 'KB-COMP-12', availability: { status: 'reported', forQuantity: 1, sellability: 'check_with_staff', reason: 'stock_unknown' } },
      { itemKey: 'KB-COMP-16', availability: { status: 'unreadable' } },
      { itemKey: 'KB-COMP-24', availability: { status: 'unreadable' } },
    ]);
  });

  it('a product without variants and an unknown key are exactly the @1 view; the answer expires with its earliest read', async () => {
    const fixed = new Date('2026-11-09T12:00:00.000Z');
    const catalog = new FixtureCatalog({ now: () => fixed });
    expect(await productContextWithVariantAvailability(catalog, 'BAR-OLY20', call)).toEqual(productContextView(await catalog.getProductContext('BAR-OLY20')));
    expect(await productContextWithVariantAvailability(catalog, 'NOPE', call)).toEqual({ status: 'not_found', productKey: 'NOPE' });
    const early = '2026-01-01T00:00:00.000Z';
    const shortLived: CatalogPort = {
      search: (r, o) => catalog.search(r, o),
      getProductContext: (k, o) => catalog.getProductContext(k, o),
      getItemContext: async (r, o) => {
        const item = await catalog.getItemContext(r, o);
        return item.status === 'found' && r.itemKey === 'KB-COMP-24' ? { ...item, freshness: { ...item.freshness, validUntil: early } } : item;
      },
    };
    const view = await productContextWithVariantAvailability(shortLived, 'KB-COMP', call);
    expect(view.status === 'found' && view.freshness.validUntil).toBe(early);
  });
});
