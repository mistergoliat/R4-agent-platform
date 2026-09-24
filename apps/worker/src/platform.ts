import type { Logger } from 'pino';
import { PlatformError, systemClock, uuidV7Generator, type Clock, type IdGenerator } from '@r4/contracts';
import { AgentKernel } from '@r4/agent-kernel';
import { AgentRegistry } from '@r4/agent-registry';
import { ActionExecutor, type CapabilityRegistry } from '@r4/capability-runtime';
import { ContextCompiler, MemoryContextSource, platformContextSources, type ContextCompactor, type ContextSource } from '@r4/context-compiler';
import { DefaultModelGateway, type ModelProvider } from '@r4/model-gateway';
import { createLogger } from '@r4/observability';
import {
  PostgresAgentDefinitionStore,
  PostgresExecutionStore,
  PostgresMemoryStore,
  PostgresObservationStore,
  createPool,
  migrationStatus,
  type Pool,
} from '@r4/persistence-postgres';
import { ActionPolicyEngine, DEFAULT_ACTION_POLICY, type ActionPolicyConfigurationInput } from '@r4/policy-engine';
import { ActionRuntime, ExecutionRuntime, TemporalRuntime } from '@r4/task-runtime';
import { validateWorkerConfig, type WorkerConfig } from './config.js';
import { DurableKernelSession } from './session.js';
import { Reconciler } from './reconciliation.js';
import { Worker } from './worker.js';

/**
 * What a deployment plugs in. C1 ships no real model provider and no Core
 * capabilities: both are supplied by the composition that runs the worker.
 */
export interface WorkerBindings {
  readonly modelProvider: ModelProvider;
  readonly capabilities: CapabilityRegistry;
  /**
   * R4-C2. Without a compactor, conversation that exceeds the context budget
   * is dropped oldest-first; C2 ships only the deterministic one.
   */
  readonly compactor?: ContextCompactor;
  /** Additional context sources (e.g. domain state owned outside the Core), registered after the platform's. */
  readonly contextSources?: readonly ContextSource[];
  /**
   * R4-D: the deterministic action policy (typed rule set, versioned and
   * hashed). Defaults to the platform's conservative DEFAULT_ACTION_POLICY.
   */
  readonly actionPolicy?: ActionPolicyConfigurationInput;
}

export interface WorkerOverrides {
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export interface WorkerPlatform {
  readonly worker: Worker;
  readonly execution: ExecutionRuntime;
  readonly temporal: TemporalRuntime;
  readonly pool: Pool;
  readonly logger: Logger;
  /** Stops the worker (releasing its lease) and closes connections. */
  close(): Promise<void>;
}

/**
 * Composition root of the worker process. Independent of the API: it shares
 * only PostgreSQL. It never migrates and never registers agent definitions —
 * it resolves the pinned versions the API registered.
 */
export async function createWorkerPlatform(config: WorkerConfig, bindings: WorkerBindings, overrides: WorkerOverrides = {}): Promise<WorkerPlatform> {
  validateWorkerConfig(config);
  const logger = overrides.logger ?? createLogger({ service: 'r4-worker', level: config.logLevel });
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? uuidV7Generator(clock);
  const pool = createPool({ connectionString: config.databaseUrl, logger, applicationName: `r4-worker:${config.workerId}`.slice(0, 63), max: config.dbPoolMax });

  try {
    const status = await migrationStatus(pool);
    if (status.pending.length > 0 || status.modified.length > 0) {
      throw new PlatformError('unavailable', 'schema_not_current', `database schema is not current (pending: ${status.pending.join(', ') || 'none'}; modified: ${status.modified.join(', ') || 'none'}); run "npm run db:migrate"`);
    }

    const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock, logger });
    const observations = new PostgresObservationStore(pool);
    const store = new PostgresExecutionStore(pool);
    const execution = new ExecutionRuntime({ store, ids, clock, logger, maxRunRecoveries: config.maxRunRecoveries, ...(config.maxRunFailureRecoveries === undefined ? {} : { maxRunFailureRecoveries: config.maxRunFailureRecoveries }) });
    const temporal = new TemporalRuntime({ store, execution, ids, logger });
    // The only authority over effects: policy is evaluated inside the runtime's fenced transactions.
    const actions = new ActionRuntime({ store, authorizer: new ActionPolicyEngine(bindings.actionPolicy ?? DEFAULT_ACTION_POLICY), temporal, ids, clock, logger });
    const kernel = new AgentKernel({ gateway: new DefaultModelGateway({ provider: bindings.modelProvider, logger }), logger });
    const context = new ContextCompiler({
      sources: [...platformContextSources(), new MemoryContextSource(new PostgresMemoryStore(pool)), ...(bindings.contextSources ?? [])],
      policy: config.context,
      compactor: bindings.compactor ?? null,
      logger,
    });

    const worker = new Worker({
      workerId: config.workerId,
      execution,
      kernel,
      sessions: ({ lease }) =>
        new DurableKernelSession({ lease, execution, agents, capabilities: bindings.capabilities, observations, policy: config.execution, context, actions, temporal, ids, clock, logger }),
      leaseDurationMs: config.leaseDurationMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      pollIntervalMs: config.pollIntervalMs,
      // R4-E: due reconciliation of uncertain effects runs here (capabilities live in the worker), before any claim.
      reconciler: new Reconciler({ actions, executor: new ActionExecutor({ registry: bindings.capabilities, logger }), workerId: config.workerId, leaseDurationMs: config.leaseDurationMs, logger }),
      logger: logger.child({ workerId: config.workerId }),
    });

    return {
      worker,
      execution,
      pool,
      temporal,
      logger,
      async close() {
        await worker.stop();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
