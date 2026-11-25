import { parseArgs } from 'node:util';
import { AgentRegistry } from '@r4/agent-registry';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import { createLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresArtifacts, PostgresKnowledge, PostgresTaskRuntimeStore, createPool } from '@r4/persistence-postgres';
import { TaskRuntime } from '@r4/task-runtime';
import { waitForTasks } from '../agent/batch.js';
import { GRAPH_CURATOR_AGENT_ID, INTERPRET_TOKENS_PER_TASK, TASK_INTERPRET_EXPLANATION } from '../agent/definition.js';
import { readPlan, signedGraphCriteria, startExplanation } from '../agent/explain.js';
import { tokensSpent } from '../agent/review.js';
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
  // The daily cap counts what today's interpretations really used, plus this one at its worst.
  const today = (await pool.query<{ task_id: string }>(`select task_id from agent_tasks where agent_id = $1 and task_type = $2 and created_at >= current_date`, [GRAPH_CURATOR_AGENT_ID, TASK_INTERPRET_EXPLANATION])).rows.map((r) => r.task_id);
  const used = await tokensSpent(pool, today);
  const spent = (used.inputTokens * price.input + used.outputTokens * price.output) / 1_000_000;
  const worst = (INTERPRET_TOKENS_PER_TASK * Math.max(price.input, price.output)) / 1_000_000;
  if (spent + worst > cap) throw new Error(`daily cap: US$${spent.toFixed(4)} used today of US$${cap}; this interpretation could take up to US$${worst.toFixed(4)}`);
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger });
  const tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(systemClock), clock: systemClock, logger });
  const artifacts = new PostgresArtifacts(pool);
  const started = await startExplanation({ artifacts, tasks, criteria: await signedGraphCriteria(new PostgresKnowledge(pool)) }, { proposalId: values.proposal, explanation: values.text, by: values.by, maxTokens: INTERPRET_TOKENS_PER_TASK });
  const done = new Map<string, { status: string; result: Record<string, unknown> | null }>();
  await waitForTasks(tasks, new Map([['plan', started.taskId]]), done as never, Date.now() + (Math.min(30, Number(values['wait-min'] ?? 5) || 5) * 60_000));
  const { status, plan, violations } = await readPlan({ artifacts, tasks }, started.taskId);
  const g = (await readSignedGraph(artifacts))!.graph;
  const changes = (plan?.changes ?? []).map((change) => presentProposal(g, { summary: '', change }, new Map()).question);
  process.stdout.write(`${JSON.stringify({ planId: started.taskId, status, similarOffered: started.similar, relationsShown: started.relations, plan, changes, violations, spentTodayUsd: Math.round(spent * 10_000) / 10_000 })}\n`);
} catch (error) {
  process.stderr.write(`graph:explain failed: ${error instanceof Error ? error.message.slice(0, 500) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
