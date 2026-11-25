import { createLogger } from '@r4/observability';
import { PostgresArtifacts, createPool } from '@r4/persistence-postgres';
import { askedToPesin } from '../agent/batch.js';
import { presentOpenProposals } from '../present.js';

/**
 * `npm run graph:present` (ADR-058 G7a): writes the question, the effect of each answer and the group of every open
 * proposal (`evidence.presentation`). No model, no catalog read. The curator runs do it at their end; this is for the
 * proposals already open.
 */
const url = process.env.R4_DATABASE_URL;
if (!url) {
  process.stderr.write('usage: R4_DATABASE_URL=… graph:present\n');
  process.exit(2);
}
const logger = createLogger({ service: 'graph-present', level: 'warn' });
const pool = createPool({ connectionString: url, logger, applicationName: 'graph-present', max: 2 });
try {
  process.stdout.write(`${JSON.stringify(await presentOpenProposals(new PostgresArtifacts(pool), await askedToPesin(pool)))}\n`);
} catch (error) {
  process.stderr.write(`graph:present failed: ${error instanceof Error ? error.message.slice(0, 500) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
