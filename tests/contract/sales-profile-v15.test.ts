import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { DEFAULT_ACTION_POLICY } from '@r4/policy-engine';
import { capabilityAvailability, loadProductionConfig, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type CheckoutService, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { CHECKOUT_CAPABILITY_IDS, SALES_AGENT_DIR, createQuoteParityGuard, loadSalesAgentDefinition } from '@r4-sales/agent';
import {
  SALES_CANARY_ONLY_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V14,
  SALES_PRODUCTION_PROFILE_V15,
  SALES_PRODUCTION_PROFILE_V15_GATE,
  SALES_PRODUCTION_V15_ACTION_POLICY,
  composeSalesProductionWorker,
  salesActionPolicyFor,
  salesCatalogSourceOf,
  salesProductionAgentVersion,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * R4 Checkout integration: sales-production@15, the checkout sandbox lane profile. @14 plus the three Checkout
 * capabilities; lane only; two autonomous FINANCIAL writes in its own policy and nowhere else; never composed without
 * a Checkout binding and a purchase-consent source (none exists in R4: contract R-3).
 */
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')), createPlatformNotice: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const parity = createQuoteParityGuard({ evidence: { schemaVersion: 1, items: [{ itemKey: 'BAR-OLY20', productRef: '105', variantRef: null, sku: 'SC-BO20-28', finalGross: 129_990, availableQuantity: 5, verifiedAt: new Date().toISOString(), source: 'contract-test' }] }, maxAgeSeconds: 3600 });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const checkout = http({} as CheckoutService);
const consent = { obtain: () => Promise.resolve(null) };
const compose = (options: { checkout?: boolean; consent?: boolean } = {}) =>
  composeSalesProductionWorker({
    pool: { query: () => Promise.reject(new Error('no db')) } as never,
    store: noStore,
    production: env('sales-production@15'),
    modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) },
    logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort),
    catalogDiscover: discover,
    shipping: http(new FixtureShipping() as ShippingService),
    quotes: http(new FixtureQuoteV2Service() as QuoteV2Service),
    autonomousQuoteLimits: SALES_F1_CANARY_LIMITS,
    quoteParity: parity,
    ...(options.checkout === false ? {} : { checkout }),
    ...(options.consent === false ? {} : { checkoutConsent: consent }),
  });

