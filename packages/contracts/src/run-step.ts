import { z } from 'zod';
import { agentDecisionSchema } from './decision.js';
import { reasonCodeSchema } from './run.js';
import {
  correlationIdSchema,
  nonNegativeIntSchema,
  positiveIntSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

/**
 * RunStep: the durable record of one kernel iteration (one model call and what
 * the platform did with its output). The step log is what lets any worker
 * rebuild the loop after a restart; nothing about an iteration lives only in
 * process memory.
 *
 * Outcomes:
 * - pending      READ decided and assigned an invocation id; no observation yet
 * - observed     READ executed; `observationId` is its only evidence
 * - recorded     respond / complete recorded
 * - refused      valid decision the platform declined (budget)
 * - invalid      model output rejected by decision validation
 * - model_failed the model call itself failed
 *
 * Only structured decisions are stored — never raw model text or reasoning.
 */
export const RUN_STEP_OUTCOMES = ['pending', 'observed', 'recorded', 'refused', 'invalid', 'model_failed'] as const;
export const runStepOutcomeSchema = z.enum(RUN_STEP_OUTCOMES);
export type RunStepOutcome = z.infer<typeof runStepOutcomeSchema>;

const DECIDED: readonly RunStepOutcome[] = ['pending', 'observed', 'recorded', 'refused'];
const ERRORED: readonly RunStepOutcome[] = ['refused', 'invalid', 'model_failed'];

export const runStepSchema = z
  .strictObject({
    stepId: uuidSchema,
    runId: uuidSchema,
    taskId: uuidSchema,
    iteration: positiveIntSchema,
    /** Fencing token of the lease under which the step was written. */
    leaseGeneration: positiveIntSchema,
    decision: agentDecisionSchema.nullable(),
    outcome: runStepOutcomeSchema,
    error: z.strictObject({ code: reasonCodeSchema, message: z.string().max(2000) }).nullable(),
    invocationId: uuidSchema.nullable(),
    observationId: uuidSchema.nullable(),
    usage: z.strictObject({ inputTokens: nonNegativeIntSchema, outputTokens: nonNegativeIntSchema }),
    correlationId: correlationIdSchema,
    createdAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
  })
  .superRefine((step, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if ((step.decision !== null) !== DECIDED.includes(step.outcome)) issue('decision', 'decision is present exactly for decided outcomes');
    if ((step.error !== null) !== ERRORED.includes(step.outcome)) issue('error', 'error is present exactly for refused/invalid/model_failed');
    const executesRead = step.decision?.type === 'read_capability' && (step.outcome === 'pending' || step.outcome === 'observed');
    if ((step.invocationId !== null) !== executesRead) issue('invocationId', 'invocationId is present exactly for accepted READ decisions');
    if ((step.observationId !== null) !== (step.outcome === 'observed')) issue('observationId', 'observationId is present exactly when observed');
    if ((step.completedAt === null) !== (step.outcome === 'pending')) issue('completedAt', 'only pending steps are incomplete');
  });
export type RunStep = z.infer<typeof runStepSchema>;
