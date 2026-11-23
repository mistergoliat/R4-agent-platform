import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createLogger } from '@r4/observability';
import { PostgresArtifacts, createPool } from '@r4/persistence-postgres';
import { undoChange } from '../run.js';

/**
 * `npm run graph:undo -- --proposal <id> --by <humanRef>` (ADR-058 Decision 9, «Deshacer»): reverts one applied change,
 * signs the version that reverts it as that person and marks the change undone. Reads R4_DATABASE_URL.
 */
const { values } = parseArgs({ options: { proposal: { type: 'string' }, by: { type: 'string' } } });
const url = process.env.R4_DATABASE_URL;
if (!url || !values.proposal || !values.by || !/^[0-9a-f-]{36}$/u.test(values.proposal)) {
  process.stderr.write('usage: R4_DATABASE_URL=… graph:undo --proposal <uuid> --by <humanRef>\n');
  process.exit(2);
}
const pool = createPool({ connectionString: url, logger: createLogger({ service: 'graph-undo', level: 'warn' }), applicationName: 'graph-undo', max: 1 });
try {
  const result = await undoChange(new PostgresArtifacts(pool), { proposalId: values.proposal, undoneBy: values.by, correlationId: `graph-undo-${randomUUID()}` });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`graph:undo failed: ${error instanceof Error ? error.message.slice(0, 500) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
