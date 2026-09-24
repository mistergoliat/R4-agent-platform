import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PlatformError,
  agentRunSchema,
  systemClock,
  uuidV7Generator,
  uuidv7,
  type LeaseToken,
  type Observation,
  type Principal,
} from '@r4/contracts';
import { createSilentLogger } from '@r4/observability';
import { PostgresExecutionStore, PostgresTaskRuntimeStore } from '@r4/persistence-postgres';
import { ExecutionRuntime, type ClaimOutcome } from '@r4/task-runtime';
import type { Platform } from '@r4/api';
import type { Logger } from 'pino';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { captureLogs } from '../support/logs.js';
import { startTestPlatform, validTaskBody } from '../support/platform.js';
import { expireLease, leaseRow, stepsOf } from '../support/worker.js';

const actor: Principal = { kind: 'service', ref: 'lease-it' };
let db: TestDatabase;
let platform: Platform;

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  platform = await startTestPlatform(db.url);
});

afterEach(async () => {
  await platform?.close();
  await db?.drop();
});

function runtime(options: { maxRunRecoveries?: number; logger?: Logger } = {}): ExecutionRuntime {
  return new ExecutionRuntime({
    store: new PostgresExecutionStore(platform.pool),
    ids: uuidV7Generator(),
    clock: systemClock,
    logger: options.logger ?? createSilentLogger(),
    maxRunRecoveries: options.maxRunRecoveries ?? 3,
  });
}

async function createTask(): Promise<string> {
  const { view } = await platform.tasks.createTask({ request: validTaskBody({ taskType: 'probe.fact_lookup' }), requestedBy: actor, correlationId: 'lease-it' });
  return view.task.taskId;
}

function tokenOf(claim: ClaimOutcome | null): LeaseToken {
  if (!claim || claim.kind === 'abandoned') throw new Error(`expected a leased claim, got ${claim?.kind ?? 'null'}`);
  return { taskId: claim.lease.taskId, owner: claim.lease.owner, generation: claim.lease.generation };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await promise.then(
    () => expect.unreachable(`expected ${code}`),
    (error: unknown) => {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe(code);
    },
  );
}

const readStep = (runId: string, iteration: number) => ({
  runId,
  iteration,
  decision: { type: 'read_capability' as const, capabilityId: 'platform_test.get_test_fact', arguments: { factKey: 'alpha' } },
  outcome: 'pending' as const,
  usage: { inputTokens: 3, outputTokens: 2 },
});

describe('claiming', () => {
  it('claims a pending task: lease, running task and a new run in one transaction', async () => {
    const taskId = await createTask();
    const claim = await runtime().claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 });

    expect(claim?.kind).toBe('started');
    if (claim?.kind !== 'started') return;
    expect(claim.lease).toMatchObject({ taskId, owner: 'worker-a', generation: 1 });
    expect(Date.parse(claim.lease.expiresAt) - Date.parse(claim.lease.acquiredAt)).toBe(30_000);
    expect(agentRunSchema.parse(claim.run)).toMatchObject({ status: 'running', sequence: 1, recoveries: 0, termination: null });

    const view = await platform.tasks.getTask(taskId);
    // Only the lifecycle transition bumps the version; taking the lease does not.
    expect(view.task).toMatchObject({ status: 'running', statusReason: 'run_started', version: 2 });
    expect(view.runs).toEqual([{ runId: claim.run.runId, sequence: 1, status: 'running' }]);
    const transitions = await new PostgresTaskRuntimeStore(platform.pool).listTransitions(taskId);
    expect(transitions.at(-1)).toMatchObject({ fromStatus: 'pending', toStatus: 'running', actor: { kind: 'system', ref: 'worker:worker-a' } });
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_owner: 'worker-a', lease_generation: 1 });
  });

  it('returns null when nothing is runnable', async () => {
    expect(await runtime().claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 })).toBeNull();
    await createTask();
    await runtime().claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 });
    // The only task is leased by a live owner.
    expect(await runtime().claimNext({ workerId: 'worker-b', leaseDurationMs: 30_000 })).toBeNull();
  });

  it('lets exactly one of many concurrent claimers win a task', async () => {
    const taskId = await createTask();
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => runtime().claimNext({ workerId: `w-${i}`, leaseDurationMs: 30_000 })));
    const winners = claims.filter((c) => c !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ kind: 'started', lease: { taskId, generation: 1 } });
    const runs = await platform.pool.query('select count(*)::int as n from agent_runs where task_id = $1', [taskId]);
    expect(runs.rows[0].n).toBe(1);
  });

  it('distributes many tasks over concurrent claimers with no task claimed twice', async () => {
    const taskIds = new Set<string>();
    for (let i = 0; i < 20; i++) taskIds.add(await createTask());
    const claimed: string[] = [];
    await Promise.all(
      Array.from({ length: 8 }, async (_, w) => {
        const rt = runtime();
        for (;;) {
          const claim = await rt.claimNext({ workerId: `w-${w}`, leaseDurationMs: 30_000 });
          if (!claim) return;
          claimed.push(tokenOf(claim).taskId);
        }
      }),
    );
    expect(claimed).toHaveLength(20);
    expect(new Set(claimed)).toEqual(taskIds);
    const active = await platform.pool.query("select task_id, count(*)::int as n from agent_runs where status = 'running' group by task_id");
    expect(active.rows.every((r: { n: number }) => r.n === 1)).toBe(true);
    expect(active.rows).toHaveLength(20);
  });
});

