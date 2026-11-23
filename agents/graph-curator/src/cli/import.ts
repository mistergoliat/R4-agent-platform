import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createLogger } from '@r4/observability';
import { PostgresArtifacts, createPool } from '@r4/persistence-postgres';
import { importSignedGraph } from '../baseline.js';

/**
 * `npm run graph:import -- --graph <graph.json> --unreviewed <marks.json> --signed-by <humanRef> [--note <text>]`
 * Stores the graph as a new `product-graph` version and signs it (ADR-058 G1). Reads R4_DATABASE_URL from the
 * process environment; prints counts and the hash, never the content or the connection string.
 */
const { values } = parseArgs({ options: { graph: { type: 'string' }, unreviewed: { type: 'string' }, 'signed-by': { type: 'string' }, note: { type: 'string' } } });
const url = process.env.R4_DATABASE_URL;
if (!values.graph || !values['signed-by'] || !url) {
  process.stderr.write('usage: R4_DATABASE_URL=… graph:import --graph <file> [--unreviewed <file>] --signed-by <humanRef> [--note <text>]\n');
  process.exit(2);
}
const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const pool = createPool({ connectionString: url, logger: createLogger({ service: 'r4-graph-import', level: 'warn' }), applicationName: 'r4-graph-import', max: 1 });
try {
  const result = await importSignedGraph(new PostgresArtifacts(pool), {
    graph: read(values.graph),
    unreviewed: values.unreviewed ? (read(values.unreviewed) as unknown[]) : [],
    signedBy: values['signed-by'],
    note: values.note ?? null,
    correlationId: `graph-import-${randomUUID()}`,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message.slice(0, 2000) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
