import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { DESK_OPPORTUNITY_CAPABILITY_ID, loadSalesAgentDefinition } from '@r4-sales/agent';
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
  SALES_PRODUCTION_DESK_ACTION_POLICY,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V27,
  SALES_PRODUCTION_PROFILE_V27_GATE,
  SALES_PRODUCTION_PROFILE_V28,
  SALES_PRODUCTION_PROFILE_V28_GATE,
  SALES_QUOTE_DOCUMENT_PROFILES,
  SALES_QUOTE_RECOVERY_PROFILES,
  SALES_STOCK_COUNT_PROFILES,
  SALES_VARIANT_AVAILABILITY_PROFILES,
  SALES_WEB_DESK_ACTION_POLICY,
  SALES_WEB_PROFILE_V21,
  SALES_WEB_PROFILE_V22,
  SALES_WEB_QUOTE_PROFILES,
  composeSalesProductionWorker,
  isQuoteLaneProfile,
  loadSalesWebAgentDefinition,
  salesActionPolicyFor,
  salesAgentOf,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * (ADR-062, owner 2026-11-25: an opportunity only with a concrete buying signal) sales-web@22 = @21 and
 * sales-production@28 = @27, each with desk.opportunity.record@2 instead of @1; definitions v22 / v28 = v21 / v27 with
 * only the opportunity block changed. @21 and @27 keep @1 and stay the rollbacks.
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
const desk = (profile: string) => ids(profile).filter((id) => id.startsWith(DESK_OPPORTUNITY_CAPABILITY_ID));

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

describe.each([
  { next: SALES_WEB_PROFILE_V22, prev: SALES_WEB_PROFILE_V21, label: 'sales-web@22', prevLabel: 'sales-web@21', agent: { agentId: 'sales-web', version: 22 }, policy: SALES_WEB_DESK_ACTION_POLICY },
  { next: SALES_PRODUCTION_PROFILE_V28, prev: SALES_PRODUCTION_PROFILE_V27, label: 'sales-production@28', prevLabel: 'sales-production@27', agent: { agentId: 'sales', version: 28 }, policy: SALES_PRODUCTION_DESK_ACTION_POLICY },
])('$label: $prevLabel with desk.opportunity.record@2', ({ next, prev, label, prevLabel, agent, policy }) => {
  it('same domains, channel and declared capabilities; its own version and fingerprint; serves its definition', () => {
    expect(profileLabel(next)).toBe(label);
    expect(next.domains).toEqual(prev.domains);
    expect(next.channel).toEqual(prev.channel);
    expect(next.capabilities).toEqual(prev.capabilities);
    expect(profileFingerprint(next)).not.toBe(profileFingerprint(prev));
    expect(salesAgentOf(next)).toEqual(agent);
  });

  it('composes desk.opportunity.record@2 (the previous profile keeps @1); everything else identical', () => {
    expect(SALES_DESK_SIGNALS_PROFILES.has(label)).toBe(true);
    expect(SALES_DESK_SIGNALS_PROFILES.has(prevLabel)).toBe(false);
    expect(desk(label)).toEqual([`${DESK_OPPORTUNITY_CAPABILITY_ID}@2`]);
    expect(desk(prevLabel)).toEqual([`${DESK_OPPORTUNITY_CAPABILITY_ID}@1`]);
    expect(ids(label).filter((id) => !id.startsWith(DESK_OPPORTUNITY_CAPABILITY_ID))).toEqual(ids(prevLabel).filter((id) => !id.startsWith(DESK_OPPORTUNITY_CAPABILITY_ID)));
    expect(composeSalesProductionWorker(options(label)).bindings.consultationsWithoutPause).toBeDefined();
  });

  it('fails closed without the desk ingest or the task observation reader', () => {
    const { deskIngest: _, ...noDesk } = options(label);
    expect(() => composeSalesProductionWorker(noDesk)).toThrow(/no desk ingest was configured/);
    const { taskObservations: __, ...noObservations } = options(label);
    expect(() => composeSalesProductionWorker(noObservations)).toThrow(new RegExp(`${label} records opportunity signals but no task observation reader was provided`));
    const { taskObservations: ___, ...prevWithout } = options(prevLabel);
    expect(() => composeSalesProductionWorker(prevWithout)).not.toThrow();
  });

  it('the same action policy as the previous profile, within the F1 limits', () => {
    expect(salesActionPolicyFor(next)).toBe(policy);
    expect(salesActionPolicyFor(prev)).toBe(policy);
    expect(() => composeSalesProductionWorker({ ...options(label), autonomousQuoteLimits: { ...SALES_F1_CANARY_LIMITS, maxUnitsPerLine: SALES_F1_CANARY_LIMITS.maxUnitsPerLine + 1 } })).toThrow(new RegExp(`${label} runs within the owner-approved canary limits`));
  });

  it('inherits every label-keyed control of the previous profile', () => {
    const sets = [SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_QUOTE_DOCUMENT_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES, SALES_QUOTE_RECOVERY_PROFILES, SALES_STOCK_COUNT_PROFILES, SALES_NON_PAUSING_CONSULTATION_PROFILES, SALES_WEB_QUOTE_PROFILES];
    for (const set of sets) expect(set.has(label), [...set].join(',')).toBe(set.has(prevLabel));
    const lists = [SALES_HUMAN_REQUEST_NOTICE_PROFILES, SALES_COHORT_LANE_PROFILES, SALES_LANE_PROFILES.map(profileLabel), CANARY_PROFILES.map(profileLabel), SALES_PRODUCTION_PROFILES.map(profileLabel)];
    for (const list of lists) expect(list.includes(label)).toBe(list.includes(prevLabel));
    expect(isQuoteLaneProfile(next)).toBe(isQuoteLaneProfile(prev));
  });
});

