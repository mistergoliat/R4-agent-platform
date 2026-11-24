import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { SALES_AGENT_DIR, catalogCapabilities, loadSalesAgentDefinition, productContextOutput, unitsInStockOf, withoutStockCounts, type ProductContextView } from '@r4-sales/agent';
import { CANARY_PROFILES } from '@r4-sales/agent/canary';
import {
  SALES_AUTONOMOUS_QUOTE_PROFILES,
  SALES_CANARY_ONLY_PROFILES,
  SALES_COHORT_LANE_PROFILES,
  SALES_CONFIRMED_INTENT_PROFILES,
  SALES_DETERMINISTIC_OFFER_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_F1_SHIPPING_PROFILES,
  SALES_HUMAN_REQUEST_NOTICE_PROFILES,
  SALES_INTENT_ACCEPTANCE_PROFILES,
  SALES_LANE_PROFILES,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V22,
  SALES_PRODUCTION_PROFILE_V22_GATE,
  SALES_PRODUCTION_PROFILE_V23,
  SALES_PRODUCTION_PROFILE_V23_GATE,
  SALES_QUOTE_DOCUMENT_PROFILES,
  SALES_QUOTE_RECOVERY_PROFILES,
  SALES_STOCK_COUNT_PROFILES,
  SALES_VARIANT_AVAILABILITY_PROFILES,
  composeSalesProductionWorker,
  isQuoteLaneProfile,
  salesCommercialEligibility,
  salesProductionAgentVersion,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * (owner decision 2026-11-23 on live @22) «que diga la cantidad cuando el cliente pregunte; si tiene +20 unidades, que lo
 * diga así». sales-production@23 = @22 pinned to definition v23, with catalog.get_product_context@3 (capped units in stock)
 * and a preview that no longer shows the model the uncapped quantity. @22 stays the rollback.
 */
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const options = (profile: string) => ({
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
});
const composed = (profile: string) => composeSalesProductionWorker(options(profile));
const ids = (profile: string) => composed(profile).bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();
const call = { signal: new AbortController().signal, correlationId: 'v23' };
const context = { signal: call.signal, execution: { correlationId: 'v23' } } as never;
const productContext = (catalog: CatalogPort, stockCount: boolean) => catalogCapabilities(catalog, { variantAvailability: true, stockCount })[1];
const read = async (catalog: CatalogPort, key: string, stockCount = true): Promise<ProductContextView> => {
  const out = (await productContext(catalog, stockCount).handler({ productKey: key }, context)) as { ok: true; value: ProductContextView } | ProductContextView;
  return 'ok' in out ? out.value : out;
};

describe('A. @23 is @22 with catalog.get_product_context@3, pinned to v23; a lane profile; @22 stays the rollback', () => {
  const v23 = SALES_PRODUCTION_PROFILE_V23;
  const v22 = SALES_PRODUCTION_PROFILE_V22;
  it('same domains, channel and capabilities; only the product context moves to @3; serves sales@23', () => {
    expect(v23.version).toBe(23);
    expect(v23.domains).toEqual(v22.domains);
    expect(v23.channel).toEqual(v22.channel);
    expect(v23.capabilities).toEqual(v22.capabilities);
    expect(ids('sales-production@22')).toContain('catalog.get_product_context@2');
    expect(ids('sales-production@23')).toEqual(ids('sales-production@22').map((id) => (id === 'catalog.get_product_context@2' ? 'catalog.get_product_context@3' : id)).sort());
    expect(profileFingerprint(v23)).not.toBe(profileFingerprint(v22));
    expect(salesProductionAgentVersion(v23)).toBe(23);
    expect(composed('sales-production@23').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 23 }]);
  });

  it('every @22 control applies to @23 (sets, notice, lane, canary, cohort, quote recovery, eligibility, limits)', () => {
    for (const set of [SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_QUOTE_DOCUMENT_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES, SALES_QUOTE_RECOVERY_PROFILES]) {
      expect(set.has('sales-production@22')).toBe(true);
      expect(set.has('sales-production@23')).toBe(true);
    }
    for (const list of [SALES_HUMAN_REQUEST_NOTICE_PROFILES, SALES_COHORT_LANE_PROFILES, SALES_LANE_PROFILES.map(profileLabel), CANARY_PROFILES.map(profileLabel)]) expect(list).toEqual(expect.arrayContaining(['sales-production@22', 'sales-production@23']));
    expect(salesCommercialEligibility(v23)).toEqual(salesCommercialEligibility(v22));
    expect(salesCommercialEligibility(v23, true)).toEqual(salesCommercialEligibility(v22, true));
    expect(isQuoteLaneProfile(v23)).toBe(true);
    expect(() => composeSalesProductionWorker({ ...options('sales-production@23'), autonomousQuoteLimits: { ...SALES_F1_CANARY_LIMITS, maxUnitsPerLine: SALES_F1_CANARY_LIMITS.maxUnitsPerLine + 1 } })).toThrow(/sales-production@23 runs within the owner-approved canary limits/);
  });

  it('capped units are @23 and its successors @24 to @26 only; lane and canary only, never a production profile', () => {
    expect([...SALES_STOCK_COUNT_PROFILES]).toEqual(['sales-production@23', 'sales-production@24', 'sales-production@25', 'sales-production@26']);
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@23');
    expect(() => selectedSalesProductionProfile(env('sales-production@23').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@23').config, { lane: true })).toBe(v23);
  });

  it('gate: @22 items (except its registration and authorization) plus the units L3, the @23 registration and the authorization', () => {
    const inherited = SALES_PRODUCTION_PROFILE_V22_GATE.filter((g) => g.id !== 'profile-22-registered' && g.id !== 'explicit-authorization');
    expect(SALES_PRODUCTION_PROFILE_V23_GATE.map((g) => g.id)).toEqual([...inherited.map((g) => g.id), 'stock-count-l3', 'profile-23-registered', 'explicit-authorization']);
    expect(SALES_PRODUCTION_PROFILE_V23_GATE.every((g) => g.blocking)).toBe(true);
  });
});

describe('B. units in stock: exact up to 20, "more than 20" above it, unknown when the owner does not say', () => {
  it('unitsInStockOf caps at 20 and never returns the number above it', () => {
    expect(unitsInStockOf(0)).toEqual({ kind: 'exact', units: 0 });
    expect(unitsInStockOf(-3)).toEqual({ kind: 'exact', units: 0 });
    expect(unitsInStockOf(18)).toEqual({ kind: 'exact', units: 18 });
    expect(unitsInStockOf(20)).toEqual({ kind: 'exact', units: 20 });
    expect(unitsInStockOf(21)).toEqual({ kind: 'more_than', units: 20 });
    expect(unitsInStockOf(100)).toEqual({ kind: 'more_than', units: 20 });
    expect(unitsInStockOf(null)).toBeNull();
  });

  it('a product without variants: its sellable item\'s units (BAR-OLY20: 15; set to 100: more than 20; unknown: null)', async () => {
    const catalog = new FixtureCatalog();
    const view = await read(catalog, 'BAR-OLY20');
    expect(productContextOutput.parse(view)).toEqual(view);
    expect(view.status === 'found' && view.derived.unitsInStock).toEqual({ kind: 'exact', units: 15 });
    catalog.setStock('BAR-OLY20', 100);
    const deep = await read(catalog, 'BAR-OLY20');
    expect(deep.status === 'found' && deep.derived.unitsInStock).toEqual({ kind: 'more_than', units: 20 });
    expect(JSON.stringify(deep)).not.toMatch(/\b100\b|availableQuantity/);
    catalog.setStock('BAR-OLY20', null);
    const unknown = await read(catalog, 'BAR-OLY20');
    expect(unknown.status === 'found' && unknown.derived.unitsInStock).toBeNull();
  });

  it('a failed item read is unknown (null), never zero; the answer expires with its earliest read', async () => {
    const catalog = new FixtureCatalog();
    const failing: CatalogPort = { search: (r, o) => catalog.search(r, o), getProductContext: (k, o) => catalog.getProductContext(k, o), getItemContext: () => Promise.reject(new Error('owner unavailable')) };
    const view = await read(failing, 'BAR-OLY20');
    expect(view.status === 'found' && view.derived.unitsInStock).toBeNull();
    const early = '2026-01-01T00:00:00.000Z';
    const shortLived: CatalogPort = { ...failing, getItemContext: async (r, o) => { const i = await catalog.getItemContext(r, o); return i.status === 'found' ? { ...i, freshness: { ...i.freshness, validUntil: early } } : i; } };
    const expiring = await read(shortLived, 'BAR-OLY20');
    expect(expiring.status === 'found' && expiring.freshness.validUntil).toBe(early);
  });

  it('a product with variants: units per variant, capped', async () => {
    const catalog = new FixtureCatalog();
    catalog.setStock('KB-COMP-12', 7);
    catalog.setStock('KB-COMP-24', 250);
    const view = await read(catalog, 'KB-COMP');
    expect(productContextOutput.parse(view)).toEqual(view);
    const units = view.status === 'found' ? view.facts.variantOptions.map((o) => [o.itemKey, o.availability?.status === 'reported' ? o.availability.unitsInStock : 'unreadable']) : [];
    expect(units).toEqual([['KB-COMP-12', { kind: 'exact', units: 7 }], ['KB-COMP-16', { kind: 'exact', units: 0 }], ['KB-COMP-24', { kind: 'more_than', units: 20 }]]);
    expect(JSON.stringify(view)).not.toMatch(/\b250\b/);
  });

  it('@2 (every other profile) is unchanged: no units anywhere', async () => {
    const catalog = new FixtureCatalog();
    expect(productContext(catalog, false).definition.version).toBe(2);
    expect(productContext(catalog, true).definition.version).toBe(3);
    expect(JSON.stringify(await read(catalog, 'BAR-OLY20', false))).not.toMatch(/unitsInStock/);
    expect(JSON.stringify(await read(catalog, 'KB-COMP', false))).not.toMatch(/unitsInStock/);
  });
});

describe('C. @23 preview: no uncapped quantity reaches the model', () => {
  const evidence = (q: number | null) => ({ validUntil: null, catalog: [{ itemKey: 'P1547', asOf: 'a', validUntil: null, availableQuantity: q }], shippingAsOf: null });
  it('evidence quantities are removed; an insufficient_stock above 20 says "more than 20"; below it, the number stays', () => {
    expect(withoutStockCounts({ blockers: [], evidence: evidence(100) }).evidence.catalog[0]!.availableQuantity).toBeNull();
    const above = withoutStockCounts({ blockers: [{ code: 'insufficient_stock', message: 'only 30 units of X are available', details: { available: 30, requested: 40 } }], evidence: evidence(null) });
    expect(above.blockers[0]).toEqual({ code: 'insufficient_stock', message: 'more than 20 units are available, fewer than requested', details: { available: 'more_than_20', requested: 40 } });
    const below = { code: 'insufficient_stock', message: 'only 1 units of X are available', details: { available: 1, requested: 2 } };
    expect(withoutStockCounts({ blockers: [below], evidence: evidence(null) }).blockers[0]).toEqual(below);
  });
});

describe('D. definition v23 = v22 with exactly the quantity-availability rule changed', () => {
  const v22 = loadSalesAgentDefinition(22);
  const v23 = loadSalesAgentDefinition(23);
  it('one line differs: the quantity bullet, which now tells units on request, capped, never volunteered or promised', () => {
    const l22 = v22.instructions.split('\n');
    const l23 = v23.instructions.split('\n');
    expect(l23.length).toBe(l22.length);
    const changed = l23.map((l, i) => (l === l22[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toHaveLength(1);
    const rule = l23[changed[0]!]!;
    expect(rule.startsWith('- Quantity availability: ')).toBe(true);
    expect(rule).toContain('Say units in stock only when the customer asks how many there are');
    expect(rule).toContain('"más de 20" when kind=more_than, never a larger number');
    expect(rule).toContain('never promise that they will still be there');
    expect(rule).toContain('When quote.preview reports insufficient_stock, tell the customer the available quantity it reports');
    expect(l22[changed[0]!]).toContain('never how many units are in stock');
  });

  it('every other field equals v22; v22 is unchanged on disk; v23 is a candidate the plain bootstrap never registers', async () => {
    const { instructions: _a, version, description, ...rest23 } = v23;
    const { instructions: _b, version: _c, description: _d, ...rest22 } = v22;
    expect(version).toBe(23);
    expect(description).toMatch(/^R4 F1 \(sales-production@23\): definition v22/);
    expect(rest23).toEqual(rest22);
    const raw = JSON.parse(readFileSync(join(SALES_AGENT_DIR, 'candidates/sales.v22.candidate.json'), 'utf8')) as { version: number; instructions: string };
    expect(raw.version).toBe(22);
    expect(raw.instructions).toContain('never how many units are in stock');
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@23');
  });
});
