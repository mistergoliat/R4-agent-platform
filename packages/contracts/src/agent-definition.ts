import { z } from 'zod';
import { budgetSchema } from './budget.js';
import {
  agentIdSchema,
  positiveIntSchema,
  scopeSchema,
  slugSchema,
  taskTypeSchema,
  timestampSchema,
  uniqueArray,
} from './primitives.js';

const level = z.enum(['low', 'medium', 'high']);

/**
 * What an agent needs from a model, expressed provider-neutrally. Deliberately
 * contains no provider or model names: selecting a concrete model is the Model
 * Gateway's concern (routing is deferred), never the agent definition's.
 */
export const modelRequirementsSchema = z.strictObject({
  reasoningLevel: level,
  latencySensitivity: level,
  costSensitivity: level,
  structuredOutput: z.boolean(),
  toolUse: z.boolean(),
  minContextTokens: positiveIntSchema.optional(),
});
export type ModelRequirements = z.infer<typeof modelRequirementsSchema>;

/**
 * The agent's own context ceiling (R4-C2): it can only tighten the operator's
 * context compilation policy, never widen it. Stored as JSON because it will grow.
 */
export const contextPolicySchema = z.strictObject({
  maxContextTokens: positiveIntSchema.optional(),
});
export type ContextPolicy = z.infer<typeof contextPolicySchema>;

export const delegationPolicySchema = z
  .strictObject({
    mode: z.enum(['none', 'allow_listed']),
    allowedAgentIds: uniqueArray(agentIdSchema).default([]),
  })
  .refine((policy) => policy.mode === 'allow_listed' || policy.allowedAgentIds.length === 0, {
    message: 'allowedAgentIds must be empty when mode is "none"',
    path: ['allowedAgentIds'],
  });
export type DelegationPolicy = z.infer<typeof delegationPolicySchema>;

export const evaluationProfileSchema = z.strictObject({
  profileId: slugSchema,
});

/**
 * Configuration of an agent — never an execution. A given (agentId, version)
 * is immutable once registered; changing behavior means publishing a new
 * version. Tasks pin the exact version they were assigned.
 */
export const agentDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  agentId: agentIdSchema,
  version: positiveIntSchema,
  displayName: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  instructions: z.string().min(1).max(50_000),
  /** Task types this agent accepts. The platform refuses other assignments. */
  taskTypes: uniqueArray(taskTypeSchema).min(1),
  /** Scopes granted to this agent; capabilities are discoverable only within them. */
  capabilityScopes: uniqueArray(scopeSchema),
  skills: uniqueArray(slugSchema).default([]),
  modelRequirements: modelRequirementsSchema,
  contextPolicy: contextPolicySchema.default({}),
  /** Ceilings: a task may request less, never more. */
  budgets: budgetSchema,
  delegationPolicy: delegationPolicySchema.default({ mode: 'none', allowedAgentIds: [] }),
  evaluationProfile: evaluationProfileSchema.nullable().default(null),
});
export type AgentDefinitionInput = z.input<typeof agentDefinitionSchema>;
export type AgentDefinition = z.output<typeof agentDefinitionSchema>;

/** A definition as registered by the platform. */
export const registeredAgentDefinitionSchema = agentDefinitionSchema.extend({
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  registeredAt: timestampSchema,
});
export type RegisteredAgentDefinition = z.output<typeof registeredAgentDefinitionSchema>;

export const agentSummarySchema = z.strictObject({
  agentId: agentIdSchema,
  version: positiveIntSchema,
  displayName: z.string(),
  description: z.string(),
  taskTypes: z.array(taskTypeSchema),
  registeredAt: timestampSchema,
});
export type AgentSummary = z.output<typeof agentSummarySchema>;