describe('A. @15 = @14 + Checkout sandbox, lane only', () => {
  it('adds the Checkout domain and exactly the three Checkout capabilities', () => {
    const v15 = SALES_PRODUCTION_PROFILE_V15;
    expect(profileLabel(v15)).toBe('sales-production@15');
    expect(v15.capabilities.slice(0, SALES_PRODUCTION_PROFILE_V14.capabilities.length)).toEqual(SALES_PRODUCTION_PROFILE_V14.capabilities);
    expect(v15.capabilities.slice(SALES_PRODUCTION_PROFILE_V14.capabilities.length).map((c) => [c.capabilityId, c.effect])).toEqual([
      [CHECKOUT_CAPABILITY_IDS.startPurchase, 'write'],
      [CHECKOUT_CAPABILITY_IDS.requestPaymentLink, 'write'],
      [CHECKOUT_CAPABILITY_IDS.purchaseStatus, 'read'],
    ]);
    expect({ ...v15.domains, checkout: null }).toEqual({ ...SALES_PRODUCTION_PROFILE_V14.domains, checkout: null });
    expect(v15.domains.checkout).toMatchObject({ status: 'REAL', contractRef: expect.stringMatching(/d11e3c7.*sandbox-purchase/) });
    for (const id of Object.values(CHECKOUT_CAPABILITY_IDS)) expect(capabilityAvailability(SALES_PRODUCTION_PROFILE_V14, id).available, id).toBe(false);
  });

  it('is a lane profile only, pinned to v15, on Catalog V2', () => {
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@15');
    expect(() => selectedSalesProductionProfile(env('sales-production@15').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@15').config, { lane: true })).toBe(SALES_PRODUCTION_PROFILE_V15);
    expect(salesProductionAgentVersion(SALES_PRODUCTION_PROFILE_V15)).toBe(15);
    expect(salesCatalogSourceOf(SALES_PRODUCTION_PROFILE_V15)).toBe('v2');
  });

  it('R-5: its policy allows exactly the two Checkout commands; the FINANCIAL class keeps the platform default; no other profile gets it', () => {
    expect(salesActionPolicyFor(SALES_PRODUCTION_PROFILE_V15)).toBe(SALES_PRODUCTION_V15_ACTION_POLICY);
    expect(SALES_PRODUCTION_V15_ACTION_POLICY.riskClasses.FINANCIAL).toEqual(DEFAULT_ACTION_POLICY.riskClasses.FINANCIAL);
    const financial = Object.entries(SALES_PRODUCTION_V15_ACTION_POLICY.capabilities ?? {}).filter(([id]) => id.startsWith('checkout.')).map(([id, rule]) => [id, rule.autonomy]);
    expect(financial).toEqual([[CHECKOUT_CAPABILITY_IDS.startPurchase, 'allow'], [CHECKOUT_CAPABILITY_IDS.requestPaymentLink, 'allow']]);
    expect(salesActionPolicyFor(SALES_PRODUCTION_PROFILE_V14)).not.toBe(SALES_PRODUCTION_V15_ACTION_POLICY);
  });

  it('its gate is all blocking and names the consent source, the shared Quote instance, the runtime, D7-6 and the authorization', () => {
    expect(SALES_PRODUCTION_PROFILE_V15_GATE.every((g) => g.blocking)).toBe(true);
    expect(SALES_PRODUCTION_PROFILE_V15_GATE.map((g) => g.id)).toEqual(expect.arrayContaining(['contract-accepted', 'consent-source', 'same-quote-instance', 'checkout-runtime', 'financial-policy', 'explicit-authorization']));
  });
});

describe('B. composition', () => {
  it('composes the three Checkout capabilities with a binding and a consent source', () => {
    const registry = compose().bindings.capabilities;
    for (const id of Object.values(CHECKOUT_CAPABILITY_IDS)) expect(registry.resolve(id), id).toBeDefined();
    expect(registry.resolve(CHECKOUT_CAPABILITY_IDS.startPurchase)!.definition).toMatchObject({ riskClass: 'FINANCIAL', idempotency: 'key_required', writeRecovery: 'idempotent_replay' });
    expect(compose().bindings.servedAgents).toEqual([{ agentId: 'sales', version: 15 }]);
  });

  it('refuses without a Checkout binding, and without a purchase-consent source (R4_CHECKOUT_SBX_CONSENT_DIR unset)', () => {
    expect(() => compose({ checkout: false })).toThrow(/no Checkout binding/);
    expect(() => compose({ consent: false })).toThrow(/requires a purchase-consent source \(contract R-3: R4_CHECKOUT_SBX_CONSENT_DIR/);
  });
});

describe('C. definition v15 = v14 + the Checkout lines and scopes', () => {
  const v14 = loadSalesAgentDefinition(14);
  const v15 = loadSalesAgentDefinition(15);

  it('adds four lines after quote.create and two scopes; everything else is v14', () => {
    const added = v15.instructions.split('\n').filter((l) => !v14.instructions.split('\n').includes(l));
    expect(added.map((l) => l.slice(0, 24))).toEqual(['- checkout.start_purchas', '- checkout.request_payme', '- checkout.purchase_stat', '- HUMAN_INTERVENTION_REQ']);
    expect(v15.capabilityScopes).toEqual([...v14.capabilityScopes, 'checkout.purchase', 'checkout.read']);
    const { instructions: _a, version: _b, description: _c, capabilityScopes: _d, ...rest15 } = v15;
    const { instructions: _e, version: _f, description: _g, capabilityScopes: _h, ...rest14 } = v14;
    expect(rest15).toEqual(rest14);
  });

  it('forbids the model to write links, amounts or accreditation from anything but Checkout status', () => {
    expect(v15.instructions).toMatch(/Never write, shorten or repeat a link, URL, payment amount or expiry yourself/);
    expect(v15.instructions).toMatch(/Say a payment was accredited only when paymentAccredited is true/);
    expect(v15.instructions).toMatch(/their word, a screenshot or a redirect is never evidence/);
  });

  it('is a candidate file, never registered by the plain bootstrap', async () => {
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@15');
  });
});
