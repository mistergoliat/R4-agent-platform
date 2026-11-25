import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { assertProductionProfile, loadProductionConfig, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureShipping, type CatalogPort, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { CAPABILITY_IDS, LANE_CAPABILITY_IDS, SALES_AGENT_DIR } from '@r4-sales/agent';
import {
  SALES_LANE_PROFILES,
  SALES_NON_PAUSING_CONSULTATION_PROFILES,
  SALES_PRODUCTION_PROFILES,
  SALES_SOCIAL_PROFILE_V1,
  SALES_WEB_PROFILES,
  SALES_WEB_PROFILE_V1,
  composeSalesGateway,
  composeSalesMetaGateway,
  composeSalesProductionWorker,
  composeSalesWebGateway,
  loadSalesSocialAgentDefinition,
  runProductionControl,
  salesAgentOf,
  salesCatalogSourceOf,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * ADR-060 M1: sales-social@1, Pesín in Meta direct messages (Messenger + Instagram Direct through the Page). The web
 * chat's reads (Catalog V2 + Discover + Shipping) and nothing else, on the `meta` channel, served only by its own
 * gateway and worker, with its own definition line.
 */
const production = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const noStore = { readControls: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const noPool = { query: () => Promise.reject(new Error('no db')) } as never;
const metaEnv = { R4_META_PAGE_ID: '1111111111', R4_META_INSTAGRAM_ACCOUNT_ID: '17840000000000001', R4_META_PAGE_ACCESS_TOKEN: 't'.repeat(40), R4_WHATSAPP_APP_SECRET: 's'.repeat(40), R4_WHATSAPP_VERIFY_TOKEN: 'verify', R4_META_GRAPH_BASE_URL: 'http://127.0.0.1:9' };
const composeWorker = (options: { discover?: CatalogDiscoverPort | null } = {}) =>
  composeSalesProductionWorker({
    pool: noPool, store: noStore, production: production('sales-social@1'), modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) }, logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort), ...(options.discover === null ? {} : { catalogDiscover: options.discover ?? discover }), shipping: http(new FixtureShipping() as ShippingService),
  });