describe('lease renewal and expiry', () => {
  it('renews without touching the task version, status or business state', async () => {
    const taskId = await createTask();
    const rt = runtime();
    const token = tokenOf(await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 5_000 }));
    const before = (await platform.tasks.getTask(taskId)).task;
    const leaseBefore = await leaseRow(platform.pool, taskId);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const renewed = await rt.renewLease(token, 60_000);
    expect(renewed).toMatchObject({ owner: 'worker-a', generation: 1 });
    const leaseAfter = await leaseRow(platform.pool, taskId);
    expect(leaseAfter.lease_expires_at!.getTime()).toBeGreaterThan(leaseBefore.lease_expires_at!.getTime() + 50_000);
    expect(leaseAfter.last_heartbeat_at!.getTime()).toBeGreaterThan(leaseBefore.last_heartbeat_at!.getTime());
    expect((await platform.tasks.getTask(taskId)).task).toEqual(before);
  });

  it('refuses to renew an expired lease, even before anyone takes over', async () => {
    const taskId = await createTask();
    const rt = runtime();
    const token = tokenOf(await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 }));
    await expireLease(platform.pool, taskId);
    expect(await rt.renewLease(token, 30_000)).toBeNull();
    await rejectsWith(rt.loadExecution(token), 'lease_lost');
  });

  it('expires on the database clock with real time too', async () => {
    const taskId = await createTask();
    const rt = runtime();
    const token = tokenOf(await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 1_000 }));
    expect(await rt.claimNext({ workerId: 'worker-b', leaseDurationMs: 30_000 })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await rt.renewLease(token, 30_000)).toBeNull();
    const takeover = await rt.claimNext({ workerId: 'worker-b', leaseDurationMs: 30_000 });
    expect(takeover).toMatchObject({ kind: 'resumed', takeover: true, previousOwner: 'worker-a', lease: { taskId, generation: 2 } });
  });
});

