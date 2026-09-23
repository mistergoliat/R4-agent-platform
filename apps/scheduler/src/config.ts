import { hostname } from 'node:os';
import { z } from 'zod';
import { reconciliationPolicySchema, type ReconciliationPolicy } from '@r4/contracts';

const int = (min: number) => z.coerce.number().int().min(min);

/**
 * Scheduler process configuration. Lease and poll pacing have operational
 * defaults (they never change which schedules are due). The reconciliation
 * policy has NONE: attempts, backoff and deadline for uncertain external
 * effects are a governance decision, so the scheduler refuses to start
 * without them.
 */
const configSchema = z.object({
  R4_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
  R4_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  R4_DB_POOL_MAX: int(1).max(100).default(4),
  R4_SCHEDULER_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),
  R4_SCHEDULER_LEASE_MS: int(100).default(30_000),
  R4_SCHEDULER_POLL_MS: int(10).default(1_000),
  R4_RECONCILIATION_MAX_ATTEMPTS: int(1),
  R4_RECONCILIATION_INITIAL_BACKOFF_MS: int(0),
  R4_RECONCILIATION_MAX_BACKOFF_MS: int(0),
  R4_RECONCILIATION_DEADLINE_MS: int(1),
});

export interface SchedulerConfig {
  readonly databaseUrl: string;
  readonly logLevel: z.infer<typeof configSchema>['R4_LOG_LEVEL'];
  readonly dbPoolMax: number;
  readonly owner: string;
  readonly leaseMs: number;
  readonly pollMs: number;
  readonly reconciliationPolicy: ReconciliationPolicy;
}

export function loadSchedulerConfig(env: NodeJS.ProcessEnv): SchedulerConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration:\n${z.prettifyError(parsed.error)}`);
  const c = parsed.data;
  const policy = reconciliationPolicySchema.safeParse({
    maxAttempts: c.R4_RECONCILIATION_MAX_ATTEMPTS,
    initialBackoffMs: c.R4_RECONCILIATION_INITIAL_BACKOFF_MS,
    maxBackoffMs: c.R4_RECONCILIATION_MAX_BACKOFF_MS,
    deadlineMs: c.R4_RECONCILIATION_DEADLINE_MS,
  });
  if (!policy.success) throw new Error(`invalid configuration:\n${z.prettifyError(policy.error)}`);
  return {
    databaseUrl: c.R4_DATABASE_URL,
    logLevel: c.R4_LOG_LEVEL,
    dbPoolMax: c.R4_DB_POOL_MAX,
    owner: c.R4_SCHEDULER_ID ?? `scheduler-${hostname().replace(/[^A-Za-z0-9._-]/g, '-')}-${process.pid}`.slice(0, 128),
    leaseMs: c.R4_SCHEDULER_LEASE_MS,
    pollMs: c.R4_SCHEDULER_POLL_MS,
    reconciliationPolicy: policy.data,
  };
}
