import { z } from 'zod';
import {
  correlationIdSchema,
  positiveIntSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

/**
 * Goal is cognitive state: an explicit representation of intent that orients
 * the agent. It is NOT business truth and never authorizes an effect.
 *
 * - root goal: the goal a task was created for (exactly one per task, no parent)
 * - subgoal: any goal with a parent in the same task
 * - current goal: pointer held by the task (`AgentTask.currentGoalId`)
 */
export const GOAL_STATUSES = ['active', 'achieved', 'abandoned', 'superseded'] as const;
export const goalStatusSchema = z.enum(GOAL_STATUSES);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

/** Who formed the goal: the task requester, or the agent while working. */
export const goalOriginSchema = z.enum(['requester', 'agent']);
export type GoalOrigin = z.infer<typeof goalOriginSchema>;

export const goalDescriptionSchema = z.string().trim().min(1).max(4000);
export const successCriteriaSchema = z.array(z.string().trim().min(1).max(1000)).max(20);

export const goalSchema = z.strictObject({
  goalId: uuidSchema,
  taskId: uuidSchema,
  parentGoalId: uuidSchema.nullable(),
  description: goalDescriptionSchema,
  successCriteria: successCriteriaSchema,
  status: goalStatusSchema,
  origin: goalOriginSchema,
  correlationId: correlationIdSchema,
  version: positiveIntSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Goal = z.infer<typeof goalSchema>;

export const goalSpecSchema = z.strictObject({
  description: goalDescriptionSchema,
  successCriteria: successCriteriaSchema.default([]),
});
export type GoalSpec = z.output<typeof goalSpecSchema>;
