import type { ActionPolicyConfigurationInput } from '@r4/policy-engine';
import { DEFAULT_ACTION_POLICY } from '@r4/policy-engine';
import { CAPABILITY_IDS } from './ids.js';

/**
 * The Sales pack's action policy: the platform's conservative default for
 * every class, plus one explicit, reviewable decision of the pack: issuing a
 * quote (IRREVERSIBLE_WRITE by class, which the default would send to a
 * human) is autonomous — but only for a task whose requester is at least
 * provisionally identified and only when the proposal cites evidence
 * (observations it relied on). Workspace updates are REVERSIBLE_WRITE and
 * stay autonomous under the default rule. Payments or messages to customers
 * do not exist in R4-F; if they are added, the default still gates them.
 */
export const SALES_ACTION_POLICY: ActionPolicyConfigurationInput = Object.freeze({
  policyId: 'sales-reference-policy',
  version: 1,
  riskClasses: DEFAULT_ACTION_POLICY.riskClasses,
  capabilities: {
    [CAPABILITY_IDS.quoteCreate]: { autonomy: 'allow', minimumIdentity: 'provisional', requireEvidence: true },
  },
} satisfies ActionPolicyConfigurationInput);
