import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { DESK_DOMAIN, DESK_OPPORTUNITY_CAPABILITY_ID, QUOTE_PARITY_REQUIRED_PROFILES } from '@r4-sales/agent';
import {
  SALES_AUTONOMOUS_QUOTE_PROFILES,
  SALES_CONFIRMED_INTENT_PROFILES,
  SALES_DETERMINISTIC_OFFER_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_F1_SHIPPING_PROFILES,
  SALES_INTENT_ACCEPTANCE_PROFILES,
  SALES_NON_PAUSING_CONSULTATION_PROFILES,
  SALES_QUOTE_DOCUMENT_PROFILES,
  SALES_VARIANT_AVAILABILITY_PROFILES,
  SALES_WEB_DESK_ACTION_POLICY,
  SALES_WEB_PROFILE_V20,
  SALES_WEB_PROFILE_V21,
  SALES_WEB_QUOTE_ACTION_POLICY,
  SALES_WEB_QUOTE_PROFILES,
  composeSalesProductionWorker,
  loadSalesWebAgentDefinition,
  salesActionPolicyFor,
  salesAgentOf,
} from '@r4-sales/agent/production';

/**
 * (ADR-062 O1) sales-web@21 = @20 + desk.opportunity.record@1 (write, ALLOW, autonomous): Pesín records the sales
 * opportunity in the sales desk. Everything else is @20's.
 */
const production = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const deskIngest = { url: 'http://127.0.0.1:3201/api/r4/opportunities', key: 'k'.repeat(40) };
const options = (profile: string) => ({
    pool: { query: () => Promise.reject(new Error('no db')) } as never, store: noStore, production: production(profile),
    modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) }, logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort), catalogDiscover: discover, shipping: http(new FixtureShipping() as ShippingService),
    quotes: http(new FixtureQuoteV2Service() as QuoteV2Service), autonomousQuoteLimits: SALES_F1_CANARY_LIMITS, deskIngest,
});
const compose = (profile: string) => composeSalesProductionWorker(options(profile));
const ids = (profile: string) => compose(profile).bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();

let previousGraph: string | undefined;
beforeAll(() => {
  // The web tools need the store graph file; an empty one is enough to compose.
  previousGraph = process.env.R4_EXP_GRAPH_FILE;
  const file = join(mkdtempSync(join(tmpdir(), 'r4-graph-')), 'graph.json');
  writeFileSync(file, JSON.stringify({ products: {}, view: {} }));
  process.env.R4_EXP_GRAPH_FILE = file;
});
afterAll(() => {
  if (previousGraph === undefined) delete process.env.R4_EXP_GRAPH_FILE;
  else process.env.R4_EXP_GRAPH_FILE = previousGraph;
});

