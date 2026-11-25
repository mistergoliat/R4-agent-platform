import { parseArgs } from 'node:util';
import { AgentRegistry } from '@r4/agent-registry';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import { createLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresArtifacts, PostgresKnowledge, PostgresTaskRuntimeStore, createPool } from '@r4/persistence-postgres';
import { TaskRuntime } from '@r4/task-runtime';
import { INTERPRET_TOKENS_PER_TASK } from '../agent/definition.js';
import { explainWithinDailyCap, readPlan } from '../agent/explain.js';
import { presentProposal } from '../present.js';
import { readSignedGraph } from '../signed.js';

/**
 * `npm run graph:explain -- --proposal <id> --text "<lo que la persona explicó>" --by <operatorRef> [--wait-min 5]`
 * (ADR-058 Decision 11, G7b): the curator interprets the explanation and prints its PLAN, checked against the graph.
 * Nothing changes until `graph:confirm`. Daily cap R4_GRAPH_EXPLAIN_DAILY_USD (default 0.25, owner 2026-11-25) with the
 * model prices R4_GRAPH_MODEL_PRICE_IN_PER_M_USD / R4_GRAPH_MODEL_PRICE_OUT_PER_M_USD.
 */
const { values } = parseArgs({ options: { proposal: { type: 'string' }, text: { type: 'string' }, by: { type: 'string' }, 'wait-min': { type: 'string' } } });
const url = process.env.R4_DATABASE_URL;
const price = { input: Number(process.env.R4_GRAPH_MODEL_PRICE_IN_PER_M_USD), output: Number(process.env.R4_GRAPH_MODEL_PRICE_OUT_PER_M_USD) };
const cap = Number(process.env.R4_GRAPH_EXPLAIN_DAILY_USD ?? 0.25) || 0.25;
if (!url || !values.proposal || !values.text || !values.by || !(price.input > 0) || !(price.output > 0)) {
  process.stderr.write('usage: R4_DATABASE_URL=… R4_GRAPH_MODEL_PRICE_IN_PER_M_USD=<p> R4_GRAPH_MODEL_PRICE_OUT_PER_M_USD=<p> graph:explain --proposal <id> --text "<explicación>" --by <operatorRef> [--wait-min 5]\n');
  process.exit(2);
}
const logger = createLogger({ service: 'graph-explain', level: 'warn' });
const pool = createPool({ connectionString: url, logger, applicationName: 'graph-explain', max: 2 });
try {
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger });
  const tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(systemClock), clock: systemClock, logger });
  const artifacts = new PostgresArtifacts(pool);
  const started = await explainWithinDailyCap({ pool, artifacts, tasks, knowledge: new PostgresKnowledge(pool) }, {
    proposalId: values.proposal, explanation: values.text, by: values.by, price, capUsd: cap, maxTokens: INTERPRET_TOKENS_PER_TASK,
    waitMs: Math.min(30, Number(values['wait-min'] ?? 5) || 5) * 60_000,
  });
  const { status, plan, violations } = await readPlan({ artifacts, tasks }, started.taskId);
  const g = (await readSignedGraph(artifacts))!.graph;
  const changes = (plan?.changes ?? []).map((change) => presentProposal(g, { summary: '', change }, new Map()).question);
  process.stdout.write(`${JSON.stringify({ planId: started.taskId, status, similarOffered: started.similar, relationsShown: started.relations, plan, changes, violations, spentTodayUsd: started.spentTodayUsd })}\n`);
} catch (error) {
  process.stderr.write(`graph:explain failed: ${error instanceof Error ? error.message.slice(0, 500) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
