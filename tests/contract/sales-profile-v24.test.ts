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
  SALES_PRODUCTION_PROFILE_V23,
  SALES_PRODUCTION_PROFILE_V23_GATE,
  SALES_PRODUCTION_PROFILE_V24,
  SALES_PRODUCTION_PROFILE_V24_GATE,
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
 * (ADR-056 K3) sales-production@24 = @23 pinned to definition v24: Don Pesín consults the team without pausing the
 * conversation (request_consultation with blocking=false), with optional suggested answers. @23 stays the rollback.
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

describe('A. @24 is @23 pinned to v24; a lane profile; @23 stays the rollback', () => {
  const v24 = SALES_PRODUCTION_PROFILE_V24;
  const v23 = SALES_PRODUCTION_PROFILE_V23;
  it('same domains, channel and capabilities (the same capability versions); serves sales@24', () => {
    expect(v24.version).toBe(24);
    expect(v24.domains).toEqual(v23.domains);
    expect(v24.channel).toEqual(v23.channel);
    expect(v24.capabilities).toEqual(v23.capabilities);
    expect(ids('sales-production@24')).toEqual(ids('sales-production@23'));
    expect(profileFingerprint(v24)).not.toBe(profileFingerprint(v23));
    expect(salesProductionAgentVersion(v24)).toBe(24);
    expect(composed('sales-production@24').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 24 }]);
  });

  it('every @23 control applies to @24 (sets, units cap, notice, lane, canary, cohort, quote recovery, eligibility, limits)', () => {
    for (const set of [SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_QUOTE_DOCUMENT_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES, SALES_QUOTE_RECOVERY_PROFILES, SALES_STOCK_COUNT_PROFILES]) {
      expect(set.has('sales-production@23')).toBe(true);
      expect(set.has('sales-production@24')).toBe(true);
    }
    for (const list of [SALES_HUMAN_REQUEST_NOTICE_PROFILES, SALES_COHORT_LANE_PROFILES, SALES_LANE_PROFILES.map(profileLabel), CANARY_PROFILES.map(profileLabel)]) expect(list).toEqual(expect.arrayContaining(['sales-production@23', 'sales-production@24']));
    expect(salesCommercialEligibility(v24)).toEqual(salesCommercialEligibility(v23));
    expect(salesCommercialEligibility(v24, true)).toEqual(salesCommercialEligibility(v23, true));
    expect(isQuoteLaneProfile(v24)).toBe(true);
    expect(() => composeSalesProductionWorker({ ...options('sales-production@24'), autonomousQuoteLimits: { ...SALES_F1_CANARY_LIMITS, maxUnitsPerLine: SALES_F1_CANARY_LIMITS.maxUnitsPerLine + 1 } })).toThrow(/sales-production@24 runs within the owner-approved canary limits/);
  });

  it('(K3) the platform makes @24 consultations non-pausing, whatever the model writes; @23 keeps the model\'s choice', () => {
    expect([...SALES_NON_PAUSING_CONSULTATION_PROFILES].sort()).toEqual(['sales-facebook@1', 'sales-facebook@2', 'sales-instagram@1', 'sales-instagram@2', 'sales-production@24', 'sales-production@25', 'sales-production@26', 'sales-production@27', 'sales-production@28', 'sales-web@17', 'sales-web@18', 'sales-web@19', 'sales-web@20', 'sales-web@21', 'sales-web@22']);
    expect(composed('sales-production@24').bindings.consultationsWithoutPause).toEqual({ expiry: salesConsultationExpiry });
    expect(composed('sales-production@23').bindings.consultationsWithoutPause).toBeUndefined();
  });

  it('lane and canary only, never a production profile', () => {
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@24');
    expect(() => selectedSalesProductionProfile(env('sales-production@24').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@24').config, { lane: true })).toBe(v24);
  });

  it('gate: @23 items (except its registration and authorization) plus the consultation L3, the @24 registration and the authorization', () => {
    const inherited = SALES_PRODUCTION_PROFILE_V23_GATE.filter((g) => g.id !== 'profile-23-registered' && g.id !== 'explicit-authorization');
    expect(SALES_PRODUCTION_PROFILE_V24_GATE.map((g) => g.id)).toEqual([...inherited.map((g) => g.id), 'consultation-l3', 'profile-24-registered', 'explicit-authorization']);
    expect(SALES_PRODUCTION_PROFILE_V24_GATE.every((g) => g.blocking)).toBe(true);
  });
});

describe('B. definition v24 = v23 with exactly the consultation rule changed', () => {
  const v23 = loadSalesAgentDefinition(23);
  const v24 = loadSalesAgentDefinition(24);
  it('one line differs: the consultation bullet, which now consults without pause and keeps helping', () => {
    const l23 = v23.instructions.split('\n');
    const l24 = v24.instructions.split('\n');
    expect(l24.length).toBe(l23.length);
    const changed = l24.map((l, i) => (l === l23[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toHaveLength(1);
    const rule = l24[changed[0]!]!;
    expect(l23[changed[0]!]).toBe('- request_consultation: only for knowledge no capability provides (for example a store policy the catalog does not state); never as a substitute for a capability.');
    expect(rule.startsWith('- request_consultation: only for knowledge no capability provides')).toBe(true);
    expect(rule).toContain('never as a substitute for a capability');
    expect(rule).toContain('never to ask for a discount or a special price');
    expect(rule).toContain('Always with blocking=false');
    expect(rule).toContain('keep helping with everything else');
    expect(rule).toContain('give them as options (2 to 4)');
    expect(rule).toContain('faithfully and without adding anything it does not say');
    expect(rule).toContain('If the consultation expired without an answer');
    expect(rule).toContain('the team attends Monday to Friday from 10:00 to 17:00');
  });

  it('every other field equals v23; v24 is a candidate the plain bootstrap never registers', async () => {
    const { instructions: _a, version, description, ...rest24 } = v24;
    const { instructions: _b, version: _c, description: _d, ...rest23 } = v23;
    expect(version).toBe(24);
    expect(description).toMatch(/^R4 F1 \(sales-production@24\): definition v23/);
    expect(rest24).toEqual(rest23);
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@24');
  });
});
