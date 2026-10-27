import type { Logger } from 'pino';
import type { Clock } from '@r4/contracts';
import type { ExecutionPolicy } from '@r4/agent-kernel';
import { CapabilityRegistry } from '@r4/capability-runtime';
import type { ContextCompactor, ContextCompilationPolicyInput, ContextSource } from '@r4/context-compiler';
import type { ActionPolicyConfigurationInput } from '@r4/policy-engine';
import { FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresExecutionStore, PostgresObservationStore, type Pool } from '@r4/persistence-postgres';
import type { ServedAgents } from '@r4/task-runtime';
import { createWorkerPlatform, type WorkerConfig, type WorkerPlatform } from '@r4/worker';
import { getTestFactCapability } from '../fixtures/capabilities/get-test-fact.js';
import { TEST_POLICY } from './kernel-fixtures.js';

export { TEST_POLICY };

export interface TestWorkerOptions {
  readonly workerId: string;
  readonly script: FakeModelScript;
  readonly capabilities?: CapabilityRegistry;
  readonly policy?: Partial<ExecutionPolicy>;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxRunRecoveries?: number;
  /** ADR-028: recovery runs after consecutive recoverable run failures (platform default when omitted). */
  readonly maxRunFailureRecoveries?: number;
  readonly logger?: Logger;
  /** R4-C2: context policy overrides, compactor and extra sources. */
  readonly context?: Partial<ContextCompilationPolicyInput>;
  readonly compactor?: ContextCompactor;
  readonly contextSources?: readonly ContextSource[];
  /** R4-D: action policy binding (default: the platform's DEFAULT_ACTION_POLICY). */
  readonly actionPolicy?: ActionPolicyConfigurationInput;
  /** R4-E: injected process clock (C2 freshness), e.g. shifted for long-wait scenarios. */
  readonly clock?: Clock;
  /** R4-J4-R6: the definitions this worker serves (absent: every definition). */
  readonly servedAgents?: ServedAgents;
}

/** Same as a worker booted from an empty environment (loadWorkerConfig): unbounded budget. */
export const TEST_CONTEXT_POLICY: ContextCompilationPolicyInput = {
  budget: { mode: 'unbounded' },
  expiredEvidence: 'include',
  conversation: { recentTurns: 20, compaction: { enabled: true, chunkTurns: 10 } },
};

export interface TestWorker {
  readonly platform: WorkerPlatform;
  readonly provider: FakeModelProvider;
  readonly capabilities: CapabilityRegistry;
}

/**
 * Registry with the synthetic read-only test capability (optionally a custom
 * handler). `timeoutMs` overrides the declared timeout (1 s by default) for
 * handlers that deliberately take longer.
 */
export function testCapabilities(handler?: Parameters<typeof getTestFactCapability>[0], options: { timeoutMs?: number } = {}): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  const base = getTestFactCapability(handler);
  registry.register(options.timeoutMs === undefined ? base : { ...base, definition: { ...base.definition, timeoutMs: options.timeoutMs } });
  return registry;
}

export function testWorkerConfig(databaseUrl: string, options: Omit<TestWorkerOptions, 'script' | 'capabilities' | 'logger' | 'compactor' | 'contextSources' | 'clock'>): WorkerConfig {
  return {
    databaseUrl,
    logLevel: 'silent',
    dbPoolMax: 4,
    workerId: options.workerId,
    leaseDurationMs: options.leaseDurationMs ?? 5_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 1_000,
    pollIntervalMs: options.pollIntervalMs ?? 25,
    maxRunRecoveries: options.maxRunRecoveries ?? 3,
    ...(options.maxRunFailureRecoveries === undefined ? {} : { maxRunFailureRecoveries: options.maxRunFailureRecoveries }),
    execution: { ...TEST_POLICY, ...options.policy },
    context: { ...TEST_CONTEXT_POLICY, ...options.context },
  };
}

/**
 * Boots a real worker composition (own pool, own registries) — the in-process
 * equivalent of a separate worker process sharing only PostgreSQL.
 */
export async function startTestWorker(databaseUrl: string, options: TestWorkerOptions): Promise<TestWorker> {
  const provider = new FakeModelProvider(options.script);
  const capabilities = options.capabilities ?? testCapabilities();
  const platform = await createWorkerPlatform(
    testWorkerConfig(databaseUrl, options),
    {
      modelProvider: provider,
      capabilities,
      ...(options.compactor ? { compactor: options.compactor } : {}),
      ...(options.contextSources ? { contextSources: options.contextSources } : {}),
      ...(options.actionPolicy ? { actionPolicy: options.actionPolicy } : {}),
      ...(options.servedAgents ? { servedAgents: options.servedAgents } : {}),
    },
    { logger: options.logger ?? createSilentLogger(), ...(options.clock ? { clock: options.clock } : {}) },
  );
  return { platform, provider, capabilities };
}

/** Read-side helpers over the durable state, for assertions. */
export function stepsOf(pool: Pool, runId: string) {
  return new PostgresExecutionStore(pool).transaction((uow) => uow.listRunSteps(runId));
}

export function observationsOf(pool: Pool, taskId: string) {
  return new PostgresObservationStore(pool).listByTask(taskId);
}

/** Simulates the passage of lease time without waiting: the lease is now expired on the DB clock. */
export async function expireLease(pool: Pool, taskId: string): Promise<void> {
  await pool.query(`update agent_tasks set lease_expires_at = clock_timestamp() - interval '1 millisecond' where task_id = $1 and lease_owner is not null`, [taskId]);
}

export async function leaseRow(pool: Pool, taskId: string) {
  const result = await pool.query<{ lease_owner: string | null; lease_generation: number; lease_expires_at: Date | null; last_heartbeat_at: Date | null }>(
    'select lease_owner, lease_generation, lease_expires_at, last_heartbeat_at from agent_tasks where task_id = $1',
    [taskId],
  );
  return result.rows[0]!;
}

export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 10_000, intervalMs = 20): Promise<Exclude<T, null | undefined | false>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as Exclude<T, null | undefined | false>;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
