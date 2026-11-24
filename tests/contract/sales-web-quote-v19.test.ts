import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { QUOTE_EMAIL_CAPABILITY_ID, QUOTE_PARITY_REQUIRED_PROFILES, SALES_AGENT_DIR } from '@r4-sales/agent';
import {
  SALES_AUTONOMOUS_QUOTE_PROFILES,
  SALES_CONFIRMED_INTENT_PROFILES,
  SALES_DETERMINISTIC_OFFER_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_F1_SHIPPING_PROFILES,
  SALES_INTENT_ACCEPTANCE_PROFILES,
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_PROFILE_V26,
  SALES_QUOTE_DOCUMENT_PROFILES,
  SALES_VARIANT_AVAILABILITY_PROFILES,
  SALES_WEB_PROFILE_V18,
  SALES_WEB_PROFILE_V19,
  SALES_WEB_QUOTE_ACTION_POLICY,
  SALES_WEB_QUOTE_PROFILES,
  composeSalesProductionWorker,
  loadSalesWebAgentDefinition,
  salesActionPolicyFor,
} from '@r4-sales/agent/production';

/**
 * (ADR-057 C4) sales-web@19 = @18 + the formal quote by email: the WhatsApp lane's autonomous issuance (same controls)
 * and quote.email@1 behind the same kill-switch-guarded Quote port. The cards and the store cart stay the default.
 */
const production = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const options = (profile: string) => ({
    pool: { query: () => Promise.reject(new Error('no db')) } as never, store: noStore, production: production(profile),
    modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) }, logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort), catalogDiscover: discover, shipping: http(new FixtureShipping() as ShippingService),
    quotes: http(new FixtureQuoteV2Service() as QuoteV2Service), autonomousQuoteLimits: SALES_F1_CANARY_LIMITS,
});
const compose = (profile: string) => composeSalesProductionWorker(options(profile));

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

