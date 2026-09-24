import { z } from 'zod';
import {
  agentIdSchema,
  correlationIdSchema,
  jsonObjectSchema,
  jsonValueSchema,
  nonNegativeIntSchema,
  positiveIntSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

/**
 * AgentRun: one bounded cognitive execution belonging to a task. A task may
 * have many runs over its life (resume, retry, wake-up); at most one is active.
 * Runs record structured outcomes and usage — never chain-of-thought.
 *
 * Lifecycle (R4-C1):
 *   running ──► completed | failed | cancelled | abandoned | suspended   (terminal)
 *
 * - A run is created already `running`, atomically with the lease that owns it:
 *   there is no unowned "created" limbo.
 * - When its worker disappears the run stays `running` (orphaned) until the
 *   lease expires; the next owner resumes the SAME run from its durable step log.
 * - `abandoned` = closed by the platform because ownership was lost too many
 *   times (`lease_lost`); nobody will continue it.
 * - `suspended` (R4-D) = the run ended without finishing its task because the
 *   task now waits for something no run can provide: an approval
 *   (`approval_required`, task `requires_approval`) or the resolution of an
 *   action whose outcome is unknown (`write_outcome_uncertain`, task
 *   `blocked`). Terminal for the run; the task continues, if ever, in a new run.
 */
export const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'abandoned', 'suspended'] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Why a run ended. Every finished run carries exactly one. */
export const TERMINATION_REASONS = [
  'completed',
  'model_failure',
  'invalid_decision',
  'capability_failure',
  'budget_exhausted',
  'lease_lost',
  'cancelled',
  'internal_failure',
  // R4-D governed execution
  'approval_required',
  'write_outcome_uncertain',
  'waiting',
  'human_handoff',
] as const;
export const terminationReasonSchema = z.enum(TERMINATION_REASONS);
export type TerminationReason = z.infer<typeof terminationReasonSchema>;

/**
 * Coarse failure classes (input for Quality/Evaluation). Derived from the
 * reason — never stored independently, so they cannot disagree.
 */
export const FAILURE_CLASSES = ['model', 'protocol', 'capability', 'platform', 'lease', 'budget', 'action'] as const;
export const failureClassSchema = z.enum(FAILURE_CLASSES);
export type FailureClass = z.infer<typeof failureClassSchema>;

const FAILURE_CLASS_BY_REASON: Readonly<Record<TerminationReason, FailureClass | null>> = {
  completed: null,
  cancelled: null,
  model_failure: 'model',
  invalid_decision: 'protocol',
  capability_failure: 'capability',
  internal_failure: 'platform',
  lease_lost: 'lease',
  budget_exhausted: 'budget',
  // Waiting for a human decision is not a failure.
  approval_required: null,
  write_outcome_uncertain: 'action',
  waiting: null,
  human_handoff: null,
};

export function failureClassOf(reason: TerminationReason): FailureClass | null {
  return FAILURE_CLASS_BY_REASON[reason];
}

/** The run status a termination reason implies. */
export function runStatusForTermination(reason: TerminationReason): Exclude<RunStatus, 'running'> {
  switch (reason) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'lease_lost':
      return 'abandoned';
    case 'approval_required':
    case 'write_outcome_uncertain':
    case 'waiting':
    case 'human_handoff':
      return 'suspended';
    default:
      return 'failed';
  }
}

export const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_.]*$/).max(128);

export const runTerminationSchema = z
  .strictObject({
    reason: terminationReasonSchema,
    failureClass: failureClassSchema.nullable(),
    /** Specific, machine-readable cause (e.g. `timeout`, `unknown_capability`, `maxModelCalls`). */
    code: reasonCodeSchema,
    message: z.string().max(2000),
    details: jsonValueSchema.nullable(),
  })
  .refine((t) => t.failureClass === failureClassOf(t.reason), {
    message: 'failureClass must be derived from reason',
    path: ['failureClass'],
  });
export type RunTermination = z.infer<typeof runTerminationSchema>;

export const runUsageSchema = z.strictObject({
  modelCalls: nonNegativeIntSchema,
  inputTokens: nonNegativeIntSchema,
  outputTokens: nonNegativeIntSchema,
  capabilityCalls: nonNegativeIntSchema,
});
export type RunUsage = z.infer<typeof runUsageSchema>;

export const EMPTY_RUN_USAGE: RunUsage = Object.freeze({
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  capabilityCalls: 0,
});

