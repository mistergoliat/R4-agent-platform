import { createLogger } from '@r4/observability';
import { createPool, migrate } from '@r4/persistence-postgres';
import { loadConfig } from './config.js';
import { loadLocalEnvFile } from './env.js';

/** `npm run db:migrate`: applies pending migrations, then exits. */
async function main(): Promise<void> {
  loadLocalEnvFile();
  const config = loadConfig(process.env);
  const logger = createLogger({ service: 'r4-migrate', level: config.logLevel });
  const pool = createPool({ connectionString: config.databaseUrl, logger, applicationName: 'r4-migrate', max: 1 });
  try {
    const { applied } = await migrate(pool, { logger });
    logger.info({ event: 'db.migrations.completed', applied }, applied.length ? 'migrations applied' : 'schema already current');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', event: 'db.migrations.failed', message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
