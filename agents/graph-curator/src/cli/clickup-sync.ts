import { readFileSync } from 'node:fs';
import { ClickUpConnector, loadClickUpConfig } from '@r4-adapters/clickup';
import { AgentRegistry } from '@r4/agent-registry';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import { createLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresArtifacts, PostgresKnowledge, PostgresTaskRuntimeStore, createPool } from '@r4/persistence-postgres';
import { TaskRuntime } from '@r4/task-runtime';
import { askedToPesin } from '../agent/batch.js';
import { syncClickUp } from '../agent/clickup.js';
import { INTERPRET_TOKENS_PER_TASK } from '../agent/definition.js';
import { explainWithinDailyCap } from '../agent/explain.js';
import { presentOpenProposals } from '../present.js';

/**
 * `npm run graph:clickup-sync` (ADR-058 Decision 13, G6): one pass of the PM's ClickUp list (meant for a short pm2
 * cron). Env:
 * - the ClickUp connector's (R4_CLICKUP_*, from the console vault; R4_CLICKUP_ASSIGNEE_ID = the PM's ClickUp user);
 * - R4_GRAPH_PM_OPERATOR_REF: the PM as an R4 operator (oidc:<operatorRef>), in whose name decisions are recorded;
 * - R4_CONSOLE_OPERATORS_FILE: where the PM's scopes are read (criteria are signed only with knowledge.sign);
 * - R4_GRAPH_CONSOLE_URL: the console page linked from each task;
 * - R4_GRAPH_MODEL_PRICE_IN/OUT_PER_M_USD and R4_GRAPH_EXPLAIN_DAILY_USD (default 0.25) for the comments;
 * - R4_GRAPH_CLICKUP_MAX_OPEN (default 10) and R4_GRAPH_CLICKUP_DUE_DAYS (default 7).
 */
const env = process.env;
const url = env.R4_DATABASE_URL;
const pmRef = env.R4_GRAPH_PM_OPERATOR_REF?.trim();
const consoleUrl = env.R4_GRAPH_CONSOLE_URL?.trim();
const price = { input: Number(env.R4_GRAPH_MODEL_PRICE_IN_PER_M_USD), output: Number(env.R4_GRAPH_MODEL_PRICE_OUT_PER_M_USD) };
if (!url || !pmRef || !consoleUrl || !(price.input > 0) || !(price.output > 0)) {
  process.stderr.write('usage: R4_DATABASE_URL=… R4_CLICKUP_*=… R4_GRAPH_PM_OPERATOR_REF=… R4_GRAPH_CONSOLE_URL=… R4_GRAPH_MODEL_PRICE_IN_PER_M_USD=<p> R4_GRAPH_MODEL_PRICE_OUT_PER_M_USD=<p> graph:clickup-sync\n');
  process.exit(2);
}
/** The PM's scopes, from the console operators registry (ADR-050); none if not found. */
function scopesOf(ref: string): string[] {
  const file = env.R4_CONSOLE_OPERATORS_FILE;
  if (!file) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const list = (Array.isArray(raw) ? raw : ((raw as { operators?: unknown[] }).operators ?? [])) as { operatorRef?: string; scopes?: string[] }[];
  return list.find((o) => `oidc:${o.operatorRef}` === ref)?.scopes ?? [];
}
const bounded = (v: string | undefined, fallback: number, max: number) => Math.min(max, Math.max(1, Number(v ?? fallback) || fallback));
const logger = createLogger({ service: 'graph-clickup-sync', level: 'warn' });
const pool = createPool({ connectionString: url, logger, applicationName: 'graph-clickup-sync', max: 2 });
try {
  const config = loadClickUpConfig(env, { allowNetwork: env.R4_PROD_ALLOW_NETWORK === 'true' });
  if (config.assigneeId === null) throw new Error('R4_CLICKUP_ASSIGNEE_ID (the PM) is required: only their answers count');
  const board = new ClickUpConnector(config);
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger });
  const tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(systemClock), clock: systemClock, logger });
  const artifacts = new PostgresArtifacts(pool);
  const knowledge = new PostgresKnowledge(pool);
  const asked = await askedToPesin(pool);
  const capUsd = Number(env.R4_GRAPH_EXPLAIN_DAILY_USD ?? 0.25) || 0.25;
  const report = await syncClickUp({
    artifacts, tasks, knowledge, board, asked,
    explain: async (proposalId, text) => (await explainWithinDailyCap({ pool, artifacts, tasks, knowledge }, { proposalId, explanation: text, by: pmRef, price, capUsd, maxTokens: INTERPRET_TOKENS_PER_TASK, waitMs: 5 * 60_000 })).taskId,
  }, {
    pmClickUpId: config.assigneeId, pmRef, pmScopes: scopesOf(pmRef), maxOpen: bounded(env.R4_GRAPH_CLICKUP_MAX_OPEN, 10, 50),
    dueDays: bounded(env.R4_GRAPH_CLICKUP_DUE_DAYS, 7, 60), consoleUrl,
  });
  // Decisions change what is open: the console's questions follow (G7a).
  const presented = await presentOpenProposals(artifacts, asked).catch((e: unknown) => ({ error: e instanceof Error ? e.message.slice(0, 200) : 'unexpected_failure' }));
  process.stdout.write(`${JSON.stringify({ ...report, presented })}\n`);
  if (report.errors.length) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`graph:clickup-sync failed: ${error instanceof Error ? error.message.slice(0, 500) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
