import { createLogger } from '@r4/observability';
import { createPool } from '@r4/persistence-postgres';
import { migrateGraph } from '../run.js';

/** `npm run graph:migrate`: applies the graph-curator pack's migrations (schema `graph`). Reads R4_DATABASE_URL. */
const url = process.env.R4_DATABASE_URL;
if (!url) {
  process.stderr.write('R4_DATABASE_URL is required\n');
  process.exit(2);
}
const pool = createPool({ connectionString: url, logger: createLogger({ service: 'graph-migrate', level: 'warn' }), applicationName: 'graph-migrate', max: 1 });
try {
  const { applied } = await migrateGraph(pool);
  process.stdout.write(applied.length ? `graph migrations applied: ${applied.join(', ')}\n` : 'graph schema already current\n');
} catch (error) {
  process.stderr.write(`graph:migrate failed: ${error instanceof Error ? error.message : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
