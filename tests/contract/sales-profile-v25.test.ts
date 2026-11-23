import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { SALES_AGENT_DIR, loadSalesAgentDefinition } from '@r4-sales/agent';
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
  SALES_NON_PAUSING_CONSULTATION_PROFILES,
  salesConsultationExpiry,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V24,
  SALES_PRODUCTION_PROFILE_V24_GATE,
  SALES_PRODUCTION_PROFILE_V25,
  SALES_PRODUCTION_PROFILE_V25_GATE,
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
 * (Owner feedback on the live @24 relay test, 2026-11-23) sales-production@25 = @24 pinned to definition v25: the
 * consultation rule asks for a follow-up consultation with the customer's new facts, forbids an own technical or safety
 * judgment and invented services, never sends the customer "to PesasChile", and the official store contacts are known.
 * @24 stays the rollback.
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

describe('A. @25 is @24 pinned to v25; a lane profile; @24 stays the rollback', () => {
  const v25 = SALES_PRODUCTION_PROFILE_V25;
  const v24 = SALES_PRODUCTION_PROFILE_V24;
  it('same domains, channel and capabilities (the same capability versions); serves sales@25', () => {
    expect(v25.version).toBe(25);
    expect(v25.domains).toEqual(v24.domains);
    expect(v25.channel).toEqual(v24.channel);
    expect(v25.capabilities).toEqual(v24.capabilities);
    expect(ids('sales-production@25')).toEqual(ids('sales-production@24'));
    expect(profileFingerprint(v25)).not.toBe(profileFingerprint(v24));
    expect(salesProductionAgentVersion(v25)).toBe(25);
    expect(composed('sales-production@25').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 25 }]);
  });

  it('every @24 control applies to @25 (sets, units cap, notice, lane, canary, cohort, quote recovery, eligibility, limits)', () => {
    for (const set of [SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_QUOTE_DOCUMENT_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES, SALES_QUOTE_RECOVERY_PROFILES, SALES_STOCK_COUNT_PROFILES]) {
      expect(set.has('sales-production@24')).toBe(true);
      expect(set.has('sales-production@25')).toBe(true);
    }
    for (const list of [SALES_HUMAN_REQUEST_NOTICE_PROFILES, SALES_COHORT_LANE_PROFILES, SALES_LANE_PROFILES.map(profileLabel), CANARY_PROFILES.map(profileLabel)]) expect(list).toEqual(expect.arrayContaining(['sales-production@24', 'sales-production@25']));
    expect(salesCommercialEligibility(v25)).toEqual(salesCommercialEligibility(v24));
    expect(salesCommercialEligibility(v25, true)).toEqual(salesCommercialEligibility(v24, true));
    expect(isQuoteLaneProfile(v25)).toBe(true);
    expect(() => composeSalesProductionWorker({ ...options('sales-production@25'), autonomousQuoteLimits: { ...SALES_F1_CANARY_LIMITS, maxUnitsPerLine: SALES_F1_CANARY_LIMITS.maxUnitsPerLine + 1 } })).toThrow(/sales-production@25 runs within the owner-approved canary limits/);
  });

  it('consultations stay non-pausing with the service-hours expiry, as on @24', () => {
    expect(SALES_NON_PAUSING_CONSULTATION_PROFILES.has('sales-production@25')).toBe(true);
    expect(composed('sales-production@25').bindings.consultationsWithoutPause).toEqual({ expiry: salesConsultationExpiry });
  });

  it('lane and canary only, never a production profile', () => {
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@25');
    expect(() => selectedSalesProductionProfile(env('sales-production@25').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@25').config, { lane: true })).toBe(v25);
  });

  it('gate: @24 items (except its registration and authorization) plus the relay L3, the @25 registration and the authorization', () => {
    const inherited = SALES_PRODUCTION_PROFILE_V24_GATE.filter((g) => g.id !== 'profile-24-registered' && g.id !== 'explicit-authorization');
    expect(SALES_PRODUCTION_PROFILE_V25_GATE.map((g) => g.id)).toEqual([...inherited.map((g) => g.id), 'relay-followup-l3', 'profile-25-registered', 'explicit-authorization']);
    expect(SALES_PRODUCTION_PROFILE_V25_GATE.every((g) => g.blocking)).toBe(true);
  });
});

describe('B. definition v25 = v24 with the consultation rule sharpened and the store contacts added', () => {
  const v24 = loadSalesAgentDefinition(24);
  const v25 = loadSalesAgentDefinition(25);
  const l24 = v24.instructions.split('\n');
  const l25 = v25.instructions.split('\n');
  const at = l24.findIndex((l) => l.startsWith('- request_consultation:'));

  it('only the consultation bullet changes and one contacts bullet follows it; every other line is v24', () => {
    expect(l25.length).toBe(l24.length + 1);
    expect([...l25.slice(0, at), ...l25.slice(at + 2)]).toEqual([...l24.slice(0, at), ...l24.slice(at + 1)]);
    expect(l25[at]).not.toBe(l24[at]);
  });

  it('the consultation rule keeps @24 and adds the follow-up, no own judgment, no invented services, never "ask PesasChile"', () => {
    const rule = l25[at]!;
    for (const kept of ['never as a substitute for a capability', 'never to ask for a discount or a special price', 'Always with blocking=false', 'keep helping with everything else', 'give them as options (2 to 4)', 'faithfully and without adding anything it does not say', 'the team attends Monday to Friday from 10:00 to 17:00']) expect(rule).toContain(kept);
    expect(rule).toContain('open a new consultation with the team\'s earlier answer and the customer\'s new facts; never draw the conclusion yourself');
    expect(rule).toContain('Never give your own technical, safety or installation judgment');
    expect(rule).toContain('Never offer or mention a service');
    expect(rule).toContain('A new question gets its own consultation even while another one is open');
    expect(rule).toContain('The customer is already talking to PesasChile: never tell them to contact, ask or check with PesasChile');
  });

  it('the contacts bullet holds the official pesaschile.cl channels and never makes store pickup available', () => {
    const contacts = l25[at + 1]!;
    expect(contacts.startsWith('- Store contacts (official, pesaschile.cl):')).toBe(true);
    for (const fact of ['Av. Américo Vespucio Norte 904, Las Condes', '+56 9 6631 2284', 'ventas@pesaschile.cl', 'Av. Monseñor Valech 12050, Bodega 26, Maipú', '+56 9 4260 9003', 'postventa@pesaschile.cl']) expect(contacts).toContain(fact);
    expect(contacts).toContain('never make store pickup available');
  });

  it('every other field equals v24; v25 is a candidate the plain bootstrap never registers', async () => {
    const { instructions: _a, version, description, ...rest25 } = v25;
    const { instructions: _b, version: _c, description: _d, ...rest24 } = v24;
    expect(version).toBe(25);
    expect(description).toMatch(/^R4 F1 \(sales-production@25\): definition v24/);
    expect(rest25).toEqual(rest24);
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@25');
  });
});
