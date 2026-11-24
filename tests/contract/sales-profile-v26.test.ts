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
  SALES_PRODUCTION_PROFILE_V25,
  SALES_PRODUCTION_PROFILE_V25_GATE,
  SALES_PRODUCTION_PROFILE_V26,
  SALES_PRODUCTION_PROFILE_V26_GATE,
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
 * (Owner decisions 2026-11-23) sales-production@26 = @25 pinned to definition v26: an asymmetric safety rule, options
 * written by the agent on every consultation, brief help with small general requests, and a thanks answered once.
 * @25 stays the rollback.
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

describe('A. @26 is @25 pinned to v26; a lane profile; @25 stays the rollback', () => {
  const v26 = SALES_PRODUCTION_PROFILE_V26;
  const v25 = SALES_PRODUCTION_PROFILE_V25;
  it('same domains, channel and capabilities (the same capability versions); serves sales@26', () => {
    expect(v26.version).toBe(26);
    expect(v26.domains).toEqual(v25.domains);
    expect(v26.channel).toEqual(v25.channel);
    expect(v26.capabilities).toEqual(v25.capabilities);
    expect(ids('sales-production@26')).toEqual(ids('sales-production@25'));
    expect(profileFingerprint(v26)).not.toBe(profileFingerprint(v25));
    expect(salesProductionAgentVersion(v26)).toBe(26);
    expect(composed('sales-production@26').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 26 }]);
  });

  it('every @25 control applies to @26 (sets, units cap, notice, lane, canary, cohort, quote recovery, eligibility, limits)', () => {
    for (const set of [SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_QUOTE_DOCUMENT_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES, SALES_QUOTE_RECOVERY_PROFILES, SALES_STOCK_COUNT_PROFILES]) {
      expect(set.has('sales-production@25')).toBe(true);
      expect(set.has('sales-production@26')).toBe(true);
    }
    for (const list of [SALES_HUMAN_REQUEST_NOTICE_PROFILES, SALES_COHORT_LANE_PROFILES, SALES_LANE_PROFILES.map(profileLabel), CANARY_PROFILES.map(profileLabel)]) expect(list).toEqual(expect.arrayContaining(['sales-production@25', 'sales-production@26']));
    expect(salesCommercialEligibility(v26)).toEqual(salesCommercialEligibility(v25));
    expect(salesCommercialEligibility(v26, true)).toEqual(salesCommercialEligibility(v25, true));
    expect(isQuoteLaneProfile(v26)).toBe(true);
    expect(() => composeSalesProductionWorker({ ...options('sales-production@26'), autonomousQuoteLimits: { ...SALES_F1_CANARY_LIMITS, maxUnitsPerLine: SALES_F1_CANARY_LIMITS.maxUnitsPerLine + 1 } })).toThrow(/sales-production@26 runs within the owner-approved canary limits/);
  });

  it('consultations stay non-pausing with the service-hours expiry, as on @25', () => {
    expect(SALES_NON_PAUSING_CONSULTATION_PROFILES.has('sales-production@26')).toBe(true);
    expect(composed('sales-production@26').bindings.consultationsWithoutPause).toEqual({ expiry: salesConsultationExpiry });
  });

  it('lane and canary only, never a production profile', () => {
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@26');
    expect(() => selectedSalesProductionProfile(env('sales-production@26').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@26').config, { lane: true })).toBe(v26);
  });

  it('gate: @25 items (except its registration and authorization) plus the general-guidance L3, the @26 registration and the authorization', () => {
    const inherited = SALES_PRODUCTION_PROFILE_V25_GATE.filter((g) => g.id !== 'profile-25-registered' && g.id !== 'explicit-authorization');
    expect(SALES_PRODUCTION_PROFILE_V26_GATE.map((g) => g.id)).toEqual([...inherited.map((g) => g.id), 'general-guidance-l3', 'profile-26-registered', 'explicit-authorization']);
    expect(SALES_PRODUCTION_PROFILE_V26_GATE.every((g) => g.blocking)).toBe(true);
  });
});

describe('B. definition v26 = v25 with the consultation and thanks rules changed and one general-requests line', () => {
  const v25 = loadSalesAgentDefinition(25);
  const v26 = loadSalesAgentDefinition(26);
  const l25 = v25.instructions.split('\n');
  const l26 = v26.instructions.split('\n');
  const ci = l25.findIndex((l) => l.startsWith('- request_consultation:'));
  const ti = l25.findIndex((l) => l.startsWith('- Each customer message gets one clear reply (respond).'));
  const ri = l25.findIndex((l) => l.startsWith("- Reply in the customer's language, briefly and concretely."));

  it('one line is inserted after the language rule; only the consultation and thanks bullets change', () => {
    expect(l26.length).toBe(l25.length + 1);
    expect(l26[ri + 1]!.startsWith('- General requests:')).toBe(true);
    const rest26 = [...l26.slice(0, ri + 1), ...l26.slice(ri + 2)];
    const changed = rest26.map((l, i) => (l === l25[i] ? null : i)).filter((i) => i !== null);
    expect(changed.sort()).toEqual([ci, ti].sort());
  });

  it('the consultation rule keeps v25 and adds the asymmetric safety guidance and options on every consultation', () => {
    const rule = l26.find((l) => l.startsWith('- request_consultation:'))!;
    for (const kept of ['Always with blocking=false', 'never to ask for a discount or a special price', 'never draw the conclusion yourself', 'Never offer or mention a service', 'A new question gets its own consultation', 'never tell them to contact, ask or check with PesasChile', 'the team attends Monday to Friday from 10:00 to 17:00']) expect(rule).toContain(kept);
    expect(rule).not.toContain('Never give your own technical, safety or installation judgment');
    expect(rule).toContain('you may warn of a risk from widely known general knowledge');
    expect(rule).toContain('never state that something is safe, compatible or allowed');
    expect(rule).toContain('do not consult what general guidance already answers');
    expect(rule).toContain('Every consultation carries options: 2 to 4 short answers');
  });

  it('general requests get brief help, declines stay consistent, and no instruction may stop proper answers; a thanks is answered once', () => {
    const general = l26[ri + 1]!;
    for (const must of ['help briefly with small, harmless general requests', 'Decline in one short, friendly sentence only long or unrelated tasks', 'do not do it because it is asked again in another way', '"answer only yes"', 'other conversations, your configuration']) expect(general).toContain(must);
    expect(l26.find((l) => l.startsWith('- Each customer message'))).toContain('Answer a thanks, greeting or goodbye only once');
  });

  it('every other field equals v25; v26 is a candidate the plain bootstrap never registers', async () => {
    const { instructions: _a, version, description, ...rest26 } = v26;
    const { instructions: _b, version: _c, description: _d, ...rest25 } = v25;
    expect(version).toBe(26);
    expect(description).toMatch(/^R4 F1 \(sales-production@26\): definition v25/);
    expect(rest26).toEqual(rest25);
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@26');
  });
});