describe('sales-web@21: @20 plus desk.opportunity.record (ADR-062 O1)', () => {
  it('same channel; @20 capabilities and domains plus the desk write (ALLOW) on its own REAL domain', () => {
    expect(profileLabel(SALES_WEB_PROFILE_V21)).toBe('sales-web@21');
    expect(salesAgentOf(SALES_WEB_PROFILE_V21)).toEqual({ agentId: 'sales-web', version: 21 });
    expect(SALES_WEB_PROFILE_V21.channel).toEqual(SALES_WEB_PROFILE_V20.channel);
    expect(SALES_WEB_PROFILE_V21.capabilities).toEqual([...SALES_WEB_PROFILE_V20.capabilities, { capabilityId: DESK_OPPORTUNITY_CAPABILITY_ID, domain: DESK_DOMAIN, effect: 'write', decision: 'ALLOW' }]);
    const { [DESK_DOMAIN]: desk, ...rest } = SALES_WEB_PROFILE_V21.domains;
    expect(rest).toEqual(SALES_WEB_PROFILE_V20.domains);
    expect(desk?.status).toBe('REAL');
  });

  it('inherits every control keyed by label: lane issuance sets, web quote set, non-pausing consultations, parity', () => {
    for (const set of [SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES, SALES_WEB_QUOTE_PROFILES, SALES_NON_PAUSING_CONSULTATION_PROFILES]) {
      expect(set.has('sales-web@21'), [...set].join(',')).toBe(true);
    }
    expect(SALES_QUOTE_DOCUMENT_PROFILES.has('sales-web@21')).toBe(false);
    expect(QUOTE_PARITY_REQUIRED_PROFILES.has('sales-web@21')).toBe(QUOTE_PARITY_REQUIRED_PROFILES.has('sales-web@20'));
  });

  it('its own action policy: the web quote policy plus the desk record ALLOW; @20 keeps its policy object', () => {
    expect(salesActionPolicyFor(SALES_WEB_PROFILE_V21)).toBe(SALES_WEB_DESK_ACTION_POLICY);
    expect(SALES_WEB_DESK_ACTION_POLICY.capabilities).toEqual({ ...SALES_WEB_QUOTE_ACTION_POLICY.capabilities, [DESK_OPPORTUNITY_CAPABILITY_ID]: { autonomy: 'allow' } });
    expect(SALES_WEB_DESK_ACTION_POLICY.riskClasses).toEqual(SALES_WEB_QUOTE_ACTION_POLICY.riskClasses);
    expect(salesActionPolicyFor(SALES_WEB_PROFILE_V20)).toBe(SALES_WEB_QUOTE_ACTION_POLICY);
  });

  it('composes @20 plus the desk record, within the F1 limits; @20 never composes it', () => {
    expect(ids('sales-web@21')).toEqual([...ids('sales-web@20'), `${DESK_OPPORTUNITY_CAPABILITY_ID}@1`].sort());
    expect(compose('sales-web@21').report.domains[DESK_DOMAIN]).toBe('REAL');
    expect(compose('sales-web@21').bindings.consultationsWithoutPause).toBeDefined();
    expect(() => composeSalesProductionWorker({ ...options('sales-web@21'), autonomousQuoteLimits: { ...SALES_F1_CANARY_LIMITS, maxUnitsPerLine: SALES_F1_CANARY_LIMITS.maxUnitsPerLine + 1 } })).toThrow(/sales-web@21 runs within the owner-approved canary limits/);
  });

  it('fails closed without the desk ingest (R4_DESK_INGEST_URL, R4_DESK_INGEST_KEY)', () => {
    const { deskIngest: _, ...without } = options('sales-web@21');
    expect(() => composeSalesProductionWorker(without)).toThrow(/sales-web@21 records opportunities in the sales desk but no desk ingest was configured \(R4_DESK_INGEST_URL, R4_DESK_INGEST_KEY\)/);
    const { deskIngest: __, ...w20 } = options('sales-web@20');
    expect(() => composeSalesProductionWorker(w20)).not.toThrow();
  });
});

describe('definition sales-web v21 = v20 plus the opportunity-record block', () => {
  const v20 = loadSalesWebAgentDefinition(20);
  const v21 = loadSalesWebAgentDefinition(21);
  const l20 = v20.instructions.split('\n');
  const l21 = v21.instructions.split('\n');

  it('every v20 line unchanged; a blank line, the section title and three rules appended (when, what, never mention it)', () => {
    expect(l21.slice(0, l20.length)).toEqual(l20);
    const added = l21.slice(l20.length);
    expect(added).toHaveLength(5);
    expect(added[0]).toBe('');
    expect(added[1]).toBe('Sales opportunities (internal)');
    const when = added[2]!;
    for (const must of ['desk.opportunity.record', 'before your reply (your reply ends the turn)', 'request_consultation (trigger=consulta)', 'quote.create issued a quote', 'trigger=cotizacion', 'buying intent and the conversation is ending', 'trigger=conversacion', 'Never record a pure question without buying intent']) expect(when).toContain(must);
    const what = added[3]!;
    for (const must of ['compra', 'cotizacion', 'postventa', 'servicio_tecnico', 'otra', 'persona', 'empresa', 'mayorista', 'institucional', 'desconocido when it is not clear: never guess', 'proyecto', 'estandar', 'in Spanish', 'never a phone number, an email, a RUT']) expect(what).toContain(must);
    expect(added[4]).toMatch(/^- Never mention the record, the opportunity, the CRM or the sales desk to the visitor\. If it is refused or fails, continue the conversation normally/);
  });

  it('the desk scope is granted; every other field equals v20', () => {
    expect(v21.capabilityScopes).toEqual([...v20.capabilityScopes, 'desk.opportunity.write']);
    expect({ ...v21, version: 20, description: '', instructions: '', capabilityScopes: [] }).toEqual({ ...v20, description: '', instructions: '', capabilityScopes: [] });
    expect(v21.version).toBe(21);
  });
});
