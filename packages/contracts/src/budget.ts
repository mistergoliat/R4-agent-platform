import { z } from 'zod';
import { nonNegativeIntSchema, positiveIntSchema } from './primitives.js';

/**
 * Resource limits for a task or run. Every limit is optional; an absent limit
 * means "inherit from the ceiling above" (agent definition), never "unlimited
 * by default". There are no global, arbitrary caps such as "2 tool calls".
 *
 * Cost budgets are intentionally deferred until currency/pricing ownership is
 * decided (see docs/roadmap/R4_DELIVERY_ROADMAP.md).
 */
export const budgetSchema = z.strictObject({
  maxDurationMs: positiveIntSchema.max(30 * 24 * 60 * 60 * 1000).optional(),
  maxTokens: nonNegativeIntSchema.optional(),
  maxModelCalls: nonNegativeIntSchema.optional(),
  maxCapabilityCalls: nonNegativeIntSchema.optional(),
  maxWrites: nonNegativeIntSchema.optional(),
  maxDelegations: nonNegativeIntSchema.optional(),
});
export type Budget = z.infer<typeof budgetSchema>;

export const BUDGET_KEYS = [
  'maxDurationMs',
  'maxTokens',
  'maxModelCalls',
  'maxCapabilityCalls',
  'maxWrites',
  'maxDelegations',
] as const satisfies readonly (keyof Budget)[];
