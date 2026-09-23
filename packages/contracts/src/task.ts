import { z } from 'zod';
import { budgetSchema } from './budget.js';
import { goalSchema, goalSpecSchema } from './goal.js';
import { runStatusSchema } from './run.js';
import {
  agentIdSchema,
  correlationIdSchema,
  jsonObjectSchema,
  positiveIntSchema,
  principalSchema,
  taskTypeSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

/**
 * AgentTask: the durable unit of work. Survives process restart; its status is
 * owned by the platform (Task Runtime), never asserted by a model.
 */
export const TASK_STATUSES = [
  'pending',
  'running',
  'waiting',
  'blocked',
  'requires_approval',
  'completed',
  'failed',
  'cancelled',
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'] as const satisfies readonly TaskStatus[];

/** Machine-readable reason attached to a status (e.g. why a task is blocked). */
export const statusReasonSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9_.]*$/, 'must be a lowercase reason code');

export const agentTaskSchema = z.strictObject({
  taskId: uuidSchema,
  taskType: taskTypeSchema,
  agentId: agentIdSchema,
  agentVersion: positiveIntSchema,
  status: taskStatusSchema,
  statusReason: statusReasonSchema.nullable(),
  parentTaskId: uuidSchema.nullable(),
  rootGoalId: uuidSchema,
  currentGoalId: uuidSchema,
  requestedBy: principalSchema,
  input: jsonObjectSchema,
  constraints: jsonObjectSchema,
  /** Effective budget: requested limits clamped by the agent's ceilings. */
  budget: budgetSchema,
  result: jsonObjectSchema.nullable(),
  deadlineAt: timestampSchema.nullable(),
  idempotencyKey: z.string().nullable(),
  correlationId: correlationIdSchema,
  version: positiveIntSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type AgentTask = z.infer<typeof agentTaskSchema>;

/** Public request to create a task. Untrusted: validated at the boundary. */
export const createTaskRequestSchema = z.strictObject({
  taskType: taskTypeSchema,
  agentId: agentIdSchema,
  agentVersion: positiveIntSchema.optional(),
  goal: goalSpecSchema,
  input: jsonObjectSchema.default({}),
  constraints: jsonObjectSchema.default({}),
  budget: budgetSchema.default({}),
  deadlineAt: timestampSchema.optional(),
  parentTaskId: uuidSchema.optional(),
});
export type CreateTaskRequestInput = z.input<typeof createTaskRequestSchema>;
export type CreateTaskRequest = z.output<typeof createTaskRequestSchema>;

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'must be 1-128 characters of [A-Za-z0-9._:-]');

/** Append-only history row; enough to reconstruct every status transition. */
export const taskTransitionSchema = z.strictObject({
  transitionId: uuidSchema,
  taskId: uuidSchema,
  fromStatus: taskStatusSchema.nullable(),
  toStatus: taskStatusSchema,
  reason: statusReasonSchema.nullable(),
  actor: principalSchema,
  taskVersion: positiveIntSchema,
  correlationId: correlationIdSchema,
  occurredAt: timestampSchema,
});
export type TaskTransition = z.infer<typeof taskTransitionSchema>;

export const runSummarySchema = z.strictObject({
  runId: uuidSchema,
  sequence: positiveIntSchema,
  status: runStatusSchema,
});

/** Read model returned by `GET /v1/tasks/:id`. */
export const taskViewSchema = z.strictObject({
  task: agentTaskSchema,
  goals: z.array(goalSchema),
  runs: z.array(runSummarySchema),
});
export type TaskView = z.infer<typeof taskViewSchema>;
