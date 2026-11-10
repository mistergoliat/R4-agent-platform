import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { SALES_AGENT_DIR, loadSalesAgentDefinition } from '@r4-sales/agent';
import { CANARY_PROFILES } from '@r4-sales/agent/canary';
import {
  SALES_CANARY_ONLY_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_HUMAN_REQUEST_NOTICE_PROFILES,
  SALES_LANE_PROFILES,
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V18,
  SALES_PRODUCTION_PROFILE_V19,
  SALES_PRODUCTION_PROFILE_V19_GATE,
  SALES_QUOTE_DOCUMENT_PROFILES,
  composeSalesProductionWorker,
  isQuoteLaneProfile,
  salesCommercialEligibility,
  salesProductionActionPolicy,
  salesProductionAgentVersion,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * sales-production@19 is @18 except: the acceptance of the offer interpreted in natural language (quote.preview@4,
 * quote.create@6), F1-COMMERCIAL-POLICY-v2 (delivery at the Shipping owner price) and definition v19 (v17 with its
 * delivery rules plus the offer, acceptance and validity rules). Definition v18 stays as registered, pinned by no profile.
 */
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const composed = (profile: string) =>
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
  });
const ids = (profile: string) => composed(profile).bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();

describe('@19 is @18 with natural acceptance, delivery at the owner price and definition v19, a lane (and isolated canary) profile only', () => {
  const v19 = SALES_PRODUCTION_PROFILE_V19;
  it('same domains, channel and capabilities as @18 (shipping.quote included); quote.preview@4 and quote.create@6', () => {
    expect(v19.version).toBe(19);
    expect(v19.domains).toEqual(SALES_PRODUCTION_PROFILE_V18.domains);
    expect(v19.channel).toEqual(SALES_PRODUCTION_PROFILE_V18.channel);
    expect(v19.capabilities).toEqual(SALES_PRODUCTION_PROFILE_V18.capabilities);
    // (owner decision 2026-11-10) quote.preview@4 (offer template v2) and quote.create@6 (intent) replace @3/@5 in @19 only.
    expect(ids('sales-production@19')).toEqual(ids('sales-production@18').map((id) => (id === 'quote.preview@3' ? 'quote.preview@4' : id === 'quote.create@5' ? 'quote.create@6' : id)).sort());
    expect(ids('sales-production@18')).toEqual(expect.arrayContaining(['quote.preview@3', 'quote.create@5']));
    expect(ids('sales-production@19').some((id) => id.startsWith('shipping.quote@'))).toBe(true);
    expect(profileFingerprint(v19)).not.toBe(profileFingerprint(SALES_PRODUCTION_PROFILE_V18));
    expect(salesProductionAgentVersion(v19)).toBe(19);
    expect(composed('sales-production@19').bindings.servedAgents).toEqual([{ agentId: 'sales', version: 19 }]);
  });

  it('F1 policy v2 (delivery at the owner price), the PDF delivery and the F-ADV-2 notice; lane and canary only; every gate item blocking', () => {
    expect(salesCommercialEligibility(v19)).toEqual({ policyVersion: 'F1-COMMERCIAL-POLICY-v2', shippingAllowed: true });
    expect(salesCommercialEligibility(SALES_PRODUCTION_PROFILE_V18)).toEqual({ policyVersion: 'F1-COMMERCIAL-POLICY-v1' });
    expect(SALES_QUOTE_DOCUMENT_PROFILES.has('sales-production@19')).toBe(true);
    expect(SALES_HUMAN_REQUEST_NOTICE_PROFILES).toContain('sales-production@19');
    expect(SALES_LANE_PROFILES.map(profileLabel)).toContain('sales-production@19');
    expect(CANARY_PROFILES.map(profileLabel)).toContain('sales-production@19');
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@19');
    expect(() => selectedSalesProductionProfile(env('sales-production@19').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@19').config, { lane: true })).toBe(v19);
    expect(salesProductionActionPolicy(v19)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(isQuoteLaneProfile(v19)).toBe(true);
    expect(SALES_PRODUCTION_PROFILE_V19_GATE.every((g) => g.blocking)).toBe(true);
    expect(SALES_PRODUCTION_PROFILE_V19_GATE.map((g) => g.id)).toEqual(expect.arrayContaining(['ux-l3', 'document-delivery-l3', 'profile-19-registered', 'explicit-authorization']));
  });
});

describe('definition v18 (registered in production on 2026-11-10, pinned by no profile, never changed) = v17 with the no-delivery, offer and validity rules', () => {
  const v17 = loadSalesAgentDefinition(17);
  const v18 = loadSalesAgentDefinition(18);
  const lines17 = v17.instructions.split('\n');
  const lines18 = v18.instructions.split('\n');
  it('removes the shipping.quote and promotion rules; no instruction names shipping.quote or the delivery promotion', () => {
    expect(lines17.some((l) => l.startsWith('- shipping.quote: '))).toBe(true);
    expect(lines18.some((l) => l.startsWith('- shipping.quote: ') || l.startsWith('- Despacho Directo promotion: '))).toBe(false);
    expect(v18.instructions).not.toMatch(/shipping\.quote|Despacho Directo|\$1/);
  });

  it('states the F1 delivery rule: no delivery offers, prices, promotions or pickup, no commune; a person for delivery questions', () => {
    const rule = lines18.find((l) => l.startsWith('- Delivery: '))!;
    expect(rule).toMatch(/issued without delivery/);
    expect(rule).toMatch(/Do not offer, price or promise delivery, carriers, delivery promotions, delivery dates or store pickup, and do not ask for a commune or an address/);
    expect(rule).toMatch(/a person of the team can coordinate it/);
    expect(lines18.find((l) => l.startsWith('- Before quote.preview, record exclude_shipping'))).toMatch(/clear_delivery_destination first/);
  });

  it('interprets acceptance in natural language: no literal phrase; never a question, rejection, hesitation or change', () => {
    const create = lines18.find((l) => l.startsWith('- quote.create: '))!;
    expect(create).toMatch(/shows that they want that quote, in any natural wording .*no literal phrase is needed/);
    expect(create).toMatch(/Never propose it when the reply asks something, rejects, hesitates, sets a condition or asks for a change/);
    expect(create).toMatch(/never repeat the same offer without answering/);
    expect(create).toMatch(/never ask the customer to write a specific phrase or word: any natural answer works/);
    expect(v18.instructions).not.toContain('explicitly confirms it');
    expect(v18.instructions).not.toContain('it already asks for an explicit confirmation');
  });

  it('presents the offer in the turn the quote is asked, and leaves the exact expiry to the platform', () => {
    const preview = lines18.find((l) => l.startsWith('- quote.preview: '))!;
    expect(preview).toMatch(/read quote\.preview in that same turn: never ask first whether to prepare or present it/);
    expect(preview).toMatch(/your reply is presentation\.offerMessage exactly as given and nothing else/);
    const create = lines18.find((l) => l.startsWith('- quote.create: '))!;
    expect(create).toMatch(/say that it is valid for 60 minutes; the PDF that follows states the exact expiry date and time in Chile: never state, compute or convert the expiry date or time yourself/);
    expect(create).toMatch(/the platform itself sends the issued quote's PDF/);
  });

  it('changes nothing else: same fields, and every other instruction line of v17 is kept', () => {
    const changed = new Set(['- Delivery modality: ', '- Record with sales.workspace.update', '- When the customer chooses one of the shipping.quote', '- shipping.quote: ', '- Despacho Directo promotion: ', '- quote.preview: ', '- quote.create: ']);
    const kept = lines17.filter((l) => ![...changed].some((p) => l.startsWith(p)));
    expect(kept.every((l) => lines18.includes(l))).toBe(true);
    expect(lines18.length).toBe(lines17.length - 2);
    const { instructions: _a, version: _b, description: _c, ...rest18 } = v18;
    const { instructions: _d, version: _e, description: _f, ...rest17 } = v17;
    expect(rest18).toEqual(rest17);
  });

  it('is a candidate file: the plain bootstrap never registers it', async () => {
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@18');
  });
});

describe('definition v19 = v17 (delivery rules kept) with the offer, acceptance and validity rules of v18', () => {
  const v17 = loadSalesAgentDefinition(17);
  const v18 = loadSalesAgentDefinition(18);
  const v19 = loadSalesAgentDefinition(19);
  const lines17 = v17.instructions.split('\n');
  const lines19 = v19.instructions.split('\n');
  const line = (lines: string[], prefix: string) => lines.find((l) => l.startsWith(prefix))!;
  it('keeps every v17 delivery rule (shipping.quote offers, the Despacho Directo promotion as returned, no pickup unless returned)', () => {
    for (const prefix of ['- Delivery modality: ', '- shipping.quote: ', '- Despacho Directo promotion: ', '- When the customer chooses one of the shipping.quote', '- Record with sales.workspace.update']) {
      expect(line(lines19, prefix)).toBe(line(lines17, prefix));
    }
  });

  it('changes only the quote.preview and quote.create rules; the rest of v17 and every other field are unchanged', () => {
    const changed = lines19.filter((l) => !lines17.includes(l));
    expect(changed.map((l) => l.split(':')[0])).toEqual(['- quote.preview', '- quote.create']);
    expect(lines19.length).toBe(lines17.length);
    const { instructions: _a, version: _b, description: _c, ...rest19 } = v19;
    const { instructions: _d, version: _e, description: _f, ...rest17 } = v17;
    expect(rest19).toEqual(rest17);
  });

  it('quote.preview: in the same turn once delivery is chosen or excluded; quote.create: the v18 rule verbatim (natural acceptance, validity, PDF)', () => {
    const preview = line(lines19, '- quote.preview: ');
    expect(preview).toContain('the shipping choice is recorded (or delivery excluded) and the customer asks for a quote, read quote.preview in that same turn: never ask first whether to prepare or present it');
    // The v18 rule, with delivery, destination and carrier named as changes (an offer may now include delivery).
    expect(line(lines19, '- quote.create: ')).toBe(line(v18.instructions.split('\n'), '- quote.create: ').replace('asks for a change (another product, variant, colour or quantity)', 'asks for a change (another product, variant, colour, quantity, delivery, destination or carrier)'));
  });

  it('is a candidate file: the plain bootstrap never registers it', async () => {
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@19');
  });
});
