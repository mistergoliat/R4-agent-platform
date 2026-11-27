import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { CANARY_PROFILES } from '@r4-sales/agent/canary';
import {
  SALES_AUTONOMOUS_QUOTE_PROFILES,
  SALES_COHORT_LANE_PROFILES,
  SALES_CONFIRMED_INTENT_PROFILES,
  SALES_DESK_SIGNALS_PROFILES,
  SALES_DETERMINISTIC_OFFER_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_F1_SHIPPING_PROFILES,
  SALES_HUMAN_REQUEST_NOTICE_PROFILES,
  SALES_INTENT_ACCEPTANCE_PROFILES,
  SALES_LANE_PROFILES,
  SALES_NON_PAUSING_CONSULTATION_PROFILES,
  SALES_PRODUCTION_PROFILES,
  SALES_QUOTE_DOCUMENT_PROFILES,
  SALES_QUOTE_RECOVERY_PROFILES,
  SALES_STOCK_COUNT_PROFILES,
  SALES_VARIANT_AVAILABILITY_PROFILES,
  SALES_WEB_PROFILES,
  SALES_WEB_PROFILE_V23,
  SALES_WEB_PROFILE_V24,
  SALES_WEB_QUOTE_PROFILES,
  composeSalesProductionWorker,
  loadSalesWebAgentDefinition,
  salesActionPolicyFor,
  salesAgentOf,
} from '@r4-sales/agent/production';

/**
 * (Owner 2026-11-26, response time) sales-web@24 = sales-web@23 plus catalog.get_products_context (several products in
 * one read), pinned to definition v24 = v23 with the product-reading rules. Production evidence: of 27 web product
 * reads in 14 days, 20 were of products a list result had already returned and 17 re-read the same product, 16 within
 * 300 s. Everything else is @23's; @23 is unchanged.
 */
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const options = (profile: string) => ({
  pool: { query: () => Promise.reject(new Error('no db')) } as never, store: noStore, production: env(profile),
  modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) }, logger: createSilentLogger(),
  catalog: http(new FixtureCatalog() as CatalogPort), catalogDiscover: discover, shipping: http(new FixtureShipping() as ShippingService),
  quotes: http(new FixtureQuoteV2Service() as QuoteV2Service), autonomousQuoteLimits: SALES_F1_CANARY_LIMITS,
  deskIngest: { url: 'http://127.0.0.1:3201/api/r4/opportunities', key: 'k'.repeat(40) },
  taskObservations: { listByTask: () => Promise.resolve([]) },
});
const ids = (profile: string) => composeSalesProductionWorker(options(profile)).bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();

let previousGraph: string | undefined;
beforeAll(() => {
  previousGraph = process.env.R4_EXP_GRAPH_FILE;
  const file = join(mkdtempSync(join(tmpdir(), 'r4-graph-')), 'graph.json');
  writeFileSync(file, JSON.stringify({ products: {}, view: {} }));
  process.env.R4_EXP_GRAPH_FILE = file;
});
afterAll(() => {
  if (previousGraph === undefined) delete process.env.R4_EXP_GRAPH_FILE;
  else process.env.R4_EXP_GRAPH_FILE = previousGraph;
});

