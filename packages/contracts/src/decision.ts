import { z } from 'zod';
import { jsonObjectSchema, uniqueArray, uuidSchema } from './primitives.js';

/**
 * AgentDecision: the ONLY thing a model may produce inside the execution loop.
 * Deliberately small (R4-C1). It is a proposal: the platform parses, validates
 * and then decides whether and how anything happens.
 *
 * - read_capability: ask for one registered READ capability. Only the id and
 *   the arguments; identity, scopes, invocation id and execution belong to
 *   the platform.
 * - respond: intermediate textual output, recorded on the run. Not delivered
 *   to any channel in C1 and never terminal.
 * - complete: declare the task finished with a structured result. It cannot
 *   cause side effects: the result is stored as data and nothing else.
 *
 * Every object is strict: unknown keys are a protocol violation, never
 * silently dropped. This also keeps free-form reasoning out of stored decisions.
 * The remaining PRD §7 decisions (ProposeAction, Delegate, Wait, ...) arrive
 * with the phases that implement them.
 */
export const AGENT_DECISION_TYPES = ['read_capability', 'respond', 'complete'] as const;
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

export const agentDecisionSchema = z.discriminatedUnion('type', [
  readCapabilityDecisionSchema,
  respondDecisionSchema,
  completeDecisionSchema,
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
  /** The capability exists for the agent but is not READ: not executable in C1. */
  'capability_not_permitted',
  /** `complete` cites evidence that is not an observation of this task. */
  'unknown_evidence',
] as const;
export const decisionErrorCodeSchema = z.enum(DECISION_ERROR_CODES);
export type DecisionErrorCode = z.infer<typeof decisionErrorCodeSchema>;
