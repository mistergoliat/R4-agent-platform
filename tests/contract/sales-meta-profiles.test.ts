import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { assertProductionProfile, loadProductionConfig, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureShipping, type CatalogPort, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { CAPABILITY_IDS, LANE_CAPABILITY_IDS, SALES_AGENT_DIR } from '@r4-sales/agent';
import {
  SALES_FACEBOOK_PROFILE_V1,
  SALES_INSTAGRAM_PROFILE_V1,
  SALES_LANE_PROFILES,
  SALES_META_PROFILES,
  SALES_NON_PAUSING_CONSULTATION_PROFILES,
  SALES_PRODUCTION_PROFILES,
  SALES_WEB_PROFILES,
  SALES_WEB_PROFILE_V1,
  composeSalesGateway,
  composeSalesMetaGateway,
  composeSalesProductionWorker,
  composeSalesWebGateway,
  loadSalesMetaAgentDefinition,
  runProductionControl,
  salesAgentOf,
  salesCatalogSourceOf,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * ADR-060 M1 + ADR-053 (one agent per channel): sales-instagram@1 (Instagram Direct) and sales-facebook@1 (Messenger on
 * the Page). Each is the web chat's reads (Catalog V2 + Discover + Shipping) and nothing else, on its own channel, served
 * only by its own gateway and worker, with its own definition line.
 */
const production = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const noStore = { readControls: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const noPool = { query: () => Promise.reject(new Error('no db')) } as never;
const metaEnv = { R4_META_PAGE_ID: '1111111111', R4_META_INSTAGRAM_ACCOUNT_ID: '17840000000000001', R4_META_PAGE_ACCESS_TOKEN: 't'.repeat(40), R4_WHATSAPP_APP_SECRET: 's'.repeat(40), R4_WHATSAPP_VERIFY_TOKEN: 'verify', R4_META_GRAPH_BASE_URL: 'http://127.0.0.1:9' };
const composeWorker = (label: string, options: { discover?: CatalogDiscoverPort | null } = {}) =>
  composeSalesProductionWorker({
    pool: noPool, store: noStore, production: production(label), modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) }, logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort), ...(options.discover === null ? {} : { catalogDiscover: options.discover ?? discover }), shipping: http(new FixtureShipping() as ShippingService),
  });
const READS = [CAPABILITY_IDS.catalogSearch, CAPABILITY_IDS.productContext, LANE_CAPABILITY_IDS.catalogDiscover, CAPABILITY_IDS.shippingQuote];