describe('sales-social@1: Meta direct messages, read only', () => {
  it('is the web chat reads on the meta channel, without any write; media is told to the agent', () => {
    expect(profileLabel(assertProductionProfile(SALES_SOCIAL_PROFILE_V1))).toBe('sales-social@1');
    expect(SALES_SOCIAL_PROFILE_V1.channel.id).toBe('meta');
    expect(SALES_SOCIAL_PROFILE_V1.domains).toEqual(SALES_WEB_PROFILE_V1.domains);
    expect(SALES_SOCIAL_PROFILE_V1.capabilities.map((c) => c.capabilityId)).toEqual([CAPABILITY_IDS.catalogSearch, CAPABILITY_IDS.productContext, LANE_CAPABILITY_IDS.catalogDiscover, CAPABILITY_IDS.shippingQuote]);
    expect(SALES_SOCIAL_PROFILE_V1.capabilities.every((c) => c.effect === 'read')).toBe(true);
    expect(SALES_SOCIAL_PROFILE_V1.unsupportedContent).toBe('inform_agent');
    expect(salesCatalogSourceOf(SALES_SOCIAL_PROFILE_V1)).toBe('v2');
    expect(SALES_NON_PAUSING_CONSULTATION_PROFILES.has('sales-social@1')).toBe(true);
  });

  it('the worker composes exactly those four reads, Discover required, and serves only sales-social@1', () => {
    const { bindings, report } = composeWorker();
    expect(bindings.capabilities.list().map((c) => c.capabilityId).sort()).toEqual([CAPABILITY_IDS.catalogSearch, LANE_CAPABILITY_IDS.catalogDiscover, CAPABILITY_IDS.productContext, CAPABILITY_IDS.shippingQuote].sort());
    expect(report.writes).toEqual({ allow: [], deny: [], requireApproval: [] });
    expect(bindings.servedAgents).toEqual([{ agentId: 'sales-social', version: 1 }]);
    expect(bindings.presence?.runtimeProfile).toBe('sales-social@1');
    expect(() => composeWorker({ discover: null })).toThrow(/requires Catalog V2 Discover/);
  });

  it('is isolated: never a WhatsApp or web profile, never selectable by their gateways, and the Meta gateway takes nothing else', () => {
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_LANE_PROFILES, ...SALES_WEB_PROFILES].map(profileLabel)).not.toContain('sales-social@1');
    expect(() => selectedSalesProductionProfile(production('sales-social@1').config, { lane: true })).toThrow(/not a Sales production profile/);
    expect(() => composeSalesGateway({ pool: noPool, production: production('sales-social@1'), env: metaEnv })).toThrow(/not a Sales production profile/);
    expect(() => composeSalesWebGateway({ pool: noPool, production: production('sales-social@1'), env: {} })).toThrow(/not a Sales web profile/);
    for (const other of ['sales-production@26', 'sales-web@20']) expect(() => composeSalesMetaGateway({ pool: noPool, production: production(other), env: metaEnv })).toThrow(/not a Sales Meta profile/);
  });

  it('the Meta gateway binds only the Meta adapters, opens sales-social@1 tasks and never describes a secret', () => {
    const { bindings, describe: described } = composeSalesMetaGateway({ pool: noPool, production: production('sales-social@1'), env: metaEnv });
    expect(bindings.inbound.map((a) => a.channel)).toEqual(['meta']);
    expect(bindings.outbound.map((a) => a.channel)).toEqual(['meta']);
    expect(bindings.lane).toBeUndefined();
    expect(bindings.inspection).toBeUndefined();
    expect(bindings.taskFactory.request({ bindingId: 'b1', channel: 'meta' })).toMatchObject({ agentId: 'sales-social', agentVersion: 1, taskType: 'sales.conversation' });
    expect(bindings.humanRequestNotice?.profiles).toEqual(['sales-social@1']);
    expect(JSON.stringify(described)).not.toMatch(/t{40}|s{40}/);
    expect(() => composeSalesMetaGateway({ pool: noPool, production: production('sales-social@1'), env: { ...metaEnv, R4_META_PAGE_ACCESS_TOKEN: '' } })).toThrow(/R4_META_PAGE_ACCESS_TOKEN is missing/);
  });

  it('a Meta deployment administers its kill switch like the others (next check is the database)', async () => {
    const err: string[] = [];
    const env = { R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-social@1', R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' };
    expect(await runProductionControl(['autonomy', 'on', '--reason', 'test'], env, { out: () => undefined, err: (l) => err.push(l) })).toBe(1);
    expect(err.join(' ')).toMatch(/production_config_incomplete: R4_DATABASE_URL/);
  });

  it('runs its own definition line: read scopes only, plain text with store links, surface tone, no handoff, no writes', async () => {
    const definition = loadSalesSocialAgentDefinition();
    expect(salesAgentOf(SALES_SOCIAL_PROFILE_V1)).toEqual({ agentId: 'sales-social', version: 1 });
    expect(definition.capabilityScopes).toEqual(['catalog.read', 'shipping.read']);
    expect(definition.instructions).not.toMatch(/quote\.create|quote\.preview|sales\.workspace\.update|customer\.get_context|catalog\.build_step|\[\[/);
    for (const rule of [/Canal informado por la plataforma/, /On Instagram, be first a training buddy/, /never push a sale/, /On Messenger, be the store's sales advisor/, /plain text only/, /the publicUrl of a catalog\.get_product_context observation/, /never build, shorten or guess a URL/, /Never use request_handoff in this channel/, /blocking=false/, /never claim or imply that you are a person/, /Never invent or estimate them/, /\+56 9 6631 2284/]) {
      expect(definition.instructions).toMatch(rule);
    }
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => e.definition.agentId)).not.toContain('sales-social');
  });
});
