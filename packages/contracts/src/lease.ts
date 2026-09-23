import { z } from 'zod';
import { positiveIntSchema, timestampSchema, uuidSchema } from './primitives.js';

/** Worker identities appear in logs and lease rows: log-safe, bounded. */
export const workerIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'must be 1-128 log-safe characters');

/**
 * Temporary execution ownership of a task (R4-C1). Held by one worker at a
 * time; expires unless renewed by heartbeats.
 *
 * `generation` is the fencing token: it increases on every claim, so a worker
 * whose lease expired and was taken over can never pass as the owner again —
 * every owner-only write checks (owner, generation, not expired) under the
 * task row lock. Expiry is evaluated on the database clock only.
 *
 * A lease is ownership, not lifecycle: acquiring or renewing it never changes
 * the task's `version`, status or business state.
 */
export const taskLeaseSchema = z.strictObject({
  taskId: uuidSchema,
  owner: workerIdSchema,
  generation: positiveIntSchema,
  acquiredAt: timestampSchema,
  expiresAt: timestampSchema,
  lastHeartbeatAt: timestampSchema,
});
export type TaskLease = z.infer<typeof taskLeaseSchema>;

/** What a worker presents to prove ownership on every write. */
export type LeaseToken = Pick<TaskLease, 'taskId' | 'owner' | 'generation'>;