describe('takeover and fencing', () => {
  it('lets a second worker take over an expired lease and resume the same run', async () => {
    const taskId = await createTask();
    const rt = runtime();
    const first = await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 });
    const tokenA = tokenOf(first);
    await rt.recordStep(tokenA, readStep(first!.run.runId, 1));
    await expireLease(platform.pool, taskId);

    const second = await rt.claimNext({ workerId: 'worker-b', leaseDurationMs: 30_000 });
    expect(second).toMatchObject({ kind: 'resumed', takeover: true, previousOwner: 'worker-a', run: { runId: first!.run.runId, recoveries: 1 } });
    const execution = await rt.loadExecution(tokenOf(second));
    expect(execution.steps.map((s) => [s.iteration, s.outcome, s.leaseGeneration])).toEqual([[1, 'pending', 1]]);
    const runs = await platform.pool.query('select count(*)::int as n from agent_runs where task_id = $1', [taskId]);
    expect(runs.rows[0].n).toBe(1);
  });

  it('fences a stale worker: every owner-only write is rejected after takeover', async () => {
    const taskId = await createTask();
    const rt = runtime();
    const first = await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 });
    const tokenA = tokenOf(first);
    const pending = await rt.recordStep(tokenA, readStep(first!.run.runId, 1));
    await expireLease(platform.pool, taskId);
    const tokenB = tokenOf(await rt.claimNext({ workerId: 'worker-b', leaseDurationMs: 30_000 }));

    const snapshot = async () => ({
      task: (await platform.tasks.getTask(taskId)).task,
      run: await platform.tasks.getRun(first!.run.runId),
      steps: await stepsOf(platform.pool, first!.run.runId),
      observations: (await platform.pool.query('select count(*)::int as n from observations where task_id = $1', [taskId])).rows[0].n as number,
      lease: await leaseRow(platform.pool, taskId),
    });
    const before = await snapshot();

    const observation: Observation = {
      observationId: uuidv7(),
      taskId,
      runId: first!.run.runId,
      agentId: 'platform-probe',
      source: { kind: 'capability', capabilityId: 'platform_test.get_test_fact', capabilityVersion: 1, invocationId: pending.invocationId! },
      outcome: 'succeeded',
      payload: { stale: true },
      error: null,
      observedAt: new Date().toISOString(),
      validUntil: null,
      provenance: {},
      correlationId: 'stale',
    };
    await rejectsWith(rt.recordObservation(tokenA, observation), 'lease_lost');
    await rejectsWith(rt.recordStep(tokenA, { ...readStep(first!.run.runId, 2), outcome: 'recorded', decision: { type: 'respond', content: 'late' } }), 'lease_lost');
    await rejectsWith(rt.finishExecution(tokenA, { termination: { reason: 'completed' }, result: { summary: 'stale' } }), 'lease_lost');
    await rejectsWith(rt.loadExecution(tokenA), 'lease_lost');
    expect(await rt.ownershipOf(tokenA)).toBe('superseded');
    expect(await rt.ownershipOf(tokenB)).toBe('held');
    expect(await rt.renewLease(tokenA, 30_000)).toBeNull();
    expect(await rt.releaseLease(tokenA)).toBe(false);

    // Nothing the stale worker attempted reached durable state.
    expect(await snapshot()).toEqual(before);

    // The current owner writes normally.
    const recorded = await rt.recordObservation(tokenB, observation);
    expect(recorded.observationId).toBe(observation.observationId);
    const finished = await rt.finishExecution(tokenB, { termination: { reason: 'completed' }, result: { summary: 'ok', evidence: [recorded.observationId] } });
    expect(finished.task.status).toBe('completed');
  });

  it('fences the same worker too once it has re-claimed (generation, not identity)', async () => {
    const taskId = await createTask();
    const rt = runtime();
    const old = tokenOf(await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 }));
    await expireLease(platform.pool, taskId);
    const fresh = tokenOf(await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 }));
    expect(fresh.generation).toBe(old.generation + 1);
    await rejectsWith(rt.loadExecution(old), 'lease_lost');
    await expect(rt.loadExecution(fresh)).resolves.toBeDefined();
  });

  it('keeps one active run per task under concurrent takeover', async () => {
    const taskId = await createTask();
    const rt = runtime();
    await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 });
    await expireLease(platform.pool, taskId);
    const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => runtime().claimNext({ workerId: `taker-${i}`, leaseDurationMs: 30_000 })));
    expect(claims.filter((c) => c !== null)).toHaveLength(1);
    const runs = await platform.pool.query("select count(*)::int as n from agent_runs where task_id = $1 and status = 'running'", [taskId]);
    expect(runs.rows[0].n).toBe(1);
    expect((await leaseRow(platform.pool, taskId)).lease_generation).toBe(2);
  });
});

describe('release, recovery limit and cancellation', () => {
  it('releases ownership so the run resumes immediately, without counting a recovery', async () => {
    const taskId = await createTask();
    const rt = runtime();
    const first = await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 });
    expect(await rt.releaseLease(tokenOf(first))).toBe(true);
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_owner: null, lease_expires_at: null, lease_generation: 1 });
    const second = await rt.claimNext({ workerId: 'worker-b', leaseDurationMs: 30_000 });
    expect(second).toMatchObject({ kind: 'resumed', takeover: false, previousOwner: null, run: { runId: first!.run.runId, recoveries: 0 } });
  });

  it('abandons a run that keeps losing its lease (lease_lost) and fails the task', async () => {
    const taskId = await createTask();
    const rt = runtime({ maxRunRecoveries: 1 });
    const first = await rt.claimNext({ workerId: 'w-1', leaseDurationMs: 30_000 });
    await expireLease(platform.pool, taskId);
    expect(await rt.claimNext({ workerId: 'w-2', leaseDurationMs: 30_000 })).toMatchObject({ kind: 'resumed', run: { recoveries: 1 } });
    await expireLease(platform.pool, taskId);

    const third = await rt.claimNext({ workerId: 'w-3', leaseDurationMs: 30_000 });
    expect(third).toMatchObject({ kind: 'abandoned', previousOwner: 'w-2' });
    const run = await platform.tasks.getRun(first!.run.runId);
    expect(run).toMatchObject({
      status: 'abandoned',
      failure: null,
      termination: { reason: 'lease_lost', failureClass: 'lease', code: 'max_run_recoveries_exceeded', details: { recoveries: 1, maxRunRecoveries: 1, previousOwner: 'w-2' } },
    });
    expect((await platform.tasks.getTask(taskId)).task).toMatchObject({ status: 'failed', statusReason: 'lease_lost' });
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_owner: null });
    expect(await rt.claimNext({ workerId: 'w-4', leaseDurationMs: 30_000 })).toBeNull();
  });

  it('stops the owner when the task is cancelled: writes refused, heartbeat refused, not claimable', async () => {
    const taskId = await createTask();
    const rt = runtime();
    const claim = await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 });
    const token = tokenOf(claim);
    await platform.tasks.transitionTask({ taskId, to: 'cancelled', reason: 'requester_cancelled', actor, correlationId: 'cancel' });

    expect(await platform.tasks.getRun(claim!.run.runId)).toMatchObject({ status: 'cancelled', termination: { reason: 'cancelled', failureClass: null } });
    await rejectsWith(rt.recordStep(token, readStep(claim!.run.runId, 1)), 'task_not_runnable');
    expect(await rt.renewLease(token, 30_000)).toBeNull();
    expect(await rt.ownershipOf(token)).toBe('task_not_running');
    expect(await rt.releaseLease(token)).toBe(true);
    expect(await rt.ownershipOf(token)).toBe('released');
    expect(await rt.claimNext({ workerId: 'worker-b', leaseDurationMs: 30_000 })).toBeNull();
  });
});

