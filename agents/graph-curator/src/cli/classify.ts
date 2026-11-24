import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { AgentRegistry } from '@r4/agent-registry';
import { HttpCatalogAdapter, loadCatalogHttpConfig } from '@r4-adapters/catalog-http';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import { createLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresArtifactFacts, PostgresArtifacts, PostgresTaskRuntimeStore, createPool } from '@r4/persistence-postgres';
import { TaskRuntime } from '@r4/task-runtime';
import { productSheetView } from '../agent/capabilities.js';
import { askedToPesin, runClassificationBatch, tasksWithinBudget } from '../agent/batch.js';
import { loadGraphCuratorDefinition } from '../agent/definition.js';
import { PRODUCT_GRAPH_KIND } from '../graph.js';

/**
 * `npm run graph:classify -- [--limit 20] [--wait-min 10]` (ADR-058 G4a): one batch of the graph-curator agent. Creates
 * the classification tasks (governed runs on the graph-curator worker), waits for them, checks each result against the
 * product sheet and stores the valid ones as proposals. Budget: R4_GRAPH_AGENT_BUDGET_USD (default 1, owner decision)
 * converted to tokens with R4_GRAPH_MODEL_PRICE_PER_M_USD (the model's higher price per million tokens).
 */
const { values } = parseArgs({ options: { limit: { type: 'string' }, 'wait-min': { type: 'string' } } });
const url = process.env.R4_DATABASE_URL;
const price = Number(process.env.R4_GRAPH_MODEL_PRICE_PER_M_USD);
if (!url || !(price > 0)) {
  process.stderr.write('usage: R4_DATABASE_URL=… R4_GRAPH_MODEL_PRICE_PER_M_USD=<price> graph:classify [--limit N] [--wait-min M]\n');
  process.exit(2);
}
const capUsd = Number(process.env.R4_GRAPH_AGENT_BUDGET_USD ?? 1) || 1;
const perTask = loadGraphCuratorDefinition().budgets.maxTokens ?? 30_000;
// The US$ cap decides how many products this run classifies; --limit can only lower it.
const limit = Math.min(Math.max(1, Number(values.limit ?? 100) || 100), tasksWithinBudget(capUsd, price, perTask));
if (limit < 1) {
  process.stderr.write('the budget does not cover one task\n');
  process.exit(1);
}
const logger = createLogger({ service: 'graph-classify', level: 'warn' });
const pool = createPool({ connectionString: url, logger, applicationName: 'graph-classify', max: 2 });
try {
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger });
  const tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(systemClock), clock: systemClock, logger });
  const catalog = new HttpCatalogAdapter({ config: loadCatalogHttpConfig(process.env, { allowNetwork: true, source: 'v2' }), fetch: (u, init) => fetch(u, init) });
  const facts = new PostgresArtifactFacts(pool);
  const result = await runClassificationBatch({
    artifacts: new PostgresArtifacts(pool),
    tasks,
    sheet: async (key) => productSheetView(catalog, async (k) => (await facts.current(PRODUCT_GRAPH_KIND, k)).map((f) => ({ subject: f.subject, field: f.field, value: f.value, recordedBy: f.recordedBy, recordedAt: f.recordedAt })), key),
    asked: await askedToPesin(pool),
  }, { batchId: randomUUID(), limit, maxTokensPerTask: perTask, waitMs: Math.min(30, Math.max(1, Number(values['wait-min'] ?? 10) || 10)) * 60_000 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`graph:classify failed: ${error instanceof Error ? error.message.slice(0, 500) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