export const runFailureSchema = z.strictObject({
  code: reasonCodeSchema,
  message: z.string().max(2000),
});
export type RunFailure = z.infer<typeof runFailureSchema>;

export const agentRunSchema = z.strictObject({
  runId: uuidSchema,
  taskId: uuidSchema,
  sequence: positiveIntSchema,
  agentId: agentIdSchema,
  agentVersion: positiveIntSchema,
  status: runStatusSchema,
  /** Reference to the compiled context snapshot (Context Compiler, R4-C). */
  contextSnapshotRef: z.string().max(512).nullable(),
  usage: runUsageSchema,
  result: jsonObjectSchema.nullable(),
  failure: runFailureSchema.nullable(),
  /** Present exactly when the run is no longer `running`. */
  termination: runTerminationSchema.nullable(),
  /** Times this run was taken over from an owner whose lease expired. */
  recoveries: nonNegativeIntSchema,
  correlationId: correlationIdSchema,
  version: positiveIntSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type AgentRun = z.infer<typeof agentRunSchema>;

// ---------------------------------------------------------------------------
// Run failure vs. durable work (GAP-H-001, ADR-028)
// ---------------------------------------------------------------------------

/**
 * What a failed run establishes about its task. A failed run does not
 * terminate durable work unless the failure itself establishes that the work
 * is terminal. Applied only to the classes R4-H evidence justifies:
 *
 *   recoverable  `invalid_decision`; `model_failure` the gateway classified
 *                retryable → the task stays runnable and a NEW run, with a
 *                freshly compiled context, continues it (bounded).
 *   human        `model_failure` not retryable → no automatic run; the task
 *                is handed to a human, not terminated.
 *   terminal     every other failure, including an abandoned run (unchanged since C1).
 *
 * `retryable` is the gateway's ModelError classification, recorded by the
 * kernel in `termination.details`; anything but `true` is not retryable.
 * Null for a termination that is not a failure (completed, suspended,
 * cancelled). A pure classification: platform policy decides what to do.
 */
export type RunFailureDisposition = 'recoverable' | 'human' | 'terminal';

export function runFailureDisposition(termination: { readonly reason: TerminationReason; readonly details?: unknown }): RunFailureDisposition | null {
  const status = runStatusForTermination(termination.reason);
  if (status !== 'failed' && status !== 'abandoned') return null;
  if (termination.reason === 'invalid_decision') return 'recoverable';
  if (termination.reason === 'model_failure') {
    const details = termination.details;
    const retryable = details !== null && typeof details === 'object' && !Array.isArray(details) && (details as { retryable?: unknown }).retryable === true;
    return retryable ? 'recoverable' : 'human';
  }
  return 'terminal';
}

/** Task status reason: recoverable run failures exceeded the recovery budget. */
export const RUN_FAILURE_RECOVERY_EXHAUSTED = 'run_failure_recovery_exhausted';
/** Task status reason: a model failure that no automatic run may repeat (nothing was exhausted). */
export const NON_RETRYABLE_MODEL_FAILURE = 'non_retryable_model_failure';

/** Key under `termination.details` where the platform records how it disposed of a failed run. */
export const RUN_FAILURE_RECOVERY_KEY = 'runFailureRecovery';

/**
 * The platform's disposition of one failed run, stamped on its termination in
 * the same transaction that ends it (durable, per run, metadata only):
 *
 *   continued  recoverable; the task stays runnable for a new run
 *   exhausted  recoverable, but consecutive failures exceeded the budget → human
 *   handed_off not retryable → human; no automatic run was attempted
 *
 * `consecutiveFailures` counts this run; null for `handed_off` (nothing was retried).
 */
export const runFailureRecoverySchema = z.strictObject({
  outcome: z.enum(['continued', 'exhausted', 'handed_off']),
  consecutiveFailures: positiveIntSchema.nullable(),
  maxRunFailureRecoveries: nonNegativeIntSchema,
});
export type RunFailureRecovery = z.infer<typeof runFailureRecoverySchema>;

/** The recorded disposition of a run, or null (not a failed run, a pre-ADR-028 run, or malformed). */
export function runFailureRecoveryOf(termination: { readonly details?: unknown } | null): RunFailureRecovery | null {
  const details = termination?.details;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return null;
  const parsed = runFailureRecoverySchema.safeParse((details as Record<string, unknown>)[RUN_FAILURE_RECOVERY_KEY]);
  return parsed.success ? parsed.data : null;
}
