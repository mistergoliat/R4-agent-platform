import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { assertProductionProfile, loadProductionConfig, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureShipping, type CatalogPort, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { CAPABILITY_IDS, LANE_CAPABILITY_IDS, SALES_AGENT_DIR } from '@r4-sales/agent';
import {
  SALES_LANE_PROFILES,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V13,
  SALES_WEB_PROFILE_V1,
  SALES_WEB_PROFILE_V2,
  SALES_WEB_PROFILE_V3,
  SALES_WEB_PROFILE_V4,
  SALES_WEB_PROFILE_V5,
  SALES_WEB_PROFILE_V6,
  SALES_WEB_RUN_FAILURE_FALLBACK_TEXT,
  SALES_WEB_HUMAN_REQUEST_NOTICE_TEXT,
  composeSalesGateway,
  composeSalesProductionWorker,
  composeSalesWebGateway,
  loadSalesWebAgentDefinition,
  runProductionControl,
  salesAgentOf,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * ADR-046: sales-web@1, the store website chat. Same Sales pack, its own identity (sales-web) and definition line,
 * Catalog V2 + Discover + Shipping READ-ONLY, on the `web` channel, served only by its own gateway and worker.
 */
const production = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const noStore = { readControls: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const noPool = { query: () => Promise.reject(new Error('no db')) } as never;
const webEnv = { R4_WEB_ACCOUNT_REF: 'shop-qa', R4_WEB_SHARED_SECRET: 's'.repeat(40), R4_WEB_EDGE_URL: 'http://127.0.0.1:8094' };
const composeWorker = (options: { discover?: CatalogDiscoverPort | null } = {}) =>
  composeSalesProductionWorker({
    pool: noPool, store: noStore, production: production('sales-web@1'), modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) }, logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort), ...(options.discover === null ? {} : { catalogDiscover: options.discover ?? discover }), shipping: http(new FixtureShipping() as ShippingService),
  });

describe('sales-web@1: a read-only web profile of the same Sales pack', () => {
  it('is @13 on the web channel without any write: only Catalog (with Discover) and Shipping reads', () => {
    expect(profileLabel(assertProductionProfile(SALES_WEB_PROFILE_V1))).toBe('sales-web@1');
    expect(SALES_WEB_PROFILE_V1.channel.id).toBe('web');
    expect(SALES_WEB_PROFILE_V1.domains).toEqual(SALES_PRODUCTION_PROFILE_V13.domains);
    expect(SALES_WEB_PROFILE_V1.capabilities.map((c) => c.capabilityId)).toEqual([CAPABILITY_IDS.catalogSearch, CAPABILITY_IDS.productContext, LANE_CAPABILITY_IDS.catalogDiscover, CAPABILITY_IDS.shippingQuote]);
    expect(SALES_WEB_PROFILE_V1.capabilities.every((c) => c.effect === 'read')).toBe(true);
  });

  it('the worker composes exactly those four reads, Discover required, and serves only sales-web@1', () => {
    const { bindings, report } = composeWorker();
    expect(bindings.capabilities.list().map((c) => c.capabilityId).sort()).toEqual([CAPABILITY_IDS.catalogSearch, LANE_CAPABILITY_IDS.catalogDiscover, CAPABILITY_IDS.productContext, CAPABILITY_IDS.shippingQuote].sort());
    expect(report.writes).toEqual({ allow: [], deny: [], requireApproval: [] });
    expect(bindings.servedAgents).toEqual([{ agentId: 'sales-web', version: 1 }]);
    expect(bindings.presence?.runtimeProfile).toBe('sales-web@1');
    expect(() => composeWorker({ discover: null })).toThrow(/requires Catalog V2 Discover/);
  });

  it('is isolated from WhatsApp: never a production or lane profile, never selectable by the WhatsApp gateway', () => {
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_LANE_PROFILES].map(profileLabel)).not.toContain('sales-web@1');
    expect(() => selectedSalesProductionProfile(production('sales-web@1').config, { lane: true })).toThrow(/not a Sales production profile/);
    expect(() => composeSalesGateway({ pool: noPool, production: production('sales-web@1'), env: {} })).toThrow(/not a Sales production profile/);
    expect(() => composeSalesWebGateway({ pool: noPool, production: production('sales-production@13'), env: webEnv })).toThrow(/not a Sales web profile/);
  });

  it('the web gateway binds only the web adapters and opens sales-web@1 tasks', () => {
    const { bindings, describe: described } = composeSalesWebGateway({ pool: noPool, production: production('sales-web@1'), env: webEnv });
    expect(bindings.inbound.map((a) => a.channel)).toEqual(['web']);
    expect(bindings.outbound.map((a) => a.channel)).toEqual(['web']);
    expect(bindings.lane).toBeUndefined();
    expect(bindings.taskFactory.request({ bindingId: 'b1', channel: 'web' })).toMatchObject({ agentId: 'sales-web', agentVersion: 1, taskType: 'sales.conversation' });
    expect(JSON.stringify(described)).not.toContain('s'.repeat(40));
  });

  it('a web deployment administers its own kill switch: production control accepts the web profile (next check is the database)', async () => {
    const err: string[] = [];
    const env = { R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-web@1', R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' };
    expect(await runProductionControl(['autonomy', 'on', '--reason', 'test'], env, { out: () => undefined, err: (l) => err.push(l) })).toBe(1);
    expect(err.join(' ')).toMatch(/production_config_incomplete: R4_DATABASE_URL/);
    expect(err.join(' ')).not.toMatch(/not a Sales production profile/);
  });

  it('runs its own definition line (sales-web@1): no write or quote scope, never registered by the plain bootstrap', async () => {
    const definition = loadSalesWebAgentDefinition();
    expect(salesAgentOf(SALES_WEB_PROFILE_V1)).toEqual({ agentId: 'sales-web', version: 1 });
    expect(salesAgentOf(SALES_PRODUCTION_PROFILE_V13)).toEqual({ agentId: 'sales', version: 13 });
    expect(definition.capabilityScopes).toEqual(['catalog.read', 'shipping.read']);
    expect(definition.instructions).not.toMatch(/quote\.create|sales\.workspace\.update|customer\.get_context/);
    expect(definition.instructions).toMatch(/no verificado/);
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => e.definition.agentId)).not.toContain('sales-web');
  });
});

