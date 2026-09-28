import { PlatformError, systemClock, uuidV7Generator } from '@r4/contracts';
import type { StructuredLogger } from '@r4/observability';
import { PostgresExecutionStore, PostgresProductionStore, createPool, migrationStatus } from '@r4/persistence-postgres';
import { AutonomyControls, ProductionAdministration } from '@r4/live-ops';
import { ExecutionRuntime, TemporalRuntime } from '@r4/task-runtime';

/**
 * (R4-I D-5/D-6) Production administration over the deployment's database,
 * composed from the same durable runtimes as the gateway — and nothing
 * else: no channel adapter, no delivery, no HTTP server, no model. For host
 * tooling of the deployment; never exposed as a route. Refuses a database
 * whose schema is not current (Core migrations plus the pack's own
 * `migrationDirectories`) before anything is read or changed.
 */
export async function openProductionAdministration(options: {
  readonly databaseUrl: string;
  readonly migrationDirectories: readonly string[];
  readonly logger: StructuredLogger;
  readonly correlationId: string;
}): Promise<{ readonly admin: ProductionAdministration; readonly close: () => Promise<void> }> {
  const pool = createPool({ connectionString: options.databaseUrl, logger: options.logger, applicationName: 'r4-production-control', max: 2 });
  try {
    for (const directory of [undefined, ...options.migrationDirectories]) {
      const status = await migrationStatus(pool, directory);
      if (status.pending.length > 0 || status.modified.length > 0) {
        throw new PlatformError('unavailable', 'schema_not_current', `database schema is not current (pending: ${status.pending.join(', ') || 'none'}; modified: ${status.modified.join(', ') || 'none'})`);
      }
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  const ids = uuidV7Generator(systemClock);
  const store = new PostgresProductionStore(pool);
  const executionStore = new PostgresExecutionStore(pool);
  const execution = new ExecutionRuntime({ store: executionStore, ids, clock: systemClock, logger: options.logger, maxRunRecoveries: 0 });
  const admin = new ProductionAdministration({
    store,
    temporal: new TemporalRuntime({ store: executionStore, execution, ids, logger: options.logger }),
    controls: new AutonomyControls({ store, logger: options.logger }),
    correlationId: options.correlationId,
  });
  return { admin, close: () => pool.end().catch(() => undefined) };
}
