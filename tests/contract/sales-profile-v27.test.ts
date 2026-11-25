import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { DESK_DOMAIN, DESK_OPPORTUNITY_CAPABILITY_ID, SALES_AGENT_DIR, loadSalesAgentDefinition } from '@r4-sales/agent';
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
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_DESK_ACTION_POLICY,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V26,
  SALES_PRODUCTION_PROFILE_V26_GATE,
  SALES_PRODUCTION_PROFILE_V27,
  SALES_PRODUCTION_PROFILE_V27_GATE,
  SALES_QUOTE_DOCUMENT_PROFILES,
  SALES_QUOTE_RECOVERY_PROFILES,
  SALES_STOCK_COUNT_PROFILES,
  SALES_VARIANT_AVAILABILITY_PROFILES,
  composeSalesProductionWorker,
  isQuoteLaneProfile,
  salesActionPolicyFor,
  salesCommercialEligibility,
  salesConsultationExpiry,
  salesProductionAgentVersion,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * (ADR-062 O1, all channels) sales-production@27 = @26 plus desk.opportunity.record@1 (write, ALLOW, autonomous),
 * pinned to definition v27 = v26 plus the opportunity-record block. @26 stays the rollback.
 */
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const deskIngest = { url: 'http://127.0.0.1:3201/api/r4/opportunities', key: 'k'.repeat(40) };
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
  deskIngest,
});
const composed = (profile: string) => composeSalesProductionWorker(options(profile));
const ids = (profile: string) => composed(profile).bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();

