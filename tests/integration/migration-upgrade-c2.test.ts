import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import { AgentRegistry, loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import {
  DEFAULT_MIGRATIONS_DIR,
  PostgresAgentDefinitionStore,
  PostgresContextSnapshotStore,
  PostgresExecutionStore,
  PostgresTaskRuntimeStore,
  migrate,
  migrationStatus,
  type Pool,
} from '@r4/persistence-postgres';
import { ExecutionRuntime, TaskRuntime } from '@r4/task-runtime';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { complete } from '../support/decisions.js';
import { REPO_AGENTS_DIR, validTaskBody } from '../support/platform.js';
import { expireLease, startTestWorker, stepsOf, waitFor } from '../support/worker.js';

/**
 * Upgrade path R4-C1 → R4-C2: a database at 0002 with a run in progress (a
 * step recorded without any context snapshot) is migrated to 0003; nothing is
 * reinterpreted, and a C2 worker continues the same run with snapshots.
 */
let db: TestDatabase;
let pool: Pool;
let c1Dir: string;
let taskId = '';
let runId = '';

beforeAll(async () => {
  db = await createTestDatabase();
  pool = openPool(db.url);
  c1Dir = await mkdtemp(join(tmpdir(), 'r4c1-migrations-'));
  for (const file of ['0001_initial_runtime_schema.sql', '0002_execution_kernel.sql']) await cp(join(DEFAULT_MIGRATIONS_DIR, file), join(c1Dir, file));
  expect(await migrate(pool, { directory: c1Dir })).toEqual({ applied: ['0001_initial_runtime_schema', '0002_execution_kernel'] });

  // C1 state: a claimed task whose run already recorded one step, written the way C1 wrote it.
  const logger = createSilentLogger();
  const ids = uuidV7Generator();
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger });
  await agents.sync((await loadAgentDefinitionsFromDirectory(REPO_AGENTS_DIR)).map((d) => d.definition));
  const tasks = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids, clock: systemClock, logger });
  taskId = (await tasks.createTask({ request: validTaskBody({ taskType: 'probe.fact_lookup' }), requestedBy: { kind: 'service', ref: 'c1' }, correlationId: 'c1-upgrade' })).view.task.taskId;
  const claim = await pool.query<{ task_id: string }>(`update agent_tasks set status = 'running', version = version + 1, lease_owner = 'c1-worker', lease_generation = 1, lease_acquired_at = now(), lease_expires_at = now() + interval '1 minute', last_heartbeat_at = now() where task_id = $1 returning task_id`, [taskId]);
  expect(claim.rowCount).toBe(1);
  runId = ids.next();
  await pool.query(
    `insert into agent_runs (run_id, task_id, sequence, agent_id, agent_version, status, correlation_id, version, started_at, created_at, updated_at, model_calls)
     values ($1, $2, 1, 'platform-probe', 1, 'running', 'c1-upgrade', 2, now(), now(), now(), 1)`,
    [runId, taskId],
  );
  await pool.query(
    `insert into agent_run_steps (step_id, run_id, task_id, iteration, lease_generation, decision_type, decision, outcome, input_tokens, output_tokens, correlation_id, created_at, completed_at)
     values ($1, $2, $3, 1, 1, 'respond', '{"type":"respond","content":"c1 step"}'::jsonb, 'recorded', 1, 1, 'c1-upgrade', now(), now())`,
    [ids.next(), runId, taskId],
  );
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
  if (c1Dir) await rm(c1Dir, { recursive: true, force: true });
});

describe('upgrade from the R4-C1 schema', () => {
  it('reports exactly the C2 migration as pending and applies it without touching C1 rows', async () => {
    expect((await migrationStatus(pool)).pending).toEqual(['0003_context_and_memory', '0004_governed_execution', '0005_temporal_human_runtime', '0007_governed_production', '0008_worker_presence']);
    expect(await migrate(pool)).toEqual({ applied: ['0003_context_and_memory', '0004_governed_execution', '0005_temporal_human_runtime', '0007_governed_production', '0008_worker_presence'] });
    const steps = await new PostgresExecutionStore(pool).transaction((uow) => uow.listRunSteps(runId));
    expect(steps).toEqual([expect.objectContaining({ iteration: 1, outcome: 'recorded', contextSnapshotId: null })]);
  });

  it('lets a C2 worker continue the C1 run: new steps are tied to snapshots, the old one stays as it was', async () => {
    await expireLease(pool, taskId);
    const w = await startTestWorker(db.url, { workerId: 'c2-worker', script: [complete('continued after upgrade')] });
    try {
      const cycle = await waitFor(async () => {
        const c = await w.platform.worker.runOnce();
        return c.kind === 'executed' ? c : null;
      });
      expect(cycle).toMatchObject({ runId, claim: 'resumed', outcome: { kind: 'terminated', termination: { reason: 'completed' } } });
      const steps = await stepsOf(pool, runId);
      const [snapshot] = await new PostgresContextSnapshotStore(pool).listForRun(runId);
      expect(steps.map((s) => [s.iteration, s.contextSnapshotId])).toEqual([[1, null], [2, snapshot!.snapshotId]]);
      expect(snapshot).toMatchObject({ iteration: 2, attempt: 1 });
      // The C1 respond output is part of the continued context, as what the agent said.
      expect(snapshot!.compiledContext.sections.conversation).toEqual([expect.objectContaining({ authority: 'CONVERSATIONAL', content: expect.objectContaining({ text: 'c1 step', iteration: 1 }) })]);
      const execution = new ExecutionRuntime({ store: new PostgresExecutionStore(pool), ids: uuidV7Generator(), clock: systemClock, logger: createSilentLogger(), maxRunRecoveries: 3 });
      expect(await execution.claimNext({ workerId: 'nobody', leaseDurationMs: 1_000 })).toBeNull();
    } finally {
      await w.platform.close();
    }
  });
});
