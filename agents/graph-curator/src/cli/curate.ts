import { parseArgs } from 'node:util';
import { HttpCatalogAdapter, loadCatalogHttpConfig } from '@r4-adapters/catalog-http';
import { createLogger } from '@r4/observability';
import { PostgresArtifactFacts, PostgresArtifacts, createPool } from '@r4/persistence-postgres';
import { runCuration } from '../run.js';

/**
 * `npm run graph:curate -- --started-by <humanRef>`: one curator run on demand (ADR-058 G2). Reads R4_DATABASE_URL and
 * the Catalog V2 client settings (R4_CATALOG_V2_*) from the environment; prints the run id and counts, never product
 * data or credentials.
 */
const { values } = parseArgs({ options: { 'started-by': { type: 'string' }, concurrency: { type: 'string' } } });
const url = process.env.R4_DATABASE_URL;
if (!url || !values['started-by']) {
  process.stderr.write('usage: R4_DATABASE_URL=… R4_CATALOG_V2_…=… graph:curate --started-by <humanRef> [--concurrency 1-4]\n');
  process.exit(2);
}
const concurrency = Math.min(4, Math.max(1, Number(values.concurrency ?? 2) || 2));
const catalog = new HttpCatalogAdapter({ config: loadCatalogHttpConfig(process.env, { allowNetwork: true, source: 'v2' }), fetch: (u, init) => fetch(u, init) });
const pool = createPool({ connectionString: url, logger: createLogger({ service: 'graph-curate', level: 'warn' }), applicationName: 'graph-curate', max: 2 });
try {
  const result = await runCuration({ pool, artifacts: new PostgresArtifacts(pool), catalog, facts: new PostgresArtifactFacts(pool) }, { startedBy: values['started-by'], concurrency });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`graph:curate failed: ${error instanceof Error ? error.message.slice(0, 500) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
  // The catalog client can keep sockets or timers alive (the first prod run stayed up 20 min after finishing).
  process.exit(process.exitCode ?? 0);
}