describe('A. @27 is @26 plus the desk record, pinned to v27; a lane profile; @26 stays the rollback', () => {
  const v27 = SALES_PRODUCTION_PROFILE_V27;
  const v26 = SALES_PRODUCTION_PROFILE_V26;
  it('@26 domains, channel and capabilities plus the desk write (ALLOW) on its own REAL domain; serves sales@27', () => {
    expect(v27.version).toBe(27);
    const { [DESK_DOMAIN]: desk, ...rest } = v27.domains;
    expect(rest).toEqual(v26.domains);
    expect(desk?.status).toBe('REAL');
    expect(v27.channel).toEqual(v26.channel);
    expect(v27.capabilities).toEqual([...v26.capabilities, { capabilityId: DESK_OPPORTUNITY_CAPABILITY_ID, domain: DESK_DOMAIN, effect: 'write', decision: 'ALLOW' }]);
    expect(ids('sales-production@27')).toEqual([...ids('sales-production@26'), `${DESK_OPPORTUNITY_CAPABILITY_ID}@1`].sort());
    expect(profileFingerprint(v27)).not.toBe(profileFingerprint(v26));
    expect(salesProductionAgentVersion(v27)).toBe(27);
    expect(composed('sales-production@27').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 27 }]);
    expect(composed('sales-production@27').report.domains[DESK_DOMAIN]).toBe('REAL');
  });

  it('every @26 control applies to @27 (sets, units cap, notice, lane, canary, cohort, quote recovery, eligibility, limits)', () => {
    for (const set of [SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_QUOTE_DOCUMENT_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES, SALES_QUOTE_RECOVERY_PROFILES, SALES_STOCK_COUNT_PROFILES]) {
      expect(set.has('sales-production@26')).toBe(true);
      expect(set.has('sales-production@27')).toBe(true);
    }
    for (const list of [SALES_HUMAN_REQUEST_NOTICE_PROFILES, SALES_COHORT_LANE_PROFILES, SALES_LANE_PROFILES.map(profileLabel), CANARY_PROFILES.map(profileLabel)]) expect(list).toEqual(expect.arrayContaining(['sales-production@26', 'sales-production@27']));
    expect(salesCommercialEligibility(v27)).toEqual(salesCommercialEligibility(v26));
    expect(salesCommercialEligibility(v27, true)).toEqual(salesCommercialEligibility(v26, true));
    expect(isQuoteLaneProfile(v27)).toBe(true);
    expect(() => composeSalesProductionWorker({ ...options('sales-production@27'), autonomousQuoteLimits: { ...SALES_F1_CANARY_LIMITS, maxUnitsPerLine: SALES_F1_CANARY_LIMITS.maxUnitsPerLine + 1 } })).toThrow(/sales-production@27 runs within the owner-approved canary limits/);
  });

  it('its own action policy: the @26 autonomous policy plus the desk record ALLOW; @26 keeps its policy object', () => {
    expect(salesActionPolicyFor(v27)).toBe(SALES_PRODUCTION_DESK_ACTION_POLICY);
    expect(SALES_PRODUCTION_DESK_ACTION_POLICY.capabilities).toEqual({ ...SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY.capabilities, [DESK_OPPORTUNITY_CAPABILITY_ID]: { autonomy: 'allow' } });
    expect(SALES_PRODUCTION_DESK_ACTION_POLICY.riskClasses).toEqual(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY.riskClasses);
    expect(salesActionPolicyFor(v26)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
  });

  it('fails closed without the desk ingest; @26 composes without it', () => {
    const { deskIngest: _, ...without } = options('sales-production@27');
    expect(() => composeSalesProductionWorker(without)).toThrow(/sales-production@27 records opportunities in the sales desk but no desk ingest was configured \(R4_DESK_INGEST_URL, R4_DESK_INGEST_KEY\)/);
    const { deskIngest: __, ...w26 } = options('sales-production@26');
    expect(() => composeSalesProductionWorker(w26)).not.toThrow();
  });

  it('consultations stay non-pausing with the service-hours expiry, as on @26', () => {
    expect(SALES_NON_PAUSING_CONSULTATION_PROFILES.has('sales-production@27')).toBe(true);
    expect(composed('sales-production@27').bindings.consultationsWithoutPause).toEqual({ expiry: salesConsultationExpiry });
  });

  it('lane and canary only, never a production profile', () => {
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@27');
    expect(() => selectedSalesProductionProfile(env('sales-production@27').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@27').config, { lane: true })).toBe(v27);
  });

  it('gate: @26 items (except its registration and authorization) plus the desk ingest, write budget, record L3, the @27 registration and the authorization', () => {
    const inherited = SALES_PRODUCTION_PROFILE_V26_GATE.filter((g) => g.id !== 'profile-26-registered' && g.id !== 'explicit-authorization');
    expect(SALES_PRODUCTION_PROFILE_V27_GATE.map((g) => g.id)).toEqual([...inherited.map((g) => g.id), 'desk-ingest', 'write-budget', 'opportunity-l3', 'profile-27-registered', 'explicit-authorization']);
    expect(SALES_PRODUCTION_PROFILE_V27_GATE.every((g) => g.blocking)).toBe(true);
  });
});

describe('B. definition v27 = v26 byte for byte plus the opportunity-record block', () => {
  const v26 = loadSalesAgentDefinition(26);
  const v27 = loadSalesAgentDefinition(27);
  const block = v27.instructions.slice(v26.instructions.length + 1).split('\n');

  it('v26 instructions are its exact prefix; the block is a blank line, the section and three rules', () => {
    expect(v27.instructions.startsWith(v26.instructions)).toBe(true);
    expect(block).toHaveLength(5);
    expect(block.slice(0, 2)).toEqual(['', 'Sales opportunities (internal)']);
    const when = block[2]!;
    for (const must of ['desk.opportunity.record', 'before your reply (your reply ends the turn)', 'request_consultation (trigger=consulta)', 'right BEFORE request_handoff, because the handoff ends your turn (trigger=traspaso)', 'quote.create issued a quote (trigger=cotizacion)', 'trigger=conversacion', 'Never record a pure question without buying intent']) expect(when).toContain(must);
    for (const must of ['servicio_tecnico', 'mayorista', 'institucional', 'desconocido when it is not clear: never guess', 'never a phone number, an email, a RUT']) expect(block[3]).toContain(must);
    expect(block[4]).toMatch(/^- Never mention the record, the opportunity, the CRM or the sales desk to the customer\./);
  });

  it('the desk scope is granted; every other field equals v26; v27 is a candidate the plain bootstrap never registers', async () => {
    expect(v27.capabilityScopes).toEqual([...v26.capabilityScopes, 'desk.opportunity.write']);
    const { instructions: _a, version, description, capabilityScopes: _s, ...rest27 } = v27;
    const { instructions: _b, version: _c, description: _d, capabilityScopes: _t, ...rest26 } = v26;
    expect(version).toBe(27);
    expect(description).toMatch(/^R4 F1 \(sales-production@27\): definition v26 plus the opportunity-record block/);
    expect(rest27).toEqual(rest26);
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@27');
  });
});
