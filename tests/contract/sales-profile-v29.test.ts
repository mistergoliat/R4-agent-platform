import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { loadSalesAgentDefinition } from '@r4-sales/agent';
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
  SALES_PRODUCTION_PROFILE_V28,
  SALES_PRODUCTION_PROFILE_V28_GATE,
  SALES_PRODUCTION_PROFILE_V29,
  SALES_PRODUCTION_PROFILE_V29_GATE,
  SALES_QUOTE_DOCUMENT_PROFILES,
  SALES_QUOTE_RECOVERY_PROFILES,
  SALES_STOCK_COUNT_PROFILES,
  SALES_VARIANT_AVAILABILITY_PROFILES,
  SALES_WEB_PROFILE_V22,
  SALES_WEB_PROFILE_V23,
  SALES_WEB_QUOTE_PROFILES,
  composeSalesProductionWorker,
  isQuoteLaneProfile,
  loadSalesWebAgentDefinition,
  salesActionPolicyFor,
  salesAgentOf,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * (Owner 2026-11-25, the sales-web@22 exam) sales-web@23 = @22 and sales-production@29 = @28, each pinned to a new
 * definition (v23 / v29) with four instruction changes: B2B and project needs handed to a person and recorded as
 * traspaso, the closing line only after the second insistence, a new record when real buying intent follows a joke,
 * off-topic replies in at most two short sentences and one card. Same capabilities and controls; @22 / @28 unchanged.
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

describe.each([
  { next: SALES_WEB_PROFILE_V23, prev: SALES_WEB_PROFILE_V22, label: 'sales-web@23', prevLabel: 'sales-web@22', agent: { agentId: 'sales-web', version: 23 } },
  { next: SALES_PRODUCTION_PROFILE_V29, prev: SALES_PRODUCTION_PROFILE_V28, label: 'sales-production@29', prevLabel: 'sales-production@28', agent: { agentId: 'sales', version: 29 } },
])('$label: $prevLabel pinned to its new definition', ({ next, prev, label, prevLabel, agent }) => {
  it('same domains, channel and capabilities; its own version and fingerprint; serves its definition', () => {
    expect(profileLabel(next)).toBe(label);
    const { version: _a, description: _b, ...restNext } = next;
    const { version: _c, description: _d, ...restPrev } = prev;
    expect(restNext).toEqual(restPrev);
    expect(profileFingerprint(next)).not.toBe(profileFingerprint(prev));
    expect(salesAgentOf(next)).toEqual(agent);
  });

  it('composes exactly what the previous profile composes (desk.opportunity.record@2 included), with the same action policy', () => {
    expect(ids(label)).toEqual(ids(prevLabel));
    expect(ids(label)).toContain('desk.opportunity.record@2');
    expect(salesActionPolicyFor(next)).toBe(salesActionPolicyFor(prev));
    const { taskObservations: _, ...noObservations } = options(label);
    expect(() => composeSalesProductionWorker(noObservations)).toThrow(/no task observation reader was provided/);
  });

  it('inherits every label-keyed control of the previous profile', () => {
    const sets = [SALES_DESK_SIGNALS_PROFILES, SALES_AUTONOMOUS_QUOTE_PROFILES, SALES_CONFIRMED_INTENT_PROFILES, SALES_DETERMINISTIC_OFFER_PROFILES, SALES_VARIANT_AVAILABILITY_PROFILES, SALES_QUOTE_DOCUMENT_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES, SALES_F1_SHIPPING_PROFILES, SALES_QUOTE_RECOVERY_PROFILES, SALES_STOCK_COUNT_PROFILES, SALES_NON_PAUSING_CONSULTATION_PROFILES, SALES_WEB_QUOTE_PROFILES];
    for (const set of sets) expect(set.has(label), [...set].join(',')).toBe(set.has(prevLabel));
    const lists = [SALES_HUMAN_REQUEST_NOTICE_PROFILES, SALES_COHORT_LANE_PROFILES, SALES_LANE_PROFILES.map(profileLabel), CANARY_PROFILES.map(profileLabel), SALES_PRODUCTION_PROFILES.map(profileLabel)];
    for (const list of lists) expect(list.includes(label)).toBe(list.includes(prevLabel));
    expect(isQuoteLaneProfile(next)).toBe(isQuoteLaneProfile(prev));
  });
});

