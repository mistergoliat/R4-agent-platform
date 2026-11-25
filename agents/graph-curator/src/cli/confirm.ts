import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { AgentRegistry } from '@r4/agent-registry';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import { createLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresArtifacts, PostgresKnowledge, PostgresTaskRuntimeStore, createPool } from '@r4/persistence-postgres';
import { TaskRuntime } from '@r4/task-runtime';
import { askedToPesin } from '../agent/batch.js';
import { confirmPlan } from '../agent/explain.js';
import { presentOpenProposals } from '../present.js';

/**
 * `npm run graph:confirm -- --plan <planId> --by <operatorRef> --scopes knowledge.curate,knowledge.sign [--only-this]`
 * (ADR-058 Decision 11, G7b): the person confirms the plan `graph:explain` printed. Their decisions are recorded in
 * their name; the new changes are approved for the next version (still signed in the console); the criterion is
 * verified and signed only with the scopes the person holds. `--only-this` applies only what the plan says about the
 * explained proposal.
 */
const { values } = parseArgs({ options: { plan: { type: 'string' }, by: { type: 'string' }, scopes: { type: 'string' }, 'only-this': { type: 'boolean' } } });
const url = process.env.R4_DATABASE_URL;
if (!url || !values.plan || !values.by) {
  process.stderr.write('usage: R4_DATABASE_URL=… graph:confirm --plan <planId> --by <operatorRef> [--scopes knowledge.curate,knowledge.sign] [--only-this]\n');
  process.exit(2);
}
const logger = createLogger({ service: 'graph-confirm', level: 'warn' });
const pool = createPool({ connectionString: url, logger, applicationName: 'graph-confirm', max: 2 });
try {
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger });
  const tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(systemClock), clock: systemClock, logger });
  const artifacts = new PostgresArtifacts(pool);
  const result = await confirmPlan({ artifacts, tasks, knowledge: new PostgresKnowledge(pool) }, {
    taskId: values.plan, by: values.by, scopes: (values.scopes ?? '').split(',').map((s) => s.trim()).filter(Boolean), onlyThis: values['only-this'] === true, correlationId: `graph-confirm-${randomUUID()}`,
  });
  const presented = await presentOpenProposals(artifacts, await askedToPesin(pool)).catch((e: unknown) => ({ error: e instanceof Error ? e.message.slice(0, 200) : 'unexpected_failure' }));
  process.stdout.write(`${JSON.stringify({ ...result, presented })}\n`);
} catch (error) {
  process.stderr.write(`graph:confirm failed: ${error instanceof Error ? error.message.slice(0, 500) : 'unexpected_failure'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