describe('@28 lane gate and selection', () => {
  it('@27 items (except its registration and authorization) plus desk v2, the no-intent L3, the @28 registration and the authorization', () => {
    const inherited = SALES_PRODUCTION_PROFILE_V27_GATE.filter((g) => g.id !== 'profile-27-registered' && g.id !== 'explicit-authorization');
    expect(SALES_PRODUCTION_PROFILE_V28_GATE.map((g) => g.id)).toEqual([...inherited.map((g) => g.id), 'desk-v2', 'no-intent-l3', 'profile-28-registered', 'explicit-authorization']);
  });
  it('lane only, never a production profile', () => {
    expect(() => selectedSalesProductionProfile(env('sales-production@28').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@28').config, { lane: true })).toBe(SALES_PRODUCTION_PROFILE_V28);
  });
});

describe.each([
  { name: 'sales-web v22', prev: () => loadSalesWebAgentDefinition(21), next: () => loadSalesWebAgentDefinition(22), who: 'visitor' },
  { name: 'sales v28', prev: () => loadSalesAgentDefinition(27), next: () => loadSalesAgentDefinition(28), who: 'customer' },
])('definition $name: only the opportunity block changes', ({ prev, next, who }) => {
  it('every line but the block\'s "when" and "what" lines is identical; same scopes and fields', () => {
    const a = prev();
    const b = next();
    const la = a.instructions.split('\n');
    const lb = b.instructions.split('\n');
    expect(lb).toHaveLength(la.length);
    const at = la.indexOf('Sales opportunities (internal)');
    expect(lb.map((l, i) => (l === la[i] ? null : i)).filter((i) => i !== null)).toEqual([at + 1, at + 2]);
    expect(lb[at + 3]).toBe(la[at + 3]);
    expect(lb[at + 3]).toContain(`to the ${who}`);
    const { instructions: _a, version: _b, description: _c, ...restB } = b;
    const { instructions: _d, version: _e, description: _f, ...restA } = a;
    expect(restB).toEqual(restA);
  });

  it('the same moments; jokes, spam, tests, small talk, out-of-scope and pure technical doubts as sin_intencion, never a purchase', () => {
    const lb = next().instructions.split('\n');
    const at = lb.indexOf('Sales opportunities (internal)');
    const when = lb[at + 1]!;
    for (const must of ['request_consultation (trigger=consulta)', 'quote.create issued a quote', 'trigger=cotizacion', 'trigger=conversacion', 'record it all the same with intent sin_intencion and its reason']) expect(when).toContain(must);
    const what = lb[at + 2]!;
    for (const must of ['sin_intencion', 'broma', 'spam', 'prueba', 'casual', 'fuera_de_alcance', 'duda_tecnica', '«cuéntame un cuento sobre la taza mug»', '«a cuánto está el kilo de papa»', '«q pasa choro»', 'Never present a joke, a test or small talk as a purchase', 'noIntentReason only with sin_intencion']) expect(what).toContain(must);
  });
});
