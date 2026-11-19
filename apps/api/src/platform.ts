import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { PlatformError, systemClock, uuidV7Generator, type Clock, type IdGenerator } from '@r4/contracts';
import { AgentRegistry, loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createLogger } from '@r4/observability';
import {
  PostgresAgentDefinitionStore,
  PostgresTaskRuntimeStore,
  PostgresExecutionStore,
  PostgresProductionStore,
  PostgresConsoleReads,
  PostgresIncidents,
  PostgresInsights,
  PostgresKnowledge,
  checkDatabaseReadiness,
  createPool,
  migrationStatus,
  type Pool,
} from '@r4/persistence-postgres';
import { TaskRuntime, ExecutionRuntime, TemporalRuntime } from '@r4/task-runtime';
import { AutonomyControls, ProductionOperator } from '@r4/live-ops';
import { buildApp, type ReadinessReport, type AppDependencies } from './app.js';
import type { ApiConfig } from './config.js';
import type { PrincipalResolver } from './principal.js';
import { createServiceReader } from './service-reader.js';
import { createConsoleOperatorContext } from './console-operator.js';

export interface Platform {
  readonly app: FastifyInstance;
  readonly pool: Pool;
  readonly tasks: TaskRuntime;
  readonly temporal: TemporalRuntime;
  readonly agents: AgentRegistry;
  /** (R4-I) Operator plane of production conversations. */
  readonly production: ProductionOperator;
  readonly logger: Logger;
  close(): Promise<void>;
}

export interface PlatformOverrides {
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly principal?: PrincipalResolver;
  readonly humanContext?: AppDependencies['humanContext'];
  readonly serviceReader?: AppDependencies['serviceReader'];
}

/**
 * Composition root. Wires durable stores and runtime services. Everything
 * required to resume after a restart lives in PostgreSQL; this function holds
 * no state beyond connections and immutable configuration.
 */
export async function createPlatform(config: ApiConfig, overrides: PlatformOverrides = {}): Promise<Platform> {
  const logger = overrides.logger ?? createLogger({ service: 'r4-api', level: config.logLevel });
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? uuidV7Generator(clock);
  // ADR-050: built before connecting, so a malformed key or operators file fails the boot.
  const humanContext = overrides.humanContext ?? createConsoleOperatorContext({ key: config.consoleOperatorKey, operatorsFile: config.consoleOperatorsFile, clock });
  const pool = createPool({ connectionString: config.databaseUrl, logger, applicationName: 'r4-api', max: config.dbPoolMax });

  try {
    // Schema changes are explicit (`npm run db:migrate`); the API never migrates implicitly.
    const status = await migrationStatus(pool);
    if (status.pending.length > 0 || status.modified.length > 0) {
      throw new PlatformError('unavailable', 'schema_not_current', `database schema is not current (pending: ${status.pending.join(', ') || 'none'}; modified: ${status.modified.join(', ') || 'none'}); run "npm run db:migrate"`);
    }

    const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock, logger });
    const loaded = await loadAgentDefinitionsFromDirectory(config.agentDefinitionsDir);
    await agents.sync(loaded.map((entry) => entry.definition));

    const tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids, clock, logger });
    const executionStore = new PostgresExecutionStore(pool);
    const execution = new ExecutionRuntime({ store: executionStore, ids, clock, logger, maxRunRecoveries: 0 });
    const temporal = new TemporalRuntime({ store: executionStore, execution, ids, logger });
    const productionStore = new PostgresProductionStore(pool);
    const production = new ProductionOperator({ store: productionStore, temporal, controls: new AutonomyControls({ store: productionStore, logger }), ids, logger });

    const readiness = async (): Promise<ReadinessReport> => {
      const database = await checkDatabaseReadiness(pool);
      return {
        ready: database.ok,
        checks: {
          database: { ok: database.ok, reachable: database.reachable, pendingMigrations: database.pendingMigrations, modifiedMigrations: database.modifiedMigrations },
          agentDefinitions: { ok: true, loaded: loaded.length },
        },
      };
    };

    const serviceReader = overrides.serviceReader ?? createServiceReader(config.serviceReaderTokenSha256);
    const incidents = new PostgresIncidents(pool, clock);
    const app = buildApp({ logger, tasks, agents, readiness, temporal, production, consoleReads: new PostgresConsoleReads(pool, clock), incidents,
      insights: new PostgresInsights(pool, clock, incidents), knowledge: new PostgresKnowledge(pool),
      ...(serviceReader ? { serviceReader } : {}),
      ...(humanContext ? { humanContext } : {}),
      ...(config.anonymousWrites ? { anonymousWrites: config.anonymousWrites } : {}),
      ...(overrides.principal ? { principal: overrides.principal } : {}) });
    await app.ready();

    return {
      app,
      pool,
      tasks,
      temporal,
      agents,
      production,
      logger,
      async close() {
        await app.close();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
