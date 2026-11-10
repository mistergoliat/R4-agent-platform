import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { capabilityAvailability, profileFingerprint, profileLabel } from '@r4/live-ops';
import { CAPABILITY_IDS, LANE_CAPABILITY_IDS, SALES_AGENT_DIR, loadSalesAgentDefinition } from '@r4-sales/agent';
import {
  SALES_CANARY_ONLY_PROFILES,
  SALES_LANE_PROFILES,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V3,
  SALES_PRODUCTION_PROFILE_V13,
  salesProductionAgentVersion,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * ADR-045: sales-production@13, the E1 lane profile. It is @3 with Catalog V2 and catalog.discover, runs definition
 * v13 (v4 plus one Discover line), is never a production gateway's main profile and never registered by accident.
 */
describe('sales-production@13 (E1 lane)', () => {
  it('is @3 plus catalog.discover; Quote, Customer and every write but the workspace stay unavailable', () => {
    const v13 = SALES_PRODUCTION_PROFILE_V13;
    expect(profileLabel(v13)).toBe('sales-production@13');
    expect(v13.capabilities).toEqual([...SALES_PRODUCTION_PROFILE_V3.capabilities, { capabilityId: LANE_CAPABILITY_IDS.catalogDiscover, domain: 'catalog', effect: 'read' }]);
    expect({ ...v13.domains, catalog: null }).toEqual({ ...SALES_PRODUCTION_PROFILE_V3.domains, catalog: null });
    expect(v13.domains.catalog?.contractRef).toMatch(/catalog-discover-v1b1 \(DRAFT_NOT_PUBLISHED, owner commit 5f2c086\)/);
    for (const id of [CAPABILITY_IDS.quoteCreate, CAPABILITY_IDS.customerContext]) expect(capabilityAvailability(v13, id).available, id).toBe(false);
    expect(capabilityAvailability(v13, LANE_CAPABILITY_IDS.catalogDiscover).available).toBe(true);
    expect(v13.channel).toEqual(SALES_PRODUCTION_PROFILE_V3.channel);
  });

  it('@3 is untouched (the deployed fingerprint does not depend on the lane)', () => {
    expect(profileFingerprint(SALES_PRODUCTION_PROFILE_V3)).not.toBe(profileFingerprint(SALES_PRODUCTION_PROFILE_V13));
    expect(SALES_PRODUCTION_PROFILE_V3.capabilities.map((c) => c.capabilityId)).not.toContain(LANE_CAPABILITY_IDS.catalogDiscover);
  });

  it('is selectable only as a worker (lane) profile: not in the production or canary lists, refused as a gateway main profile', () => {
    expect(SALES_LANE_PROFILES.map(profileLabel)).toEqual(['sales-production@13', 'sales-production@14', 'sales-production@15', 'sales-production@16', 'sales-production@17', 'sales-production@18']);
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@13');
    const config = { policyProfile: 'sales-production@13' } as never;
    expect(() => selectedSalesProductionProfile(config)).toThrow(/not a Sales production profile/);
    expect(profileLabel(selectedSalesProductionProfile(config, { lane: true }))).toBe('sales-production@13');
    expect(salesProductionAgentVersion(SALES_PRODUCTION_PROFILE_V13)).toBe(13);
  });

  it('definition v13 is v4 verbatim plus exactly one catalog.discover guidance line', () => {
    const v4 = loadSalesAgentDefinition(4);
    const v13 = loadSalesAgentDefinition(13);
    const added = v13.instructions.split('\n').filter((line) => !v4.instructions.split('\n').includes(line));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^- catalog\.discover: /);
    expect(v13.instructions.replace(`${added[0]}\n`, '')).toBe(v4.instructions);
    const { instructions: _a, version: _b, description: _c, ...rest13 } = v13;
    const { instructions: _d, version: _e, description: _f, ...rest4 } = v4;
    expect(rest13).toEqual(rest4);
  });

  it('v13 is a candidate file: the plain bootstrap (every *.agent.json) never registers it, nor makes it "latest"', async () => {
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@13');
    expect(Math.max(...loaded.filter((e) => e.definition.agentId === 'sales').map((e) => e.definition.version))).toBe(8);
  });
});
