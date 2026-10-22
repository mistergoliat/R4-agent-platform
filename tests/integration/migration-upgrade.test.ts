import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, uuidV7Generator, uuidv7 } from '@r4/contracts';
import { AgentRegistry, loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import {
  DEFAULT_MIGRATIONS_DIR,
  PostgresAgentDefinitionStore,
  PostgresExecutionStore,
  PostgresTaskRuntimeStore,
  checkDatabaseReadiness,
  migrate,
  migrationStatus,
  type Pool,
} from '@r4/persistence-postgres';
import { ExecutionRuntime, TaskRuntime } from '@r4/task-runtime';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { REPO_AGENTS_DIR, validTaskBody } from '../support/platform.js';

/**
 * Upgrade path R4-B → R4-C1: a database at 0001 holding R4-B data (tasks,
 * finished and running runs, observations) is migrated to the current schema
 * without losing or reinterpreting anything, and the worker can take it over.
 */
let db: TestDatabase;
let pool: Pool;
let r4bDir: string;
const tasks: Record<'pending' | 'runningRun' | 'completedRun' | 'failedRun', string> = { pending: '', runningRun: '', completedRun: '', failedRun: '' };
const runs: Record<'running' | 'completed' | 'failed', string> = { running: '', completed: '', failed: '' };

beforeAll(async () => {
  db = await createTestDatabase();
  pool = openPool(db.url);
  r4bDir = await mkdtemp(join(tmpdir(), 'r4b-migrations-'));
  await cp(join(DEFAULT_MIGRATIONS_DIR, '0001_initial_runtime_schema.sql'), join(r4bDir, '0001_initial_runtime_schema.sql'));
  expect(await migrate(pool, { directory: r4bDir })).toEqual({ applied: ['0001_initial_runtime_schema'] });

  // R4-B data, written the way R4-B wrote it.
  const agents = new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger: createSilentLogger() });
  await agents.sync((await loadAgentDefinitionsFromDirectory(REPO_AGENTS_DIR)).map((d) => d.definition));
  const runtime = new TaskRuntime({ store: new PostgresTaskRuntimeStore(pool), agents, ids: uuidV7Generator(), clock: systemClock, logger: createSilentLogger() });
  for (const key of Object.keys(tasks) as (keyof typeof tasks)[]) {
    tasks[key] = (await runtime.createTask({ request: validTaskBody({ taskType: 'probe.fact_lookup' }), requestedBy: { kind: 'service', ref: 'r4b' }, correlationId: `r4b-${key}` })).view.task.taskId;
  }
  const insertRun = async (taskId: string, status: string, failure: [string, string] | null) => {
    const runId = uuidv7();
    await pool.query(`update agent_tasks set status = 'running', version = version + 1 where task_id = $1`, [taskId]);
    await pool.query(
      `insert into agent_runs (run_id, task_id, sequence, agent_id, agent_version, status, correlation_id, version,
         started_at, finished_at, created_at, updated_at, failure_code, failure_message)
       values ($1, $2, 1, 'platform-probe', 1, $3, 'r4b', 1, now(), case when $3 = 'running' then null else now() end, now(), now(), $4, $5)`,
      [runId, taskId, status, failure?.[0] ?? null, failure?.[1] ?? null],
    );
    return runId;
  };
  runs.running = await insertRun(tasks.runningRun, 'running', null);
  runs.completed = await insertRun(tasks.completedRun, 'completed', null);
  runs.failed = await insertRun(tasks.failedRun, 'failed', ['model.timeout', 'gateway timeout']);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
  if (r4bDir) await rm(r4bDir, { recursive: true, force: true });
});

describe('upgrade from the R4-B schema', () => {
  it('reports exactly the post-R4-B migrations as pending on an R4-B database', async () => {
    // RR-1 R-4: 0011_binding_identity_immutability is the Core head (binding identity trigger).
    expect((await migrationStatus(pool)).pending).toEqual(['0002_execution_kernel', '0003_context_and_memory', '0004_governed_execution', '0005_temporal_human_runtime', '0007_governed_production', '0008_worker_presence', '0009_run_step_origin', '0010_platform_step_decisions', '0011_binding_identity_immutability']);
    expect((await checkDatabaseReadiness(pool)).ok).toBe(false);
  });

  it('applies 0002 (and 0003) over existing data and backfills structured terminations', async () => {
    expect(await migrate(pool)).toEqual({ applied: ['0002_execution_kernel', '0003_context_and_memory', '0004_governed_execution', '0005_temporal_human_runtime', '0007_governed_production', '0008_worker_presence', '0009_run_step_origin', '0010_platform_step_decisions', '0011_binding_identity_immutability'] });
    expect((await checkDatabaseReadiness(pool)).ok).toBe(true);

    const store = new PostgresTaskRuntimeStore(pool);
    expect(await store.getRun(runs.completed)).toMatchObject({ status: 'completed', termination: { reason: 'completed', failureClass: null, code: 'completed' }, recoveries: 0 });
    expect(await store.getRun(runs.failed)).toMatchObject({
      status: 'failed',
      failure: { code: 'model.timeout', message: 'gateway timeout' },
      // R4-B never recorded why a run failed: the platform classifies it as unknown/internal.
      termination: { reason: 'internal_failure', failureClass: 'platform', code: 'model.timeout', message: 'gateway timeout' },
    });
    expect(await store.getRun(runs.running)).toMatchObject({ status: 'running', termination: null, recoveries: 0 });

    const leases = await pool.query('select count(*)::int as n from agent_tasks where lease_owner is not null or lease_generation <> 0');
    expect(leases.rows[0].n).toBe(0);
  });

  it('lets a worker take over R4-B work: pending tasks start, orphaned running runs resume', async () => {
    const execution = new ExecutionRuntime({ store: new PostgresExecutionStore(pool), ids: uuidV7Generator(), clock: systemClock, logger: createSilentLogger(), maxRunRecoveries: 3 });
    const claims = [];
    for (;;) {
      const claim = await execution.claimNext({ workerId: 'upgrade-worker', leaseDurationMs: 30_000 });
      if (!claim) break;
      claims.push(claim);
    }
    const byTask = new Map(claims.map((c) => [c.task.taskId, c]));
    expect(byTask.get(tasks.pending)).toMatchObject({ kind: 'started' });
    expect(byTask.get(tasks.runningRun)).toMatchObject({ kind: 'resumed', takeover: false, run: { runId: runs.running } });
    // Tasks whose only run already finished are running without an active run: a new run starts.
    expect(byTask.get(tasks.completedRun)).toMatchObject({ kind: 'started', run: { sequence: 2 } });
    expect(claims).toHaveLength(4);
  });
});
