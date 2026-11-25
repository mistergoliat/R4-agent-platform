import { randomUUID } from 'node:crypto';
import { AgentRegistry } from '@r4/agent-registry';
import { HttpCatalogAdapter, loadCatalogHttpConfig } from '@r4-adapters/catalog-http';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import { createLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresArtifactFacts, PostgresArtifacts, PostgresTaskRuntimeStore, createPool } from '@r4/persistence-postgres';
import { TaskRuntime } from '@r4/task-runtime';
import { productSheetView } from '../agent/capabilities.js';
import { completedReviewTasks, recheckReviews } from '../agent/review.js';
import { PRODUCT_GRAPH_KIND } from '../graph.js';

/**
 * `npm run graph:recheck` (ADR-058 G4b): checks again the results of every completed review task against today's
 * sheets and evaluation and stores the proposals. No model call: nothing is paid again. Open proposals are refreshed,
 * decided ones stand. Run it after the evaluation changes (2026-11-25: «Categoría» specifications were refused).
 */
const url = process.env.R4_DATABASE_URL;
if (!url) {
  process.stderr.write('usage: R4_DATABASE_URL=… graph:recheck\n');
  process.exit(2);
}
const logger = createLogger({ service: 'graph-recheck', level: 'warn' });
const pool = createPool({ connectionString: url, logger, applicationName: 'graph-recheck', max: 2 });
try {
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger });
  const tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(systemClock), clock: systemClock, logger });
  const catalog = new HttpCatalogAdapter({ config: loadCatalogHttpConfig(process.env, { allowNetwork: true, source: 'v2' }), fetch: (u, init) => fetch(u, init) });
  const facts = new PostgresArtifactFacts(pool);
  const result = await recheckReviews({
    artifacts: new PostgresArtifacts(pool),
    tasks,
    sheet: (key) => productSheetView(catalog, async (k) => (await facts.current(PRODUCT_GRAPH_KIND, k)).map((f) => ({ subject: f.subject, field: f.field, value: f.value, recordedBy: f.recordedBy, recordedAt: f.recordedAt })), key),
  }, { batchId: randomUUID(), reviews: await completedReviewTasks(pool) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`graph:recheck failed: ${error instanceof Error ? error.message.slice(0, 500) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
