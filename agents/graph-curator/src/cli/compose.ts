import { parseArgs } from 'node:util';
import { createLogger } from '@r4/observability';
import { PostgresArtifacts, createPool } from '@r4/persistence-postgres';
import { composeNextVersion } from '../run.js';

/**
 * `npm run graph:compose -- --created-by <humanRef>`: the next product-graph version with the approved changes
 * (ADR-058 G3), left UNSIGNED for the console. Reads R4_DATABASE_URL; prints counts, never the content.
 */
const { values } = parseArgs({ options: { 'created-by': { type: 'string' } } });
const url = process.env.R4_DATABASE_URL;
if (!url || !values['created-by']) {
  process.stderr.write('usage: R4_DATABASE_URL=… graph:compose --created-by <humanRef>\n');
  process.exit(2);
}
const pool = createPool({ connectionString: url, logger: createLogger({ service: 'graph-compose', level: 'warn' }), applicationName: 'graph-compose', max: 1 });
try {
  const result = await composeNextVersion(new PostgresArtifacts(pool), { createdBy: values['created-by'] });
  process.stdout.write(`${JSON.stringify(result ?? { version: null, reason: 'no approved changes' })}\n`);
} catch (error) {
  process.stderr.write(`graph:compose failed: ${error instanceof Error ? error.message.slice(0, 500) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
