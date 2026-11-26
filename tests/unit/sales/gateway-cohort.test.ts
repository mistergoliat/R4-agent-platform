import { describe, expect, it } from 'vitest';
import { profileLabel, type ConversationLane } from '@r4/live-ops';
import { SALES_COHORT_LANE_PROFILES, SALES_LANE_PROFILES, SALES_PRODUCTION_PROFILE_V21, SALES_PRODUCTION_PROFILE_V22, assertSalesGatewayCohort } from '@r4-sales/agent/production';

/** (ADR-045 amendment 1) A percentage > 0 is served only through an owner-approved cohort lane. */
const lane = (profile: ConversationLane['profile']): ConversationLane => ({ conversationKeys: ['a'.repeat(64)], profile, taskFactory: {} as never });

describe('Sales gateway cohort guard', () => {
  it('at 0 % nothing is required (no lane, or any lane profile), exactly as before', () => {
    expect(() => assertSalesGatewayCohort(0, undefined)).not.toThrow();
    for (const p of SALES_LANE_PROFILES) expect(() => assertSalesGatewayCohort(0, lane(p))).not.toThrow();
  });

  it('refuses a percentage > 0 without a lane (the cohort would open, autonomous, on the main profile)', () => {
    expect(() => assertSalesGatewayCohort(0.01, undefined)).toThrow(/without a lane would serve the cohort with the main profile/);
    expect(() => assertSalesGatewayCohort(100, undefined)).toThrow(/without a lane/);
  });

  it('refuses a percentage > 0 with every lane profile outside the approved set; accepts only @29, @28, @27, @26, @25, @24 and @23 (successors), @22 (live) and @21 (rollback) today', () => {
    expect(SALES_COHORT_LANE_PROFILES).toEqual(['sales-production@29', 'sales-production@28', 'sales-production@27', 'sales-production@26', 'sales-production@25', 'sales-production@24', 'sales-production@23', 'sales-production@22', 'sales-production@21']);
    expect(() => assertSalesGatewayCohort(5, lane(SALES_PRODUCTION_PROFILE_V22))).not.toThrow();
    expect(() => assertSalesGatewayCohort(5, lane(SALES_PRODUCTION_PROFILE_V21))).not.toThrow();
    const others = SALES_LANE_PROFILES.filter((p) => !SALES_COHORT_LANE_PROFILES.includes(profileLabel(p)));
    expect(others.length).toBeGreaterThan(0);
    for (const p of others) expect(() => assertSalesGatewayCohort(5, lane(p))).toThrow(new RegExp(`lane profile ${profileLabel(p)}, which is not approved for the rollout cohort`));
  });
});
