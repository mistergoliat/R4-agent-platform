import { PlatformError, systemClock, uuidV7Generator } from '@r4/contracts';
import type { Logger } from 'pino';
import { createLogger } from '@r4/observability';
import { createPool, migrationStatus, PostgresExecutionStore, type Pool } from '@r4/persistence-postgres';
import { ExecutionRuntime, TemporalRuntime } from '@r4/task-runtime';
import type { SchedulerConfig } from './config.js';
import { Scheduler } from './scheduler.js';

export interface SchedulerPlatform {
  readonly scheduler: Scheduler;
  readonly temporal: TemporalRuntime;
  readonly pool: Pool;
  readonly logger: Logger;
  close(): Promise<void>;
}

/**
 * Composition root of the scheduler process (ADR-022). Shares only
 * PostgreSQL with the API and the workers. It never migrates, and it
 * composes no model gateway, capability registry, policy engine or kernel:
 * its only authority is time.
 */
export async function createSchedulerPlatform(config: SchedulerConfig, overrides: { logger?: Logger } = {}): Promise<SchedulerPlatform> {
  const logger = overrides.logger ?? createLogger({ service: 'r4-scheduler', level: config.logLevel });
  const ids = uuidV7Generator(systemClock);
  const pool = createPool({ connectionString: config.databaseUrl, logger, applicationName: `r4-scheduler:${config.owner}`.slice(0, 63), max: config.dbPoolMax });
  try {
    const status = await migrationStatus(pool);
    if (status.pending.length > 0 || status.modified.length > 0) {
      throw new PlatformError('unavailable', 'schema_not_current', 'database schema is not current; run "npm run db:migrate" before starting the scheduler');
    }
    const store = new PostgresExecutionStore(pool);
    // Runs are never started here (no claims); the execution runtime only shares the step/run write rules.
    const execution = new ExecutionRuntime({ store, clock: systemClock, ids, logger, maxRunRecoveries: 0 });
    const temporal = new TemporalRuntime({ store, execution, ids, logger, reconciliationPolicy: config.reconciliationPolicy });
    const scheduler = new Scheduler({ temporal, owner: config.owner, leaseMs: config.leaseMs, pollMs: config.pollMs, logger: logger.child({ schedulerId: config.owner }) });
    return {
      scheduler,
      temporal,
      pool,
      logger,
      async close() {
        await scheduler.stop();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
