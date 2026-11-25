import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { QUOTE_EMAIL_CAPABILITY_ID, QUOTE_PARITY_REQUIRED_PROFILES } from '@r4-sales/agent';
import {
  SALES_AUTONOMOUS_QUOTE_PROFILES,
  SALES_CONFIRMED_INTENT_PROFILES,
  SALES_DETERMINISTIC_OFFER_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_F1_SHIPPING_PROFILES,
  SALES_INTENT_ACCEPTANCE_PROFILES,
  SALES_NON_PAUSING_CONSULTATION_PROFILES,
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_PROFILE_V26,
  SALES_QUOTE_DOCUMENT_PROFILES,
  SALES_VARIANT_AVAILABILITY_PROFILES,
  SALES_WEB_PROFILE_V19,
  SALES_WEB_PROFILE_V20,
  SALES_WEB_QUOTE_ACTION_POLICY,
  SALES_WEB_QUOTE_PROFILES,
  composeSalesProductionWorker,
  loadSalesWebAgentDefinition,
  salesActionPolicyFor,
} from '@r4-sales/agent/production';

/**
 * (Owner 2026-11-24) sales-web@20 = @19 pinned to definition v20: the home-gym plan is sized to the budget range and,
 * when the set stays below the bottom of the range, Pesín offers to raise a piece or add pieces. Everything else is @19.
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

describe('sales-web@20: @19 with the home-gym plan sized to the budget', () => {
  it('same channel, domains and capabilities as @19', () => {
    expect(profileLabel(SALES_WEB_PROFILE_V20)).toBe('sales-web@20');
    expect(SALES_WEB_PROFILE_V20.channel).toEqual(SALES_WEB_PROFILE_V19.channel);
    expect(SALES_WEB_PROFILE_V20.domains).toEqual(SALES_WEB_PROFILE_V19.domains);
    expect(SALES_WEB_PROFILE_V20.capabilities).toEqual(SALES_WEB_PROFILE_V19.capabilities);
  });

  it('inherits every control keyed by label: lane issuance sets, web quote set, non-pausing consultations, parity', () => {
    for (const set of [SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES, SALES_WEB_QUOTE_PROFILES, SALES_NON_PAUSING_CONSULTATION_PROFILES]) {
      expect(set.has('sales-web@20'), [...set].join(',')).toBe(true);
    }
    expect(SALES_QUOTE_DOCUMENT_PROFILES.has('sales-web@20')).toBe(false);
    expect(QUOTE_PARITY_REQUIRED_PROFILES.has('sales-web@20')).toBe(QUOTE_PARITY_REQUIRED_PROFILES.has('sales-web@19'));
  });

  it('the same action policy as @19; composes issuance and quote.email within the F1 limits', () => {
    expect(salesActionPolicyFor(SALES_WEB_PROFILE_V20)).toBe(SALES_WEB_QUOTE_ACTION_POLICY);
    expect(salesActionPolicyFor(SALES_PRODUCTION_PROFILE_V26)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    const w20 = compose('sales-web@20').bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();
    const w19 = compose('sales-web@19').bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();
    expect(w20).toEqual(w19);
    expect(w20).toContain(`${QUOTE_EMAIL_CAPABILITY_ID}@1`);
    expect(compose('sales-web@20').bindings.consultationsWithoutPause).toBeDefined();
    expect(() => composeSalesProductionWorker({ ...options('sales-web@20'), autonomousQuoteLimits: { ...SALES_F1_CANARY_LIMITS, maxUnitsPerLine: SALES_F1_CANARY_LIMITS.maxUnitsPerLine + 1 } })).toThrow(/sales-web@20 runs within the owner-approved canary limits/);
  });
});

describe('definition sales-web v20 = v19 with the plan, the end of the build and the closing set changed', () => {
  const v19 = loadSalesWebAgentDefinition(19);
  const v20 = loadSalesWebAgentDefinition(20);
  const l19 = v19.instructions.split('\n');
  const l20 = v20.instructions.split('\n');

  it('exactly three lines change: the plan size, the end of the build and the closing set', () => {
    expect(l20).toHaveLength(l19.length);
    const changed = l20.map((l, i) => (l === l19[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toHaveLength(3);
    // F2 2026-11-25: the closing reply listed only the main pieces and sent the visitor back to earlier messages.
    const closing = l20.find((l) => l.startsWith('- When the plan is done, reply with the whole chosen set'))!;
    for (const must of ['the extra pieces and complements included', 'each on its own line with its card', 'never only the main pieces and never send them back to earlier messages', 'never add a piece they did not pick']) expect(closing).toContain(must);
    const plan = l20.find((l) => l.startsWith('- From the objective, space and budget'))!;
    for (const must of ['up to $1,5 millones, 3 to 5 pieces', '$1,5 a $4 millones, 5 to 8 pieces', '$4 a $8 millones or more, 7 to 10 pieces', 'after a rack always come barra and discos']) expect(plan).toContain(must);
    const end = l20.find((l) => l.startsWith('- When the plan is done, compare the set total'))!;
    for (const must of ['below the bottom of the range', 'raise the level of a piece already chosen', 'until the set reaches the range or the visitor says it is enough', 'Never go above the top of the range']) expect(end).toContain(must);
    expect(v20.instructions).toContain('Never exceed the stated budget');
  });

  it('every other field equals v19', () => {
    expect({ ...v20, version: 19, description: '', instructions: '' }).toEqual({ ...v19, description: '', instructions: '' });
    expect(v20.version).toBe(20);
  });
});
