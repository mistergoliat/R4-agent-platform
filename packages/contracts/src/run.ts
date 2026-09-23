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
 *   running ──► completed | failed | cancelled | abandoned   (terminal)
 *
 * - A run is created already `running`, atomically with the lease that owns it:
 *   there is no unowned "created" limbo.
 * - When its worker disappears the run stays `running` (orphaned) until the
 *   lease expires; the next owner resumes the SAME run from its durable step log.
 * - `abandoned` = closed by the platform because ownership was lost too many
 *   times (`lease_lost`); nobody will continue it.
 */
export const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'abandoned'] as const;
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
] as const;
export const terminationReasonSchema = z.enum(TERMINATION_REASONS);
export type TerminationReason = z.infer<typeof terminationReasonSchema>;

/**
 * Coarse failure classes (input for Quality/Evaluation). Derived from the
 * reason — never stored independently, so they cannot disagree.
 */
export const FAILURE_CLASSES = ['model', 'protocol', 'capability', 'platform', 'lease', 'budget'] as const;
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