describe.each([
  { profile: SALES_INSTAGRAM_PROFILE_V1, label: 'sales-instagram@1', agentId: 'sales-instagram', channel: 'instagram' },
  { profile: SALES_FACEBOOK_PROFILE_V1, label: 'sales-facebook@1', agentId: 'sales-facebook', channel: 'facebook' },
])('$label: its own channel and agent, read only', ({ profile, label, agentId, channel }) => {
  it('is the web chat reads on its channel, without any write; media is told to the agent', () => {
    expect(profileLabel(assertProductionProfile(profile))).toBe(label);
    expect(profile.channel.id).toBe(channel);
    expect(profile.domains).toEqual(SALES_WEB_PROFILE_V1.domains);
    expect(profile.capabilities.map((c) => c.capabilityId)).toEqual(READS);
    expect(profile.capabilities.every((c) => c.effect === 'read')).toBe(true);
    expect(profile.unsupportedContent).toBe('inform_agent');
    expect(salesCatalogSourceOf(profile)).toBe('v2');
    expect(SALES_NON_PAUSING_CONSULTATION_PROFILES.has(label)).toBe(true);
  });

  it('the worker composes exactly those four reads, Discover required, and serves only its agent', () => {
    const { bindings, report } = composeWorker(label);
    expect(bindings.capabilities.list().map((c) => c.capabilityId).sort()).toEqual([...READS].sort());
    expect(report.writes).toEqual({ allow: [], deny: [], requireApproval: [] });
    expect(bindings.servedAgents).toEqual([{ agentId, version: 1 }]);
    expect(bindings.presence?.runtimeProfile).toBe(label);
    expect(() => composeWorker(label, { discover: null })).toThrow(/requires Catalog V2 Discover/);
  });

  it('its gateway binds only its channel, opens its agent\'s tasks and never describes a secret', () => {
    const { bindings, describe: described } = composeSalesMetaGateway({ pool: noPool, production: production(label), env: metaEnv });
    expect(bindings.inbound.map((a) => a.channel)).toEqual([channel]);
    expect(bindings.outbound.map((a) => a.channel)).toEqual([channel]);
    expect(bindings.lane).toBeUndefined();
    expect(bindings.inspection).toBeUndefined();
    expect(bindings.taskFactory.request({ bindingId: 'b1', channel })).toMatchObject({ agentId, agentVersion: 1, taskType: 'sales.conversation' });
    expect(bindings.humanRequestNotice?.profiles).toEqual([label]);
    expect(JSON.stringify(described)).not.toMatch(/t{40}|s{40}/);
    expect(() => composeSalesMetaGateway({ pool: noPool, production: production(label), env: { ...metaEnv, R4_META_PAGE_ACCESS_TOKEN: '' } })).toThrow(/R4_META_PAGE_ACCESS_TOKEN is missing/);
  });

  it('administers its kill switch like the others (next check is the database)', async () => {
    const err: string[] = [];
    const env = { R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: label, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' };
    expect(await runProductionControl(['autonomy', 'on', '--reason', 'test'], env, { out: () => undefined, err: (l) => err.push(l) })).toBe(1);
    expect(err.join(' ')).toMatch(/production_config_incomplete: R4_DATABASE_URL/);
  });

  it('runs its own definition line: read scopes only, plain text with store links, no handoff, no writes', () => {
    const definition = loadSalesMetaAgentDefinition(agentId);
    expect(salesAgentOf(profile)).toEqual({ agentId, version: 1 });
    expect(definition.capabilityScopes).toEqual(['catalog.read', 'shipping.read']);
    expect(definition.instructions).not.toMatch(/quote\.create|quote\.preview|sales\.workspace\.update|customer\.get_context|catalog\.build_step|\[\[/);
    for (const rule of [/plain text only/, /the publicUrl of a catalog\.get_product_context observation/, /never build, shorten or guess a URL/, /Never use request_handoff in this channel/, /blocking=false/, /never claim or imply that you are a person/, /Never invent or estimate them/, /\+56 9 6631 2284/]) {
      expect(definition.instructions).toMatch(rule);
    }
  });
});

describe('the two Meta agents', () => {
  it('differ by channel: Instagram a training buddy first, Facebook the sales advisor', () => {
    const instagram = loadSalesMetaAgentDefinition('sales-instagram').instructions;
    const facebook = loadSalesMetaAgentDefinition('sales-facebook').instructions;
    expect(instagram).toMatch(/through Instagram Direct/);
    expect(instagram).toMatch(/Be first a training buddy/);
    expect(instagram).toMatch(/never push a sale/);
    expect(instagram).toMatch(/responde a una historia de la cuenta/);
    expect(facebook).toMatch(/through Messenger on the store's Facebook Page/);
    expect(facebook).toMatch(/Be the store's sales advisor/);
    expect(facebook).not.toMatch(/training buddy|historia/);
    expect(() => loadSalesMetaAgentDefinition('sales-web')).toThrow(/not a Sales Meta agent/);
  });

  it('are isolated: never WhatsApp or web profiles, never selectable by their gateways; a Meta gateway takes no other profile', async () => {
    const labels = SALES_META_PROFILES.map(profileLabel);
    expect(labels).toEqual(['sales-instagram@1', 'sales-facebook@1', 'sales-instagram@2', 'sales-facebook@2']);
    for (const label of labels) {
      expect([...SALES_PRODUCTION_PROFILES, ...SALES_LANE_PROFILES, ...SALES_WEB_PROFILES].map(profileLabel)).not.toContain(label);
      expect(() => selectedSalesProductionProfile(production(label).config, { lane: true })).toThrow(/not a Sales production profile/);
      expect(() => composeSalesGateway({ pool: noPool, production: production(label), env: metaEnv })).toThrow(/not a Sales production profile/);
      expect(() => composeSalesWebGateway({ pool: noPool, production: production(label), env: {} })).toThrow(/not a Sales web profile/);
    }
    for (const other of ['sales-production@26', 'sales-production@27', 'sales-web@20']) expect(() => composeSalesMetaGateway({ pool: noPool, production: production(other), env: metaEnv })).toThrow(/not a Sales Meta profile/);
    expect(() => composeSalesMetaGateway({ pool: noPool, production: production('sales-instagram@1'), env: { ...metaEnv, R4_META_INSTAGRAM_ACCOUNT_ID: '' } })).toThrow(/R4_META_INSTAGRAM_ACCOUNT_ID is missing/);
    expect(composeSalesMetaGateway({ pool: noPool, production: production('sales-facebook@1'), env: { ...metaEnv, R4_META_INSTAGRAM_ACCOUNT_ID: '' } }).bindings.inbound[0]!.channel).toBe('facebook');
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => e.definition.agentId)).not.toEqual(expect.arrayContaining(['sales-instagram']));
    expect(loaded.map((e) => e.definition.agentId)).not.toEqual(expect.arrayContaining(['sales-facebook']));
  });
});
