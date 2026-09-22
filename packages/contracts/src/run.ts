import { z } from 'zod';
import {
  agentIdSchema,
  correlationIdSchema,
  jsonObjectSchema,
  nonNegativeIntSchema,
  positiveIntSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

/**
 * AgentRun: one bounded cognitive execution belonging to a task. A task may
 * have many runs over its life (resume, retry, wake-up); at most one is active.
 * Runs record structured outcomes and usage — never chain-of-thought.
 */
export const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

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
  code: z.string().regex(/^[a-z][a-z0-9_.]*$/).max(128),
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
  correlationId: correlationIdSchema,
  version: positiveIntSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type AgentRun = z.infer<typeof agentRunSchema>;
