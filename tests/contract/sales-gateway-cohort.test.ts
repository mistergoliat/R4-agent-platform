import { describe, expect, it } from 'vitest';
import { loadProductionConfig, profileLabel } from '@r4/live-ops';
import { SALES_LANE_PROFILES, composeSalesGateway } from '@r4-sales/agent/production';

/**
 * (ADR-045 amendment 1) The Sales WhatsApp gateway composes R4_PROD_ROLLOUT_PERCENT > 0 only with an owner-approved
 * cohort lane (sales-production@22): never with the cohort on the main profile, never with another lane profile.
 */
const KEY = 'b'.repeat(64);
const WHATSAPP = {
  R4_WHATSAPP_APP_SECRET: 'app-secret-test-0001', R4_WHATSAPP_VERIFY_TOKEN: 'verify-token-test-0001', R4_WHATSAPP_ACCESS_TOKEN: 'access-token-test-0001',
  R4_WHATSAPP_PHONE_NUMBER_ID: '100000000000001', R4_WHATSAPP_GRAPH_BASE_URL: 'http://127.0.0.1:9',
};
const production = (percent: number) => loadProductionConfig({
  R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@3', R4_PROD_ROLLOUT_PERCENT: String(percent),
  R4_PROD_ROLLOUT_ALLOWLIST: KEY, R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false',
});
const gateway = (percent: number, laneProfile?: string) => composeSalesGateway({
  pool: {} as never, production: production(percent),
  env: { ...WHATSAPP, ...(laneProfile ? { R4_PROD_LANE_PROFILE: laneProfile, R4_PROD_LANE_ALLOWLIST: KEY } : {}) },
});

describe('Sales WhatsApp gateway: rollout percentage and the cohort lane', () => {
  it('0 % composes as before, with or without a lane (any lane profile)', () => {
    expect(gateway(0).bindings.lane).toBeUndefined();
    for (const p of SALES_LANE_PROFILES) expect(profileLabel(gateway(0, profileLabel(p)).bindings.lane!.profile)).toBe(profileLabel(p));
  });

  it('refuses a percentage > 0 without a lane', () => {
    expect(() => gateway(1)).toThrow(/R4_PROD_ROLLOUT_PERCENT=1 without a lane would serve the cohort with the main profile/);
  });

  it('refuses a percentage > 0 with a lane profile outside the approved cohort set; composes it with sales-production@22', () => {
    for (const p of SALES_LANE_PROFILES.map(profileLabel).filter((l) => l !== 'sales-production@22')) {
      expect(() => gateway(1, p)).toThrow(new RegExp(`lane profile ${p}, which is not approved for the rollout cohort`));
    }
    const composed = gateway(20, 'sales-production@22').bindings;
    expect(profileLabel(composed.profile)).toBe('sales-production@3');
    expect(profileLabel(composed.lane!.profile)).toBe('sales-production@22');
  });
});
