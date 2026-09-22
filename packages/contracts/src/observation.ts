import { z } from 'zod';
import {
  CAPABILITY_FAILURE_CODES,
  CAPABILITY_REJECTION_CODES,
} from './capability.js';
import {
  agentIdSchema,
  correlationIdSchema,
  jsonObjectSchema,
  jsonValueSchema,
  positiveIntSchema,
  timestampSchema,
  uuidSchema,
} from './primitives.js';

/**
 * Observation: durable information obtained from outside the model. Immutable
 * once recorded. An agent may only claim something happened when an
 * observation (or, for writes, a receipt — R4-D) says so.
 *
 * Only capability-sourced observations exist in R4-B; the source union is the
 * seam for human answers, channel input and system events later.
 */
export const observationSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('capability'),
    /**
     * The capability id *as requested*. Deliberately not constrained to the
     * registered-id format: a rejected request for an unknown or malformed id is
     * itself evidence worth recording.
     */
    capabilityId: z.string().min(1).max(256),
    capabilityVersion: positiveIntSchema.nullable(),
    invocationId: uuidSchema,
  }),
]);
export type ObservationSource = z.infer<typeof observationSourceSchema>;

export const observationOutcomeSchema = z.enum(['succeeded', 'rejected', 'failed']);
export type ObservationOutcome = z.infer<typeof observationOutcomeSchema>;

export const observationErrorSchema = z.strictObject({
  code: z.enum([...CAPABILITY_REJECTION_CODES, ...CAPABILITY_FAILURE_CODES]),
  message: z.string().max(2000),
  details: jsonValueSchema.nullable(),
});
export type ObservationError = z.infer<typeof observationErrorSchema>;

export const observationSchema = z
  .strictObject({
    observationId: uuidSchema,
    taskId: uuidSchema,
    runId: uuidSchema.nullable(),
    agentId: agentIdSchema,
    source: observationSourceSchema,
    outcome: observationOutcomeSchema,
    payload: jsonValueSchema.nullable(),
    error: observationErrorSchema.nullable(),
    observedAt: timestampSchema,
    /** Freshness: after this instant the payload must not be treated as current. */
    validUntil: timestampSchema.nullable(),
    provenance: jsonObjectSchema,
    correlationId: correlationIdSchema,
  })
  .refine((o) => (o.outcome === 'succeeded') === (o.error === null), {
    message: 'error must be present exactly when outcome is not "succeeded"',
    path: ['error'],
  });
export type Observation = z.infer<typeof observationSchema>;
