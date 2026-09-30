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
 * - pending      READ decided and assigned an invocation id, or (R4-D) action
 *                proposed and assigned a proposal id; no observation yet
 * - observed     READ executed, or action resolved (denied, approval required,
 *                or executed with a receipt); `observationId` is its only evidence
 * - recorded     respond / complete recorded
 * - refused      valid decision the platform declined (budget)
 * - invalid      model output rejected by decision validation
 * - model_failed the model call itself failed
 *
 * Only structured decisions are stored — never raw model text or reasoning.
 *
 * R4-C2: `contextSnapshotId` names the immutable ContextSnapshot the step's
 * model call was made with (null only for steps recorded before R4-C2).
 *
 * R4-D: `proposalId` names the durable ActionProposal of an accepted
 * `propose_action`, assigned by the platform when the step is recorded. A
 * step whose action outcome is unknown stays `pending`: nothing may follow it.
 *
 * ADR-031: `origin` says who decided the step. `model` (default) — one model
 * call. `platform` — no model call, no tokens: a READ the kernel issued to
 * revalidate the evidence of a proposed response, the WAIT_UNTIL deferring a
 * draft until that evidence can be refreshed, a deferred draft recorded (or
 * refused) once revalidated, or the run's one safe degradation.
 * A `respond` the response-authority validator rejected is recorded
 * `refused` (non-terminal) with its structured feedback and is never sent.
 */
export const RUN_STEP_ORIGINS = ['model', 'platform'] as const;
export const runStepOriginSchema = z.enum(RUN_STEP_ORIGINS);
export type RunStepOrigin = z.infer<typeof runStepOriginSchema>;
/** ADR-031: error codes of `respond` steps the response-authority validator refused (non-terminal). */
export const RESPONSE_AUTHORITY_ERROR_PREFIX = 'response_authority_';

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
    contextSnapshotId: uuidSchema.nullable().default(null),
    proposalId: uuidSchema.nullable().default(null),
    origin: runStepOriginSchema.default('model'),
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
    const proposesAction = step.decision?.type === 'propose_action' && (step.outcome === 'pending' || step.outcome === 'observed');
    if ((step.proposalId !== null) !== proposesAction) issue('proposalId', 'proposalId is present exactly for accepted propose_action decisions');
    if ((step.observationId !== null) !== (step.outcome === 'observed')) issue('observationId', 'observationId is present exactly when observed');
    if ((step.completedAt === null) !== (step.outcome === 'pending')) issue('completedAt', 'only pending steps are incomplete');
    const platformDecision = step.decision?.type === 'read_capability' || step.decision?.type === 'respond' || step.decision?.type === 'wait';
    if (step.origin === 'platform' && (!platformDecision || step.usage.inputTokens + step.usage.outputTokens !== 0)) issue('origin', 'platform steps are token-free READs, responses or waits');
  });
export type RunStep = z.infer<typeof runStepSchema>;