describe('sales-web@24: @23 plus catalog.get_products_context, pinned to definition v24', () => {
  it('@23 plus one read capability; its own version and fingerprint; serves definition v24', () => {
    expect(profileLabel(SALES_WEB_PROFILE_V24)).toBe('sales-web@24');
    const { version: _a, description: _b, capabilities: capsNext, ...restNext } = SALES_WEB_PROFILE_V24;
    const { version: _c, description: _d, capabilities: capsPrev, ...restPrev } = SALES_WEB_PROFILE_V23;
    expect(restNext).toEqual(restPrev);
    expect(capsNext).toEqual([...capsPrev, { capabilityId: 'catalog.get_products_context', domain: 'catalog', effect: 'read' }]);
    expect(profileFingerprint(SALES_WEB_PROFILE_V24)).not.toBe(profileFingerprint(SALES_WEB_PROFILE_V23));
    expect(salesAgentOf(SALES_WEB_PROFILE_V24)).toEqual({ agentId: 'sales-web', version: 24 });
    expect(SALES_WEB_PROFILES.at(-1)).toBe(SALES_WEB_PROFILE_V24);
  });

  it("composes @23's capabilities plus catalog.get_products_context@1, with the same action policy", () => {
    expect(ids('sales-web@24')).toEqual([...ids('sales-web@23'), 'catalog.get_products_context@1'].sort());
    expect(ids('sales-web@23')).not.toContain('catalog.get_products_context@1');
    expect(salesActionPolicyFor(SALES_WEB_PROFILE_V24)).toBe(salesActionPolicyFor(SALES_WEB_PROFILE_V23));
  });

  it('inherits every label-keyed control of @23', () => {
    const sets = [SALES_DESK_SIGNALS_PROFILES, SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_QUOTE_DOCUMENT_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES, SALES_QUOTE_RECOVERY_PROFILES, SALES_STOCK_COUNT_PROFILES, SALES_NON_PAUSING_CONSULTATION_PROFILES, SALES_WEB_QUOTE_PROFILES];
    for (const set of sets) expect(set.has('sales-web@24'), [...set].join(',')).toBe(set.has('sales-web@23'));
    const lists = [SALES_HUMAN_REQUEST_NOTICE_PROFILES, SALES_COHORT_LANE_PROFILES, SALES_LANE_PROFILES.map(profileLabel), CANARY_PROFILES.map(profileLabel), SALES_PRODUCTION_PROFILES.map(profileLabel)];
    for (const list of lists) expect(list.includes('sales-web@24')).toBe(list.includes('sales-web@23'));
  });
});

describe('definition sales-web v24: the product-reading rules, nothing else', () => {
  const prev = loadSalesWebAgentDefinition(23);
  const next = loadSalesWebAgentDefinition(24);
  const la = prev.instructions.split('\n');
  const lb = next.instructions.split('\n');
  const readingAt = lb.findIndex((l) => l.startsWith('- Reading products:'));
  const without = lb.filter((_, i) => i !== readingAt);
  const changed = without.map((l, i) => (l === la[i] ? null : i)).filter((i) => i !== null);
  const BATCH = 'catalog.get_products_context';

  it('one bullet inserted right after the catalog.* line; four lines name the batch read; every other field equal', () => {
    expect(lb).toHaveLength(la.length + 1);
    expect(lb[readingAt - 1]!.startsWith('- catalog.*:')).toBe(true);
    expect(changed).toEqual([
      la.findIndex((l) => l.startsWith('- Product cards:')),
      la.findIndex((l) => l.startsWith('- The cards and the set total')),
      la.findIndex((l) => l.startsWith('- catalog.*:')),
      la.findIndex((l) => l.startsWith('- desk.opportunity.record:')),
    ]);
    // Each changed line only adds the batch read to what v23 said.
    for (const i of changed) {
      expect(without[i]).toContain(BATCH);
      expect(la[i]).not.toContain(BATCH);
    }
    const { instructions: _a, version: _b, description: _c, ...restNext } = next;
    const { instructions: _d, version: _e, description: _f, ...restPrev } = prev;
    expect(restNext).toEqual(restPrev);
    expect(next.version).toBe(24);
  });

  it('the reading rules: lists already carry price and stock, details only for what a list lacks, several products in one call, no re-read while current', () => {
    const rule = lb[readingAt]!;
    for (const must of [
      'catalog.search, catalog.discover, catalog.replacements and catalog.build_step already carry',
      "never read a product's context just to re-confirm its price or stock",
      'only for details the list does not carry',
      `read them in ONE ${BATCH} call (up to 8 productKeys), never one by one`,
      'Never read again a product already read in this conversation while that read is still current',
    ]) expect(rule).toContain(must);
  });

  it("keeps @23's goodbye marker and volume notice", () => {
    expect(lb.filter((l) => l.startsWith('- Goodbye:'))).toEqual(la.filter((l) => l.startsWith('- Goodbye:')));
    expect(lb.filter((l) => l.startsWith('- Volume or special prices:'))).toEqual(la.filter((l) => l.startsWith('- Volume or special prices:')));
    expect(next.instructions).toContain('[[despedida]]');
  });
});
