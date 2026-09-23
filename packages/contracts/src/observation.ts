import { z } from 'zod';
import {
  CAPABILITY_FAILURE_CODES,
  CAPABILITY_REJECTION_CODES,
} from './capability.js';
import {
  agentIdSchema,
  correlationIdSchema,
  jsonObjectSchema,
  jsonValueSchema,
  positiveIntSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

/**
 * Observation: durable information obtained from outside the model. Immutable
 * once recorded. An agent may only claim something happened when an
 * observation (or, for writes, a receipt — R4-D) says so.
 *
 * Capability-sourced observations exist since R4-B; R4-D adds action-sourced
 * ones (the outcome of a governed action: a validation rejection, a policy
 * decision that stopped it, or its receipt). The source union remains the
 * seam for human answers, channel input and system events later.
 */
export const observationSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('capability'),
    /**
     * The capability id *as requested*. Deliberately not constrained to the
     * registered-id format: a rejected request for an unknown or malformed id is
     * itself evidence worth recording.
     */
    capabilityId: z.string().min(1).max(256),
    capabilityVersion: positiveIntSchema.nullable(),
    invocationId: uuidSchema,
  }),
  z.strictObject({
    kind: z.literal('action'),
    /** As proposed (may be unknown or malformed when the proposal was rejected). */
    capabilityId: z.string().min(1).max(256),
    capabilityVersion: positiveIntSchema.nullable(),
    proposalId: uuidSchema,
    /** Null when the proposal was rejected before policy (validation). */
    policyDecisionId: uuidSchema.nullable(),
    /** Present only when policy allowed it and a command was created. */
    executionId: uuidSchema.nullable(),
    /** Present only when the outcome is backed by an ActionReceipt. */
    receiptId: uuidSchema.nullable(),
    /** (R4-E) The human approval request whose outcome (rejected/expired/cancelled) this observes. */
    approvalRequestId: uuidSchema.nullable().optional(),
  }),
]);
export type ObservationSource = z.infer<typeof observationSourceSchema>;
export type CapabilityObservationSource = Extract<ObservationSource, { kind: 'capability' }>;
export type ActionObservationSource = Extract<ObservationSource, { kind: 'action' }>;

export const observationOutcomeSchema = z.enum(['succeeded', 'rejected', 'failed']);
export type ObservationOutcome = z.infer<typeof observationOutcomeSchema>;

/**
 * R4-D action outcomes as the agent observes them. There is deliberately no
 * code for an unknown outcome: an action whose outcome is not known produces
 * no observation at all (the run is suspended instead), so the agent is never
 * told "failed" or "succeeded" without evidence.
 */
export const ACTION_REJECTION_CODES = [
  /** The proposal cannot become a command (unknown capability, not a write, invalid arguments). */
  'write_validation_failure',
  'policy_denied',
  /** Policy requires a human decision; nothing was executed. */
  'approval_required',
  /** The domain refused the command (e.g. optimistic-concurrency conflict); receipt-backed, no effect. */
  'action_rejected',
  /** (R4-E) A human rejected the approval request for this proposal; nothing was executed. */
  'approval_rejected',
  /** (R4-E) The approval request expired without a decision; nothing was executed. */
  'approval_expired',
  /** (R4-E) The approval request was withdrawn by a human; nothing was executed. */
  'approval_cancelled',
] as const;
export const ACTION_FAILURE_CODES = [
  /** The domain reported a definitive failure (no effect); receipt-backed. */
  'write_execution_failure',
] as const;
export type ActionRejectionCode = (typeof ACTION_REJECTION_CODES)[number];
export type ActionFailureCode = (typeof ACTION_FAILURE_CODES)[number];

export const observationErrorSchema = z.strictObject({
  code: z.enum([...CAPABILITY_REJECTION_CODES, ...CAPABILITY_FAILURE_CODES, ...ACTION_REJECTION_CODES, ...ACTION_FAILURE_CODES]),
  message: z.string().max(2000),
  details: jsonValueSchema.nullable(),
});
export type ObservationError = z.infer<typeof observationErrorSchema>;

export const observationSchema = z
  .strictObject({
    observationId: uuidSchema,
    taskId: uuidSchema,
    runId: uuidSchema.nullable(),
    agentId: agentIdSchema,
    source: observationSourceSchema,
    outcome: observationOutcomeSchema,
    payload: jsonValueSchema.nullable(),
    error: observationErrorSchema.nullable(),
    observedAt: timestampSchema,
    /** Freshness: after this instant the payload must not be treated as current. */
    validUntil: timestampSchema.nullable(),
    provenance: jsonObjectSchema,
    correlationId: correlationIdSchema,
  })
  .refine((o) => (o.outcome === 'succeeded') === (o.error === null), {
    message: 'error must be present exactly when outcome is not "succeeded"',
    path: ['error'],
  })
  // A write is never observed as successful without a receipt.
  .refine((o) => o.source.kind !== 'action' || o.outcome !== 'succeeded' || o.source.receiptId !== null, {
    message: 'a succeeded action observation must reference its receipt',
    path: ['source', 'receiptId'],
  })
  .refine((o) => o.source.kind !== 'action' || !o.source.approvalRequestId || o.source.receiptId === null, {
    message: 'an approval outcome is never receipt-backed: nothing was executed',
    path: ['source', 'approvalRequestId'],
  })
  .refine((o) => o.source.kind !== 'action' || ((o.source.receiptId === null || o.source.executionId !== null) && (o.source.executionId === null || o.source.policyDecisionId !== null)), {
    message: 'an action receipt implies an execution, and an execution implies a policy decision',
    path: ['source'],
  });
export type Observation = z.infer<typeof observationSchema>;
