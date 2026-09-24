import { z } from 'zod';
import { jsonObjectSchema, uniqueArray, uuidSchema } from './primitives.js';
import { waitDecisionSchema, consultationDecisionSchema, handoffDecisionSchema, manageGoalDecisionSchema } from './temporal.js';

/**
 * AgentDecision: the ONLY thing a model may produce inside the execution loop.
 * Deliberately small (R4-C1). It is a proposal: the platform parses, validates
 * and then decides whether and how anything happens.
 *
 * - read_capability: ask for one registered READ capability. Only the id and
 *   the arguments; identity, scopes, invocation id and execution belong to
 *   the platform.
 * - respond: textual output, recorded on the run and never terminal. It means
 *   "R4 accepted this response" — never that anyone received it. (R4-I) Outside
 *   Core, one delivery owner may turn an accepted response into a durable
 *   outbound message with its own lifecycle; the decision itself carries no
 *   channel, recipient or delivery state.
 * - complete: declare the task finished with a structured result. It cannot
 *   cause side effects: the result is stored as data and nothing else.
 *
 * - propose_action (R4-D): ask the platform to produce an effect through one
 *   registered write capability. It is intent only: the platform persists the
 *   proposal, decides by deterministic policy whether it may execute, runs it
 *   with a platform execution key and reports the outcome as an observation
 *   backed by a receipt. The model supplies only the capability id, the
 *   arguments and (optionally) the observations it relies on — never keys,
 *   decisions, risk, permissions, identity, receipts or execution status.
 *
 * Every object is strict: unknown keys are a protocol violation, never
 * silently dropped. This also keeps free-form reasoning out of stored decisions.
 * The remaining PRD §7 decisions (Delegate, Wait, ...) arrive with the phases
 * that implement them.
 */
export const AGENT_DECISION_TYPES = ['read_capability', 'respond', 'complete', 'propose_action', 'wait', 'request_consultation', 'request_handoff', 'manage_goal'] as const;
export const agentDecisionTypeSchema = z.enum(AGENT_DECISION_TYPES);
export type AgentDecisionType = z.infer<typeof agentDecisionTypeSchema>;

export const readCapabilityDecisionSchema = z.strictObject({
  type: z.literal('read_capability'),
  /** As requested; existence and permission are checked by the platform. */
  capabilityId: z.string().min(1).max(256),
  arguments: jsonObjectSchema,
});
export type ReadCapabilityDecision = z.infer<typeof readCapabilityDecisionSchema>;

export const respondDecisionSchema = z.strictObject({
  type: z.literal('respond'),
  content: z.string().trim().min(1).max(8000),
});
export type RespondDecision = z.infer<typeof respondDecisionSchema>;

export const completionResultSchema = z.strictObject({
  summary: z.string().trim().min(1).max(4000),
  /** Observation ids the result relies on; each must exist for the task. */
  evidence: uniqueArray(uuidSchema).max(100),
  data: jsonObjectSchema.optional(),
});
export type CompletionResult = z.infer<typeof completionResultSchema>;

export const completeDecisionSchema = z.strictObject({
  type: z.literal('complete'),
  result: completionResultSchema,
});
export type CompleteDecision = z.infer<typeof completeDecisionSchema>;

export const proposeActionDecisionSchema = z.strictObject({
  type: z.literal('propose_action'),
  /** As requested; existence, class and permission are checked by the platform. */
  capabilityId: z.string().min(1).max(256),
  arguments: jsonObjectSchema,
  /** Observation ids the proposal relies on; each must exist for the task. */
  evidenceRefs: uniqueArray(uuidSchema).max(100).optional(),
});
export type ProposeActionDecision = z.infer<typeof proposeActionDecisionSchema>;

export const agentDecisionSchema = z.discriminatedUnion('type', [
  readCapabilityDecisionSchema,
  respondDecisionSchema,
  completeDecisionSchema,
  proposeActionDecisionSchema,
  waitDecisionSchema,
  consultationDecisionSchema,
  handoffDecisionSchema,
  manageGoalDecisionSchema,
]);
export type AgentDecision = z.infer<typeof agentDecisionSchema>;

/** Classified reasons a model output is not an acceptable decision. */
export const DECISION_ERROR_CODES = [
  /** No JSON document could be obtained from the model result. */
  'invalid_structured_output',
  /** JSON, but `type` is missing or not one of AGENT_DECISION_TYPES. */
  'unknown_decision_type',
  /** Known type, but the document violates its schema (incl. unknown keys). */
  'invalid_decision_schema',
  /** The capability is not among those offered to this run. */
  'unknown_capability',
  /**
   * The capability exists for the agent but not for this decision type: a
   * non-READ asked for with `read_capability`, or a READ with `propose_action`.
   */
  'capability_not_permitted',
  /** `complete` or `propose_action` cites evidence that is not an observation of this task. */
  'unknown_evidence',
] as const;
export const decisionErrorCodeSchema = z.enum(DECISION_ERROR_CODES);
export type DecisionErrorCode = z.infer<typeof decisionErrorCodeSchema>;
