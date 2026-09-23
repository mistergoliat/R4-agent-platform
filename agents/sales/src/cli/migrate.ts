import { createLogger } from '@r4/observability';
import { createPool } from '@r4/persistence-postgres';
import { migrateSales } from '../migrate.js';
import { loadLocalEnv, print } from './common.js';

/** `npm run sales:migrate`: applies the Sales pack's own schema (after `npm run db:migrate`). */
async function main(): Promise<void> {
  loadLocalEnv();
  const url = process.env.R4_DATABASE_URL;
  if (!url) throw new Error('R4_DATABASE_URL is required');
  const logger = createLogger({ service: 'sales-migrate', level: 'info' });
  const pool = createPool({ connectionString: url, logger, applicationName: 'sales-migrate', max: 1 });
  try {
    const { applied } = await migrateSales(pool, logger);
    print(applied.length ? `sales migrations applied: ${applied.join(', ')}` : 'sales schema already current');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`sales:migrate failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