describe('@29 lane gate and selection', () => {
  it('@28 items (except its registration and authorization) plus the volume-notice L3, the @29 registration and the authorization; no wholesale threshold', () => {
    const inherited = SALES_PRODUCTION_PROFILE_V28_GATE.filter((g) => g.id !== 'profile-28-registered' && g.id !== 'explicit-authorization');
    expect(SALES_PRODUCTION_PROFILE_V29_GATE.map((g) => g.id)).toEqual([...inherited.map((g) => g.id), 'volume-notice-l3', 'profile-29-registered', 'explicit-authorization']);
    const req = SALES_PRODUCTION_PROFILE_V29_GATE.find((g) => g.id === 'volume-notice-l3')!.requirement;
    for (const must of ['no volume discounts', 'no prices, discounts or conditions', 'trigger=traspaso and segment=mayorista', 'no request_handoff']) expect(req).toContain(must);
  });
  it('lane only, never a production profile; first in the cohort lanes, @28 its rollback', () => {
    expect(() => selectedSalesProductionProfile(env('sales-production@29').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@29').config, { lane: true })).toBe(SALES_PRODUCTION_PROFILE_V29);
    expect(SALES_COHORT_LANE_PROFILES.slice(0, 2)).toEqual(['sales-production@29', 'sales-production@28']);
  });
});

/** The exam fixes (and, web only, the goodbye marker), nothing else. */
describe.each([
  { name: 'sales-web v23', prev: () => loadSalesWebAgentDefinition(22), next: () => loadSalesWebAgentDefinition(23), who: 'visitor', web: true },
  { name: 'sales v29', prev: () => loadSalesAgentDefinition(28), next: () => loadSalesAgentDefinition(29), who: 'customer', web: false },
])('definition $name: the exam fixes, nothing else', ({ prev, next, who, web }) => {
  const la = prev().instructions.split('\n');
  const lb = next().instructions.split('\n');
  const volumeAt = lb.findIndex((l) => l.startsWith('- Volume or special prices:'));
  const goodbyeAt = lb.findIndex((l) => l.startsWith('- Goodbye:'));
  const without = lb.filter((_, i) => i !== volumeAt && i !== goodbyeAt);
  const changed = without.map((l, i) => (l === la[i] ? null : i)).filter((i) => i !== null);
  const line = (prefix: string) => without.find((l) => l.startsWith(prefix))!;

  it('the volume line inserted after the small-talk consultation rule (web: also the goodbye line); three lines changed; every other field equal', () => {
    expect(lb).toHaveLength(la.length + (web ? 2 : 1));
    expect(lb[volumeAt - 1]).toMatch(/^- Never use request_consultation for anything that is not commercial/);
    if (web) expect(lb[goodbyeAt - 1]!.startsWith('- Offer [[contacto]] at most once per conversation')).toBe(true);
    else expect(goodbyeAt).toBe(-1);
    expect(changed).toEqual([la.findIndex((l) => l.startsWith('- Absurd or joke questions')), la.findIndex((l) => l.startsWith(`- If the ${who} insists`)), la.findIndex((l) => l.startsWith('- desk.opportunity.record: records'))]);
    const { instructions: _a, version: _b, description: _c, ...restB } = next();
    const { instructions: _d, version: _e, description: _f, ...restA } = prev();
    expect(restB).toEqual(restA);
  });

  it('1. volume or special prices (owner 2026-11-26): no prices, the wholesale-sellers notice, one traspaso record with segment mayorista; no threshold', () => {
    const volume = lb[volumeAt]!;
    for (const must of [`when the ${who} asks for a discount or a special price for quantity or volume`, 'a store, an institution, a gym or a distributor', 'never state prices, discounts or conditions', 'Pesas Chile has no volume discounts', '«Para precios por volumen le dejamos un aviso a nuestros vendedores de mayoristas para que te contacten»', 'record it once with desk.opportunity.record, trigger=traspaso and segment=mayorista (for any of those buyers, institutions and gyms included)', 'complexity=proyecto only when they equip a whole facility', 'Then keep helping with anything else', 'Everyone else follows the normal flows']) expect(volume).toContain(must);
    expect(next().instructions).not.toMatch(/UMBRAL|threshold/i);
    expect(lb.some((l) => l.startsWith('- Company, wholesale, institutional or project needs'))).toBe(false);
    const moments = line('- desk.opportunity.record: records');
    if (web) {
      expect(moments).toContain('when you leave the wholesale sellers a notice about volume prices (trigger=traspaso, segment=mayorista);');
    } else {
      // Not a handoff: the conversation stays with Pesín.
      expect(volume).toContain('This is not a handoff: never use request_handoff for it, the conversation stays with you.');
      expect(moments).toContain('when you leave the wholesale sellers a notice about volume prices (trigger=traspaso, segment=mayorista, without request_handoff);');
    }
  });

  it('2. the exact closing line only after the second insistence on the same request', () => {
    const insist = line('- Insistence:');
    for (const must of ['the first time they insist on that same request, decline it politely', 'Only when they insist on it a second time (the third message asking for it)', 'exactly «Cuando quieras ver algo de la tienda, aquí estoy 🙂»', 'not in the first reply of a conversation, not after the first insistence', 'never silence', 'a buying question afterwards is answered normally']) expect(insist).toContain(must);
    expect(lb.some((l) => l.includes('insists with jokes or off-scope requests twice in a row'))).toBe(false);
  });

  it('3. a sin_intencion record does not count: real buying intent with a signal action records again', () => {
    const moments = line('- desk.opportunity.record: records');
    for (const must of ['a sin_intencion record does not count as recorded', 'record again with that buying classification (trigger=conversacion)', 'catalog.get_product_context', 'record products in the selection, quote delivery or read quote.preview', 'never the same record twice']) expect(moments).toContain(must);
  });

  it('4. off-topic replies: at most two short sentences, no list, at most one card', () => {
    const offTopic = line('- Off-topic, absurd or joke messages');
    for (const must of ['at most two short sentences (under 200 characters in all), never a list', 'redirect to the store', 'at most its one card', 'without calling catalog.replacements or listing any', '«a cuánto está el kilo de papa»']) expect(offTopic).toContain(must);
  });

  it('(owner 2026-11-26, web only) a real goodbye ends with [[despedida]]; never a mid-conversation «gracias»', () => {
    if (!web) {
      expect(next().instructions).not.toContain('[[despedida]]');
      return;
    }
    expect(lb[goodbyeAt]).toBe('- Goodbye: when the visitor says goodbye or ends the conversation (for example «chao», «gracias, eso era todo», «nos vemos»), reply with a short, warm goodbye and end the reply with [[despedida]] on its own line; the chat then asks how we did. Only for a real goodbye, never for a «gracias» in the middle of the conversation, and at most once per conversation.');
  });
});
