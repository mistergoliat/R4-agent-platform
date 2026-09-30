import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertProductionProfile, capabilityAvailability, loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { createSilentLogger } from '@r4/observability';
import { CAPABILITY_IDS } from '@r4-sales/agent';
import {
  SALES_DOMAINS,
  SALES_PRODUCTION_PROFILE,
  SALES_PRODUCTION_PROFILE_V2_CANDIDATE,
  SALES_PRODUCTION_PROFILE_V2_GATE,
  SALES_PRODUCTION_V2_CATALOG_BINDING,
  composeSalesProductionWorker,
} from '@r4-sales/agent/production';
import { CATALOG_ENV } from '@r4-adapters/catalog-http';

/**
 * R4-J1C: profile v2 is PREPARED, not enabled. The deployed v1 profile (and
 * its fingerprint, part of the execution contract) is unchanged, and nothing
 * can compose v2 yet.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const V1_FINGERPRINT = 'bd30523fba7cd17b2996af8205862e30c6756b4efb812777d00c2a5f9f84d313';

describe('Sales production profile v1 is untouched', () => {
  it('v1 keeps its deployed fingerprint and Catalog stays UNAVAILABLE in it', () => {
    expect(profileLabel(SALES_PRODUCTION_PROFILE)).toBe('sales-production@1');
    expect(profileFingerprint(SALES_PRODUCTION_PROFILE)).toBe(V1_FINGERPRINT);
    expect(SALES_PRODUCTION_PROFILE.domains[SALES_DOMAINS.catalog]!.status).toBe('UNAVAILABLE');
  });
});

describe('Sales production profile v2 (candidate, not enabled)', () => {
  it('is a valid production profile that differs from v1 only in the Catalog domain', () => {
    const v2 = assertProductionProfile(SALES_PRODUCTION_PROFILE_V2_CANDIDATE);
    expect(profileLabel(v2)).toBe('sales-production@2');
    expect(v2.domains[SALES_DOMAINS.catalog]).toMatchObject({ status: 'REAL', contractRef: expect.stringContaining('schemaVersion 1') as string });
    const { [SALES_DOMAINS.catalog]: _v2c, ...v2Rest } = v2.domains;
    const { [SALES_DOMAINS.catalog]: _v1c, ...v1Rest } = SALES_PRODUCTION_PROFILE.domains;
    expect(v2Rest).toEqual(v1Rest);
    expect(v2.capabilities).toEqual(SALES_PRODUCTION_PROFILE.capabilities);
    expect(v2.channel).toEqual(SALES_PRODUCTION_PROFILE.channel);
  });

  it('offers only the READ Catalog capabilities; Customer/Shipping stay unavailable; quotes still need approval', () => {
    const v2 = SALES_PRODUCTION_PROFILE_V2_CANDIDATE;
    expect(capabilityAvailability(v2, CAPABILITY_IDS.catalogSearch)).toEqual({ available: true, reason: 'read_real' });
    expect(capabilityAvailability(v2, CAPABILITY_IDS.productContext)).toEqual({ available: true, reason: 'read_real' });
    for (const id of [CAPABILITY_IDS.customerContext, CAPABILITY_IDS.shippingQuote]) expect(capabilityAvailability(v2, id).available).toBe(false);
    expect(v2.capabilities.find((c) => c.capabilityId === CAPABILITY_IDS.quoteCreate)).toMatchObject({ effect: 'write', decision: 'REQUIRE_APPROVAL' });
  });

  it('declares the HTTP binding, its required env, read-only authority, timeouts and freshness semantics', () => {
    const b = SALES_PRODUCTION_V2_CATALOG_BINDING;
    expect(b).toMatchObject({ binding: 'http', authority: { effect: 'read', writes: expect.stringContaining('none') as string } });
    expect(Object.keys(b.requiredEnv).sort()).toEqual([...CATALOG_ENV].sort());
    expect(b.authority.modelCapabilities).toEqual([CAPABILITY_IDS.catalogSearch, CAPABILITY_IDS.productContext]);
    expect(b.freshness.recorded).toContain('ADR-030');
    expect(b.timeouts.capabilityTimeoutMs).toBe(10_000);
  });

  it('every enablement gate is blocking and open', () => {
    expect(SALES_PRODUCTION_PROFILE_V2_GATE.map((g) => g.id)).toEqual(['owner-commit', 'prod-unknowns', 'owner-decisions', 'live-read-only-smoke', 'explicit-authorization']);
    expect(SALES_PRODUCTION_PROFILE_V2_GATE.every((g) => g.blocking)).toBe(true);
  });

  it('nothing composes v2: composition, bootstrap and control accept only v1', () => {
    const production = loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@2', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
    const noStore = { readControls: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
    expect(() => composeSalesProductionWorker({ pool: { query: () => Promise.reject(new Error('no db')) } as never, store: noStore, production, modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) }, logger: createSilentLogger() })).toThrow(/sales-production@1/);
    for (const f of ['composition.ts', 'bootstrap.ts', 'control.ts']) expect(readFileSync(join(ROOT, 'agents/sales/src/production', f), 'utf8'), f).not.toMatch(/PROFILE_V2|profile-v2/);
  });
});
