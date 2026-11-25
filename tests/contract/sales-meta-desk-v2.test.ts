import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { assertProductionProfile, loadProductionConfig, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureShipping, type CatalogPort, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { DESK_DOMAIN, DESK_OPPORTUNITY_CAPABILITY_ID } from '@r4-sales/agent';
import {
  SALES_FACEBOOK_PROFILE_V1,
  SALES_FACEBOOK_PROFILE_V2,
  SALES_INSTAGRAM_PROFILE_V1,
  SALES_INSTAGRAM_PROFILE_V2,
  SALES_META_DESK_ACTION_POLICY,
  SALES_NON_PAUSING_CONSULTATION_PROFILES,
  SALES_PRODUCTION_ACTION_POLICY,
  composeSalesMetaGateway,
  composeSalesProductionWorker,
  loadSalesMetaAgentDefinition,
  salesActionPolicyFor,
  salesAgentOf,
  salesCatalogSourceOf,
} from '@r4-sales/agent/production';

/**
 * (ADR-062 O1, all channels) sales-instagram@2 and sales-facebook@2 = v1 plus desk.opportunity.record@1 (write, ALLOW,
 * autonomous; their only write), pinned to definition v2 = v1 plus the opportunity-record block (no quote, no handoff).
 */
const production = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '100', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const noStore = { readControls: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const noPool = { query: () => Promise.reject(new Error('no db')) } as never;
const metaEnv = { R4_META_PAGE_ID: '1111111111', R4_META_INSTAGRAM_ACCOUNT_ID: '17840000000000001', R4_META_PAGE_ACCESS_TOKEN: 't'.repeat(40), R4_WHATSAPP_APP_SECRET: 's'.repeat(40), R4_WHATSAPP_VERIFY_TOKEN: 'verify', R4_META_GRAPH_BASE_URL: 'http://127.0.0.1:9' };
const deskIngest = { url: 'http://127.0.0.1:3201/api/r4/opportunities', key: 'k'.repeat(40) };
const composeWorker = (label: string, desk = true) =>
  composeSalesProductionWorker({
    pool: noPool, store: noStore, production: production(label), modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) }, logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort), catalogDiscover: discover, shipping: http(new FixtureShipping() as ShippingService), ...(desk ? { deskIngest } : {}),
  });
const ids = (label: string, desk = true) => composeWorker(label, desk).bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();

describe.each([
  { v1: SALES_INSTAGRAM_PROFILE_V1, v2: SALES_INSTAGRAM_PROFILE_V2, label: 'sales-instagram@2', agentId: 'sales-instagram', channel: 'instagram' },
  { v1: SALES_FACEBOOK_PROFILE_V1, v2: SALES_FACEBOOK_PROFILE_V2, label: 'sales-facebook@2', agentId: 'sales-facebook', channel: 'facebook' },
])('$label: v1 plus the desk record', ({ v1, v2, label, agentId, channel }) => {
  it('v1 domains, channel and reads plus the desk write (ALLOW) on its own REAL domain', () => {
    expect(profileLabel(assertProductionProfile(v2))).toBe(label);
    expect(v2.channel).toEqual(v1.channel);
    expect(v2.channel.id).toBe(channel);
    expect(v2.unsupportedContent).toBe(v1.unsupportedContent);
    const { [DESK_DOMAIN]: desk, ...rest } = v2.domains;
    expect(rest).toEqual(v1.domains);
    expect(desk?.status).toBe('REAL');
    expect(v2.capabilities).toEqual([...v1.capabilities, { capabilityId: DESK_OPPORTUNITY_CAPABILITY_ID, domain: DESK_DOMAIN, effect: 'write', decision: 'ALLOW' }]);
    expect(salesCatalogSourceOf(v2)).toBe('v2');
    expect(SALES_NON_PAUSING_CONSULTATION_PROFILES.has(label)).toBe(true);
  });

  it('the worker composes the v1 reads plus the desk record, serves agent v2, and fails closed without the desk ingest', () => {
    const v1Label = profileLabel(v1);
    expect(ids(label)).toEqual([...ids(v1Label, false), `${DESK_OPPORTUNITY_CAPABILITY_ID}@1`].sort());
    const { bindings, report } = composeWorker(label);
    expect(report.writes).toEqual({ allow: [DESK_OPPORTUNITY_CAPABILITY_ID], deny: [], requireApproval: [] });
    expect(bindings.servedAgents).toEqual([{ agentId, version: 2 }]);
    expect(salesAgentOf(v2)).toEqual({ agentId, version: 2 });
    expect(() => composeWorker(label, false)).toThrow(new RegExp(`${label} records opportunities in the sales desk but no desk ingest was configured`));
  });

  it('its own action policy: the v1 policy plus the desk record ALLOW; v1 keeps its policy object', () => {
    expect(salesActionPolicyFor(v2)).toBe(SALES_META_DESK_ACTION_POLICY);
    expect(salesActionPolicyFor(v1)).toBe(SALES_PRODUCTION_ACTION_POLICY);
    expect(SALES_META_DESK_ACTION_POLICY.capabilities).toEqual({ ...SALES_PRODUCTION_ACTION_POLICY.capabilities, [DESK_OPPORTUNITY_CAPABILITY_ID]: { autonomy: 'allow' } });
  });

  it('its gateway binds its channel and opens tasks pinned to agent v2', () => {
    const { bindings } = composeSalesMetaGateway({ pool: noPool, production: production(label), env: metaEnv });
    expect(bindings.inbound.map((a) => a.channel)).toEqual([channel]);
    expect(profileLabel(bindings.profile)).toBe(label);
  });

  it('definition v2 = v1 byte for byte plus the block: consultation and conversation only, never a quote or handoff trigger', () => {
    const d1 = loadSalesMetaAgentDefinition(agentId, 1);
    const d2 = loadSalesMetaAgentDefinition(agentId, 2);
    expect(d2.instructions.startsWith(d1.instructions)).toBe(true);
    const block = d2.instructions.slice(d1.instructions.length + 1).split('\n');
    expect(block.slice(0, 2)).toEqual(['', 'Sales opportunities (internal)']);
    expect(block).toHaveLength(5);
    for (const must of ['request_consultation (trigger=consulta)', 'trigger=conversacion', 'never use trigger=cotizacion or trigger=traspaso here']) expect(block[2]).toContain(must);
    expect(block[2]).not.toMatch(/request_handoff|quote\.create/);
    expect(block[4]).toMatch(/^- Never mention the record, the opportunity, the CRM or the sales desk to the contact\./);
    expect(d2.capabilityScopes).toEqual([...d1.capabilityScopes, 'desk.opportunity.write']);
    const { instructions: _a, version, description: _b, capabilityScopes: _c, ...rest2 } = d2;
    const { instructions: _d, version: _e, description: _f, capabilityScopes: _g, ...rest1 } = d1;
    expect(version).toBe(2);
    expect(rest2).toEqual(rest1);
  });
});
