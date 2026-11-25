import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { AgentRegistry } from '@r4/agent-registry';
import { HttpCatalogAdapter, loadCatalogHttpConfig } from '@r4-adapters/catalog-http';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import { createLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresArtifactFacts, PostgresArtifacts, PostgresKnowledge, PostgresTaskRuntimeStore, createPool } from '@r4/persistence-postgres';
import { TaskRuntime } from '@r4/task-runtime';
import { askedToPesin } from '../agent/batch.js';
import { productSheetView } from '../agent/capabilities.js';
import { REVIEW_TOKENS_PER_TASK } from '../agent/definition.js';
import { reviewedRelations, runReviewBatch, tokensSpent } from '../agent/review.js';
import { PRODUCT_GRAPH_KIND } from '../graph.js';
import { presentOpenProposals } from '../present.js';
import { signedGraphCriteria } from '../agent/explain.js';

/**
 * `npm run graph:review -- [--wave 4] [--per-task 10] [--wait-min 60]` (ADR-058 G4b): one run of the graph-curator
 * agent over the unreviewed relations, most asked to Pesín first. Spends at most R4_GRAPH_AGENT_BUDGET_USD (default 1,
 * owner decision 3), measured from the tokens the platform records and the model prices
 * R4_GRAPH_MODEL_PRICE_IN_PER_M_USD / R4_GRAPH_MODEL_PRICE_OUT_PER_M_USD (US$ per million input / output tokens).
 */
const { values } = parseArgs({ options: { wave: { type: 'string' }, 'per-task': { type: 'string' }, 'wait-min': { type: 'string' } } });
const url = process.env.R4_DATABASE_URL;
const price = { input: Number(process.env.R4_GRAPH_MODEL_PRICE_IN_PER_M_USD), output: Number(process.env.R4_GRAPH_MODEL_PRICE_OUT_PER_M_USD) };
if (!url || !(price.input > 0) || !(price.output > 0)) {
  process.stderr.write('usage: R4_DATABASE_URL=… R4_GRAPH_MODEL_PRICE_IN_PER_M_USD=<p> R4_GRAPH_MODEL_PRICE_OUT_PER_M_USD=<p> graph:review [--wave N] [--per-task N] [--wait-min M]\n');
  process.exit(2);
}
const bounded = (v: string | undefined, fallback: number, max: number) => Math.min(max, Math.max(1, Number(v ?? fallback) || fallback));
const logger = createLogger({ service: 'graph-review', level: 'warn' });
const pool = createPool({ connectionString: url, logger, applicationName: 'graph-review', max: 2 });
try {
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger });
  const tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(systemClock), clock: systemClock, logger });
  const catalog = new HttpCatalogAdapter({ config: loadCatalogHttpConfig(process.env, { allowNetwork: true, source: 'v2' }), fetch: (u, init) => fetch(u, init) });
  const facts = new PostgresArtifactFacts(pool);
  const result = await runReviewBatch({
    artifacts: new PostgresArtifacts(pool),
    tasks,
    sheet: (key) => productSheetView(catalog, async (k) => (await facts.current(PRODUCT_GRAPH_KIND, k)).map((f) => ({ subject: f.subject, field: f.field, value: f.value, recordedBy: f.recordedBy, recordedAt: f.recordedAt })), key),
    asked: await askedToPesin(pool),
    criteria: await signedGraphCriteria(new PostgresKnowledge(pool)),
    reviewed: await reviewedRelations(pool),
    spent: (ids) => tokensSpent(pool, ids),
  }, {
    batchId: randomUUID(), capUsd: Number(process.env.R4_GRAPH_AGENT_BUDGET_USD ?? 1) || 1, pricePerMillion: price,
    maxTokensPerTask: REVIEW_TOKENS_PER_TASK, wave: bounded(values.wave, 4, 10), perTask: bounded(values['per-task'], 10, 10),
    waitMs: bounded(values['wait-min'], 60, 180) * 60_000,
  });
  // ADR-058 G7a: runs refresh evidence, so the open proposals get their question again (no model).
  const presented = await presentOpenProposals(new PostgresArtifacts(pool), await askedToPesin(pool)).catch((e: unknown) => ({ error: e instanceof Error ? e.message.slice(0, 200) : 'unexpected_failure' }));
  process.stdout.write(`${JSON.stringify({ ...result, presented })}\n`);
} catch (error) {
  process.stderr.write(`graph:review failed: ${error instanceof Error ? error.message.slice(0, 500) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