describe('sales-web@19: the formal quote by email (ADR-057 C4)', () => {
  it('is @18 plus Quote REAL and the lane issuance capabilities, plus quote.email; same channel', () => {
    expect(profileLabel(SALES_WEB_PROFILE_V19)).toBe('sales-web@19');
    expect(SALES_WEB_PROFILE_V19.channel).toEqual(SALES_WEB_PROFILE_V18.channel);
    expect(SALES_WEB_PROFILE_V19.domains.quote?.status).toBe('REAL');
    const added = SALES_WEB_PROFILE_V19.capabilities.filter((c) => !SALES_WEB_PROFILE_V18.capabilities.some((x) => x.capabilityId === c.capabilityId));
    expect(added.map((c) => `${c.capabilityId}:${c.effect}:${'decision' in c ? c.decision : '-'}`).sort()).toEqual(
      ['quote.create:write:ALLOW', 'quote.email:write:ALLOW', 'quote.preview:read:-', 'sales.workspace.update:write:ALLOW'].sort(),
    );
  });

  it('runs every control the WhatsApp lane issues under, except the WhatsApp PDF and the retired parity set', () => {
    for (const set of [SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES, SALES_WEB_QUOTE_PROFILES]) {
      expect(set.has('sales-web@19'), [...set].join(',')).toBe(true);
      expect(set.has('sales-web@18')).toBe(false);
    }
    expect(SALES_QUOTE_DOCUMENT_PROFILES.has('sales-web@19')).toBe(false);
    expect(QUOTE_PARITY_REQUIRED_PROFILES.has('sales-web@19')).toBe(QUOTE_PARITY_REQUIRED_PROFILES.has(profileLabel(SALES_PRODUCTION_PROFILE_V26)));
  });

  it('its own action policy: the autonomous one plus quote.email; every other profile keeps its policy object', () => {
    expect(salesActionPolicyFor(SALES_WEB_PROFILE_V19)).toBe(SALES_WEB_QUOTE_ACTION_POLICY);
    expect(SALES_WEB_QUOTE_ACTION_POLICY.capabilities).toEqual({ ...SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY.capabilities, 'quote.email': { autonomy: 'allow', minimumIdentity: 'provisional' } });
    expect(salesActionPolicyFor(SALES_PRODUCTION_PROFILE_V26)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
  });

  it('composes issuance and quote.email (behind the guarded Quote port), within the F1 limits; @18 composes neither', () => {
    const w19 = compose('sales-web@19').bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`);
    for (const id of ['quote.preview@4', 'quote.create@6', 'sales.workspace.update@2', `${QUOTE_EMAIL_CAPABILITY_ID}@1`]) expect(w19).toContain(id);
    const w18 = compose('sales-web@18').bindings.capabilities.list().map((c) => c.capabilityId);
    expect(w18.filter((id) => id.startsWith('quote.') || id === 'sales.workspace.update')).toEqual([]);
    expect(() => composeSalesProductionWorker({ ...options('sales-web@19'), autonomousQuoteLimits: { ...SALES_F1_CANARY_LIMITS, maxUnitsPerLine: SALES_F1_CANARY_LIMITS.maxUnitsPerLine + 1 } })).toThrow(/sales-web@19 runs within the owner-approved canary limits/);
  });
});

describe('definition sales-web v19 = v18 + the formal quote by email', () => {
  const v18 = loadSalesWebAgentDefinition(18);
  const v19 = loadSalesWebAgentDefinition(19);
  const v26 = (JSON.parse(require('node:fs').readFileSync(`${SALES_AGENT_DIR}/candidates/sales.v26.candidate.json`, 'utf8')) as { instructions: string }).instructions.split('\n');
  const l18 = v18.instructions.split('\n');
  const l19 = v19.instructions.split('\n');

  it('seven lines added after shipping.quote, and the formal quote is no longer sent to [[contacto]]', () => {
    expect(l19.length).toBe(l18.length + 7);
    expect(l18.some((l) => l.startsWith('- A formal quote, a special price'))).toBe(true);
    expect(l19.some((l) => l.startsWith('- A formal quote'))).toBe(false);
    expect(l19).toContain(l18.find((l) => l.startsWith('- A formal quote, a special price'))!.replace('- A formal quote, a special price', '- A special price'));
    const at = l19.findIndex((l) => l.startsWith('- shipping.quote:'));
    const prefixes = ['- Formal quote by email:', '- Delivery modality:', '- Record with sales.workspace.update', '- When the customer chooses one of the shipping.quote', '- quote.preview:', '- quote.create:', '- quote.email:'];
    l19.slice(at + 1, at + 8).forEach((l, n) => expect(l.startsWith(prefixes[n]!), l.slice(0, 60)).toBe(true));
  });

  it('the lane lines are the WhatsApp v26 ones (exact, or with the web substitutions only)', () => {
    for (const prefix of ['- Delivery modality:', '- Record with sales.workspace.update', '- When the customer chooses one of the shipping.quote (basis=order) offers']) expect(l19).toContain(v26.find((l) => l.startsWith(prefix)));
    const preview = l19.find((l) => l.startsWith('- quote.preview:'))!;
    expect(preview).toContain('Never use request_handoff on this website');
    expect(preview).not.toMatch(/use request_handoff in that turn/);
    const create = l19.find((l) => l.startsWith('- quote.create:'))!;
    expect(create).not.toMatch(/60 minutes|acá mismo|You cannot send the quote by email/);
    expect(create).toMatch(/send it with quote\.email/);
  });

  it('quote.email: only the address the visitor wrote, masked back, never promised; scopes for the writes', () => {
    const rule = l19.find((l) => l.startsWith('- quote.email:'))!;
    for (const must of ['exactly as the visitor wrote it', 'never guess, complete or correct one yourself', 'recipientMasked', 'never that it arrived', 'never promise the email']) expect(rule).toContain(must);
    expect(l19.find((l) => l.startsWith('- Formal quote by email:'))).toMatch(/never offer it unprompted/);
    expect(v19.capabilityScopes).toEqual([...v18.capabilityScopes, 'sales.workspace.write', 'quote.create', 'quote.email']);
  });
});
