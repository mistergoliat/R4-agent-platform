import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { workerIdSchema } from '@r4/contracts';
import { assertExecutionPolicy, type ExecutionPolicy } from '@r4/agent-kernel';
import { assertLeaseTiming } from '@r4/task-runtime';

const int = (min: number) => z.coerce.number().int().min(min);

/**
 * Execution policy values are operator configuration with safety-net
 * defaults. Task budgets (bounded by agent ceilings) can only tighten them.
 */
const configSchema = z.object({
  R4_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
  R4_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  R4_DB_POOL_MAX: int(1).max(100).default(5),
  R4_WORKER_ID: workerIdSchema.optional(),
  R4_WORKER_LEASE_MS: int(100).default(30_000),
  R4_WORKER_HEARTBEAT_MS: int(10).default(10_000),
  R4_WORKER_POLL_MS: int(10).default(1_000),
  R4_EXEC_MAX_ITERATIONS: int(1).default(50),
  R4_EXEC_MAX_MODEL_CALLS: int(1).default(50),
  R4_EXEC_MAX_READ_CALLS: int(0).default(50),
  R4_EXEC_MAX_RUN_DURATION_MS: int(1).default(15 * 60_000),
  R4_EXEC_MODEL_CALL_TIMEOUT_MS: int(1).default(60_000),
  R4_EXEC_MAX_RUN_RECOVERIES: int(0).default(3),
});

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly logLevel: z.infer<typeof configSchema>['R4_LOG_LEVEL'];
  readonly dbPoolMax: number;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly maxRunRecoveries: number;
  readonly execution: ExecutionPolicy;
}

/** Configuration comes only from the environment; invalid config fails the boot. */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const c = parsed.data;
  const config: WorkerConfig = {
    databaseUrl: c.R4_DATABASE_URL,
    logLevel: c.R4_LOG_LEVEL,
    dbPoolMax: c.R4_DB_POOL_MAX,
    workerId: c.R4_WORKER_ID ?? defaultWorkerId(),
    leaseDurationMs: c.R4_WORKER_LEASE_MS,
    heartbeatIntervalMs: c.R4_WORKER_HEARTBEAT_MS,
    pollIntervalMs: c.R4_WORKER_POLL_MS,
    maxRunRecoveries: c.R4_EXEC_MAX_RUN_RECOVERIES,
    execution: {
      maxIterations: c.R4_EXEC_MAX_ITERATIONS,
      maxModelCalls: c.R4_EXEC_MAX_MODEL_CALLS,
      maxReadCapabilityCalls: c.R4_EXEC_MAX_READ_CALLS,
      maxRunDurationMs: c.R4_EXEC_MAX_RUN_DURATION_MS,
      modelCallTimeoutMs: c.R4_EXEC_MODEL_CALL_TIMEOUT_MS,
    },
  };
  validateWorkerConfig(config);
  return config;
}

/** Cross-field rules, also applied to programmatic configuration. */
export function validateWorkerConfig(config: WorkerConfig): void {
  workerIdSchema.parse(config.workerId);
  assertLeaseTiming({ leaseDurationMs: config.leaseDurationMs, heartbeatIntervalMs: config.heartbeatIntervalMs });
  assertExecutionPolicy(config.execution);
  if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs <= 0) {
    throw new Error('pollIntervalMs must be a positive integer');
  }
  if (!Number.isInteger(config.maxRunRecoveries) || config.maxRunRecoveries < 0) {
    throw new Error('maxRunRecoveries must be a non-negative integer');
  }
}

/** host:pid:random — unique per process, stable for its lifetime, log-safe. */
export function defaultWorkerId(): string {
  const host = hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'host';
  return `${/^[A-Za-z0-9]/.test(host) ? host : `w${host}`}:${process.pid}:${randomBytes(3).toString('hex')}`;
}
