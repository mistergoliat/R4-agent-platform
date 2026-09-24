import { loadActionPolicy, type ActionPolicyConfigurationInput } from '@r4/policy-engine';
import { CAPABILITY_IDS } from '../ids.js';
import { SALES_ACTION_POLICY } from '../policy.js';

/**
 * Policy profiles a shadow workload may run under (R4-H). The R4-D Policy
 * Engine stays the only authority; a profile is just which reviewed rule set
 * the worker is composed with, and it is recorded (id, version, hash) in
 * every ShadowRun.
 *
 *   sales-reference        the pack's accepted policy, unchanged
 *   sales-shadow-approval  the same, except quote.create requires a human
 *                          approval — the platform default for an
 *                          IRREVERSIBLE_WRITE. Used only by approval workloads,
 *                          so the approval path can be exercised end to end
 *                          without editing the production policy.
 */
export const SALES_SHADOW_APPROVAL_POLICY: ActionPolicyConfigurationInput = Object.freeze({
  policyId: 'sales-shadow-approval-policy',
  version: 1,
  riskClasses: SALES_ACTION_POLICY.riskClasses,
  capabilities: {
    [CAPABILITY_IDS.quoteCreate]: { autonomy: 'require_approval', minimumIdentity: 'provisional', requireEvidence: true },
  },
} satisfies ActionPolicyConfigurationInput);

export const SALES_POLICY_PROFILES: Readonly<Record<string, ActionPolicyConfigurationInput>> = Object.freeze({
  'sales-reference': SALES_ACTION_POLICY,
  'sales-shadow-approval': SALES_SHADOW_APPROVAL_POLICY,
});

export function policyProfile(name: string | undefined): { name: string; policy: ActionPolicyConfigurationInput; identity: { name: string; policyId: string; version: number; hash: string } } {
  const key = name ?? 'sales-reference';
  const policy = SALES_POLICY_PROFILES[key];
  if (!policy) throw new Error(`unknown policy profile ${key}; known: ${Object.keys(SALES_POLICY_PROFILES).join(', ')}`);
  const { identity } = loadActionPolicy(policy);
  return { name: key, policy, identity: { name: key, policyId: identity.policyId, version: identity.version, hash: identity.hash } };
}
