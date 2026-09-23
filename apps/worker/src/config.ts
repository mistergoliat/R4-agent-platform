import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { workerIdSchema } from '@r4/contracts';
import { assertExecutionPolicy, type ExecutionPolicy } from '@r4/agent-kernel';
import { assertLeaseTiming } from '@r4/task-runtime';
import { contextCompilationPolicySchema, type ContextCompilationPolicyInput } from '@r4/context-compiler';

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
  // R4-D: write actions per task. 0 = this worker performs no writes unless the operator opts in.
  R4_EXEC_MAX_WRITE_ACTIONS: int(0).default(0),
  // R4-C2 context compilation policy (operator configuration).
  // Budget (ADR-015): unbounded by default — no R4-imposed limit. `fixed` requires R4_CONTEXT_MAX_TOKENS.
  R4_CONTEXT_BUDGET_MODE: z.enum(['unbounded', 'fixed']).default('unbounded'),
  R4_CONTEXT_MAX_TOKENS: int(1).optional(),
  R4_CONTEXT_RECENT_TURNS: int(1).default(20),
  R4_CONTEXT_COMPACTION_CHUNK: int(1).default(10),
  R4_CONTEXT_EXPIRED_EVIDENCE: z.enum(['include', 'exclude']).default('include'),
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
  /** R4-C2: how the Context Compiler selects and bounds each model input. */
  readonly context: ContextCompilationPolicyInput;
}

/**
 * Default context policy (e.g. for sessions built without a platform): the
 * schema defaults, i.e. an unbounded budget. Equal to what an empty
 * environment yields, so both compile equivalent snapshots.
 */
export const DEFAULT_CONTEXT_POLICY: ContextCompilationPolicyInput = Object.freeze({ budget: { mode: 'unbounded' as const } });

/** Configuration comes only from the environment; invalid config fails the boot. */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const c = parsed.data;
  if ((c.R4_CONTEXT_BUDGET_MODE === 'fixed') !== (c.R4_CONTEXT_MAX_TOKENS !== undefined)) {
    throw new Error('invalid configuration:\nR4_CONTEXT_MAX_TOKENS must be set exactly when R4_CONTEXT_BUDGET_MODE=fixed');
  }
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
      maxWriteActions: c.R4_EXEC_MAX_WRITE_ACTIONS,
    },
    context: {
      budget: c.R4_CONTEXT_MAX_TOKENS === undefined ? { mode: 'unbounded' } : { mode: 'fixed', maxEstimatedTokens: c.R4_CONTEXT_MAX_TOKENS },
      expiredEvidence: c.R4_CONTEXT_EXPIRED_EVIDENCE,
      conversation: { recentTurns: c.R4_CONTEXT_RECENT_TURNS, compaction: { enabled: true, chunkTurns: c.R4_CONTEXT_COMPACTION_CHUNK } },
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
  const context = contextCompilationPolicySchema.safeParse(config.context);
  if (!context.success) throw new Error(`invalid context policy:\n${z.prettifyError(context.error)}`);
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
