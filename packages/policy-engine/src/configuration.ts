import { z } from 'zod';
import {
  PlatformError,
  RISK_CLASSES,
  capabilityIdSchema,
  fingerprint,
  identityAssuranceSchema,
  positiveIntSchema,
  slugSchema,
  type PolicyIdentity,
} from '@r4/contracts';

/** Bumped whenever the evaluation semantics (rule order, rule meaning) change. */
export const POLICY_ENGINE_VERSION = 'r4.policy-engine.v1';

/**
 * What the platform does with a write of a given class when every structural
 * precondition holds. `deny` and `require_approval` never execute; only
 * `allow` lets the platform create a command.
 */
export const AUTONOMY_LEVELS = ['allow', 'require_approval', 'deny'] as const;
export const autonomySchema = z.enum(AUTONOMY_LEVELS);
export type Autonomy = z.infer<typeof autonomySchema>;

export const actionRuleSchema = z.strictObject({
  autonomy: autonomySchema,
  /** Below this identity assurance the action is denied, whatever the autonomy. */
  minimumIdentity: identityAssuranceSchema.default('none'),
  /** The proposal must cite at least one observation of the task. */
  requireEvidence: z.boolean().default(false),
});
export type ActionRuleInput = z.input<typeof actionRuleSchema>;
export type ActionRule = z.output<typeof actionRuleSchema>;

const WRITE_CLASSES = RISK_CLASSES.filter((r): r is Exclude<(typeof RISK_CLASSES)[number], 'READ'> => r !== 'READ');
export type WriteRiskClass = (typeof WRITE_CLASSES)[number];

/**
 * A deterministic, typed rule set — deliberately not a policy language.
 * `riskClasses` must cover every write class, so no class is ever governed
 * by an implicit default; `capabilities` overrides the class rule for a
 * specific capability id. Identified by (policyId, version) and by the hash
 * of its canonical form, which every decision records.
 */
export const actionPolicyConfigurationSchema = z.strictObject({
  policyId: slugSchema,
  version: positiveIntSchema,
  riskClasses: z.strictObject(Object.fromEntries(WRITE_CLASSES.map((r) => [r, actionRuleSchema])) as Record<WriteRiskClass, typeof actionRuleSchema>),
  capabilities: z.record(capabilityIdSchema, actionRuleSchema).default({}),
});
export type ActionPolicyConfigurationInput = z.input<typeof actionPolicyConfigurationSchema>;
export type ActionPolicyConfiguration = z.output<typeof actionPolicyConfigurationSchema>;

/**
 * The platform's conservative default (an example of generic governance, not
 * a universal production policy): reversible writes are autonomous; writes
 * that cannot be undone or that reach outside need a human; financial effects
 * additionally need a verified identity (which no R4-D principal has, so they
 * are denied); privileged effects are never autonomous.
 */
export const DEFAULT_ACTION_POLICY: ActionPolicyConfigurationInput = Object.freeze({
  policyId: 'r4-default-action-policy',
  version: 1,
  riskClasses: {
    REVERSIBLE_WRITE: { autonomy: 'allow' },
    IRREVERSIBLE_WRITE: { autonomy: 'require_approval' },
    FINANCIAL: { autonomy: 'require_approval', minimumIdentity: 'verified' },
    EXTERNAL_COMMUNICATION: { autonomy: 'require_approval' },
    PRIVILEGED: { autonomy: 'deny' },
  },
} satisfies ActionPolicyConfigurationInput);

export interface LoadedActionPolicy {
  readonly configuration: ActionPolicyConfiguration;
  readonly identity: PolicyIdentity;
}

/** Validates a configuration and computes its identity (hash of the canonical, defaults-applied form). */
export function loadActionPolicy(input: unknown): LoadedActionPolicy {
  const parsed = actionPolicyConfigurationSchema.safeParse(input);
  if (!parsed.success) {
    throw new PlatformError('validation', 'invalid_action_policy', `invalid action policy: ${z.prettifyError(parsed.error)}`);
  }
  const configuration = parsed.data;
  return {
    configuration,
    identity: { policyId: configuration.policyId, version: configuration.version, hash: fingerprint(configuration), engineVersion: POLICY_ENGINE_VERSION },
  };
}