describe('step log invariants', () => {
  it('assigns invocation ids to READs, refuses out-of-order iterations and a second pending READ', async () => {
    await createTask();
    const rt = runtime();
    const claim = await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 });
    const token = tokenOf(claim);
    const runId = claim!.run.runId;

    await rejectsWith(rt.recordStep(token, readStep(runId, 2)), 'iteration_conflict');
    const step = await rt.recordStep(token, readStep(runId, 1));
    expect(step).toMatchObject({ iteration: 1, outcome: 'pending', leaseGeneration: 1, completedAt: null });
    expect(step.invocationId).toMatch(/^[0-9a-f-]{36}$/);
    await rejectsWith(rt.recordStep(token, readStep(runId, 2)), 'pending_step_exists');
    await rejectsWith(rt.recordStep(token, { ...readStep(runId, 2), outcome: 'invalid', decision: null, error: { code: 'x', message: '' } }), 'terminal_step_requires_finish');

    const run = await platform.tasks.getRun(runId);
    expect(run.usage).toEqual({ modelCalls: 1, inputTokens: 3, outputTokens: 2, capabilityCalls: 0 });
  });

  it('writes the terminal step atomically with the ending', async () => {
    const taskId = await createTask();
    const rt = runtime();
    const claim = await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 });
    const runId = claim!.run.runId;
    const { run, task } = await rt.finishExecution(tokenOf(claim), {
      termination: { reason: 'invalid_decision', code: 'unknown_capability', message: 'nope' },
      finalStep: { runId, iteration: 1, decision: null, outcome: 'invalid', error: { code: 'unknown_capability', message: 'nope' }, usage: { inputTokens: 1, outputTokens: 1 } },
    });
    expect(run).toMatchObject({ status: 'failed', failure: { code: 'unknown_capability' }, termination: { reason: 'invalid_decision', failureClass: 'protocol' }, usage: { modelCalls: 1 } });
    // ADR-028: the run fails exactly as before; the durable task stays runnable for a recovery run.
    expect(run.termination!.details).toEqual({ runFailureRecovery: { outcome: 'continued', consecutiveFailures: 1, maxRunFailureRecoveries: 1 } });
    expect(task).toMatchObject({ status: 'running' });
    expect((await stepsOf(platform.pool, runId)).map((s) => s.outcome)).toEqual(['invalid']);
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_owner: null });
  });
});

describe('execution telemetry', () => {
  it('reports claims, renewals, expiry, recovery and resumption with task/worker metadata', async () => {
    const logs = captureLogs();
    const taskId = await createTask();
    const rt = runtime({ logger: logs.logger });
    const tokenA = tokenOf(await rt.claimNext({ workerId: 'worker-a', leaseDurationMs: 30_000 }));
    await rt.renewLease(tokenA, 30_000);
    await expireLease(platform.pool, taskId);
    await rt.claimNext({ workerId: 'worker-b', leaseDurationMs: 30_000 });

    expect(logs.events('task.claimed').map((e) => [e.workerId, e.generation])).toEqual([['worker-a', 1], ['worker-b', 2]]);
    expect(logs.events('task.lease.renewed')[0]).toMatchObject({ taskId, workerId: 'worker-a', generation: 1 });
    expect(logs.events('task.lease.expired')[0]).toMatchObject({ taskId, previousOwner: 'worker-a', workerId: 'worker-b' });
    expect(logs.events('worker.recovery')[0]).toMatchObject({ taskId, previousOwner: 'worker-a', workerId: 'worker-b', recoveries: 1, correlationId: 'lease-it' });
    expect(logs.events('run.resumed')[0]).toMatchObject({ taskId, takeover: true, agentId: 'platform-probe' });
  });
});