describe('sales-web@2: product cards (W2), same reads, still no write', () => {
  it('is sales-web@1 with its own definition version: same channel and capabilities, pins sales-web@2', () => {
    expect(profileLabel(assertProductionProfile(SALES_WEB_PROFILE_V2))).toBe('sales-web@2');
    expect({ ...SALES_WEB_PROFILE_V2, version: 1, description: '' }).toEqual({ ...SALES_WEB_PROFILE_V1, description: '' });
    expect(salesAgentOf(SALES_WEB_PROFILE_V2)).toEqual({ agentId: 'sales-web', version: 2 });
    const { bindings } = composeSalesWebGateway({ pool: noPool, production: production('sales-web@2'), env: webEnv });
    expect(bindings.taskFactory.request({ bindingId: 'b1', channel: 'web' })).toMatchObject({ agentId: 'sales-web', agentVersion: 2 });
    expect(() => composeSalesGateway({ pool: noPool, production: production('sales-web@2'), env: {} })).toThrow(/not a Sales production profile/);
  });

  it('its definition cites verified catalog keys for the store cards and never URLs; v1 is unchanged', () => {
    const v1 = loadSalesWebAgentDefinition(1);
    const v2 = loadSalesWebAgentDefinition(2);
    expect(v2.capabilityScopes).toEqual(v1.capabilityScopes);
    expect(v2.instructions).toMatch(/\[\[P1651\]\]/);
    expect(v2.instructions).toMatch(/\[\[P1675-V463\]\]/);
    expect(v2.instructions).toMatch(/Never write URLs or links/);
    expect(v2.instructions).toMatch(/never say you added, reserved or ordered anything/);
    expect(v1.instructions).not.toMatch(/\[\[P/);
    expect({ ...v2, version: 1, description: '', instructions: '' }).toEqual({ ...v1, description: '', instructions: '' });
  });
});

describe('sales-web@3: Don Pesín, reply buttons and the guided home-gym set (W3 stage 1), still no write', () => {
  it('is sales-web@1 with its own definition version and pins sales-web@3', () => {
    expect(profileLabel(assertProductionProfile(SALES_WEB_PROFILE_V3))).toBe('sales-web@3');
    expect({ ...SALES_WEB_PROFILE_V3, version: 1, description: '' }).toEqual({ ...SALES_WEB_PROFILE_V1, description: '' });
    expect(salesAgentOf(SALES_WEB_PROFILE_V3)).toEqual({ agentId: 'sales-web', version: 3 });
    expect(() => composeSalesGateway({ pool: noPool, production: production('sales-web@3'), env: {} })).toThrow(/not a Sales production profile/);
  });

  it('presents itself as Don Pesín, an AI that never claims to be a person, and keeps every v2 rule', () => {
    const v2 = loadSalesWebAgentDefinition(2);
    const v3 = loadSalesWebAgentDefinition(3);
    expect(v3.capabilityScopes).toEqual(v2.capabilityScopes);
    expect(v3.instructions).toMatch(/You are Don Pesín/);
    expect(v3.instructions).toMatch(/never claim or imply that you are a person/);
    expect(v3.instructions).toMatch(/\[\[opciones: A \| B \| C\]\]/);
    expect(v3.instructions).toMatch(/\[\[P123-V45 x2\]\]/);
    expect(v3.instructions).toMatch(/Never exceed the stated budget/);
    for (const rule of [/Never write URLs or links/, /never say you added, reserved or ordered anything/, /no verificado/, /Never invent or estimate them/]) expect(v3.instructions).toMatch(rule);
    expect({ ...v3, version: 2, description: '', instructions: '' }).toEqual({ ...v2, description: '', instructions: '' });
  });
});

describe('sales-web@4: one verification per product per reply (the store cards carry price and stock)', () => {
  it('is sales-web@3 with its own definition version; only the re-read rule changes', () => {
    expect(profileLabel(assertProductionProfile(SALES_WEB_PROFILE_V4))).toBe('sales-web@4');
    expect({ ...SALES_WEB_PROFILE_V4, version: 1, description: '' }).toEqual({ ...SALES_WEB_PROFILE_V1, description: '' });
    expect(salesAgentOf(SALES_WEB_PROFILE_V4)).toEqual({ agentId: 'sales-web', version: 4 });
    const v3 = loadSalesWebAgentDefinition(3);
    const v4 = loadSalesWebAgentDefinition(4);
    expect(v4.instructions).toMatch(/never read the same product twice in one reply/);
    expect(v4.instructions).toMatch(/State a price in the text only when the visitor asks for the price of a specific product/);
    for (const rule of [/You are Don Pesín/, /never claim or imply that you are a person/, /Never exceed the stated budget/, /Never write URLs or links/, /Never invent or estimate them/]) expect(v4.instructions).toMatch(rule);
    expect({ ...v4, version: 3, description: '', instructions: '' }).toEqual({ ...v3, description: '', instructions: '' });
  });
});

describe('sales-web@5: fixed home-gym budget ranges up to large gyms', () => {
  it('is sales-web@4 with the budget buttons fixed and up to five reply buttons', () => {
    expect(profileLabel(assertProductionProfile(SALES_WEB_PROFILE_V5))).toBe('sales-web@5');
    expect(salesAgentOf(SALES_WEB_PROFILE_V5)).toEqual({ agentId: 'sales-web', version: 5 });
    const v4 = loadSalesWebAgentDefinition(4);
    const v5 = loadSalesWebAgentDefinition(5);
    expect(v5.instructions).toContain('[[opciones: Hasta $500 mil | $500 mil a $1,5 millones | $1,5 a $4 millones | $4 a $8 millones | Más de $8 millones]]');
    expect(v5.instructions).toContain('(2 to 5 options, each under 30 characters)');
    for (const rule of [/never read the same product twice in one reply/, /You are Don Pesín/, /Never exceed the stated budget/, /Never write URLs or links/]) expect(v5.instructions).toMatch(rule);
    expect({ ...v5, version: 4, description: '', instructions: '' }).toEqual({ ...v4, description: '', instructions: '' });
  });
});

describe('sales-web@6: an honest way to a person (nobody attends the web chat yet) and the visitor context', () => {
  it('never hands off on the web: shows the store contact instead, and the notices restart instead of blocking', () => {
    expect(profileLabel(assertProductionProfile(SALES_WEB_PROFILE_V6))).toBe('sales-web@6');
    expect(salesAgentOf(SALES_WEB_PROFILE_V6)).toEqual({ agentId: 'sales-web', version: 6 });
    const v5 = loadSalesWebAgentDefinition(5);
    const v6 = loadSalesWebAgentDefinition(6);
    expect(v6.instructions).toMatch(/Never use request_handoff or request_consultation on this website/);
    expect(v6.instructions).toMatch(/add \[\[contacto\]\] on its own line/);
    expect(v6.instructions).toMatch(/store cart and in their Mi gym set/);
    expect(v6.instructions).not.toMatch(/hand the conversation off with request_handoff/);
    for (const rule of [/You are Don Pesín/, /never claim or imply that you are a person/, /Never write URLs or links/, /Never invent or estimate them/]) expect(v6.instructions).toMatch(rule);
    expect({ ...v6, version: 5, description: '', instructions: '' }).toEqual({ ...v5, description: '', instructions: '' });

    const { bindings } = composeSalesWebGateway({ pool: noPool, production: production('sales-web@6'), env: webEnv });
    expect(bindings.runFailureFallback?.text).toBe(SALES_WEB_RUN_FAILURE_FALLBACK_TEXT);
    expect(bindings.humanRequestNotice?.text).toBe(SALES_WEB_HUMAN_REQUEST_NOTICE_TEXT);
    for (const text of [SALES_WEB_RUN_FAILURE_FALLBACK_TEXT, SALES_WEB_HUMAN_REQUEST_NOTICE_TEXT]) {
      expect(text).toContain('[[contacto]]');
      expect(text).toContain('[[nueva-conversacion]]');
      expect(text).not.toMatch(/Ya avisé|seguirá la conversación|llegará por este mismo chat/);
    }
  });
});
