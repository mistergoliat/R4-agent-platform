import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemClock, uuidV7Generator, type Principal } from '@r4/contracts';
import { AgentKernel, KernelInterrupt, type KernelOutcome, type KernelSession } from '@r4/agent-kernel';
import { AgentRegistry } from '@r4/agent-registry';
import type { CapabilityRegistry } from '@r4/capability-runtime';
import { DefaultModelGateway, FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresAgentDefinitionStore, PostgresExecutionStore, PostgresObservationStore, PostgresTaskRuntimeStore, type Pool } from '@r4/persistence-postgres';
import { ExecutionRuntime, TemporalRuntime } from '@r4/task-runtime';
import { DurableKernelSession, type WorkerCycle } from '@r4/worker';
import type { Platform } from '@r4/api';
import { GET_TEST_FACT_ID } from '../fixtures/capabilities/get-test-fact.js';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { completeFromObservations, contextOf, read, readThenComplete, respond, sequence } from '../support/decisions.js';
import { captureLogs } from '../support/logs.js';
import { startTestPlatform, validTaskBody } from '../support/platform.js';
import { TEST_POLICY, expireLease, leaseRow, observationsOf, startTestWorker, stepsOf, testCapabilities, waitFor, type TestWorker, type TestWorkerOptions } from '../support/worker.js';

const actor: Principal = { kind: 'service', ref: 'recovery-it' };
let db: TestDatabase;
let platform: Platform;
const cleanups: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  platform = await startTestPlatform(db.url);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await platform?.close();
  await db?.drop();
});

async function createTask(): Promise<string> {
  const { view } = await platform.tasks.createTask({ request: validTaskBody({ taskType: 'probe.fact_lookup', input: { factKey: 'platform.name' } }), requestedBy: actor, correlationId: 'recovery-it' });
  return view.task.taskId;
}

async function worker(options: TestWorkerOptions): Promise<TestWorker> {
  const w = await startTestWorker(db.url, options);
  cleanups.push(() => w.platform.close());
  return w;
}

/**
 * A worker that "dies" mid-run: its own pool and runtime and NO heartbeat.
 * Tests end its lease with `expireLease` at the moment of "death" (lease time
 * fast-forwarded on the database clock), which is deterministic; real-time
 * expiry is covered by execution-leases and the SIGKILL recovery test. When it
 * "comes back" late it tries to keep writing, which fencing must refuse.
 */
async function dyingWorker(options: { script: FakeModelScript; capabilities: CapabilityRegistry; modelCallTimeoutMs: number }) {
  const pool: Pool = openPool(db.url);
  const logger = createSilentLogger();
  const ids = uuidV7Generator();
  const execution = new ExecutionRuntime({ store: new PostgresExecutionStore(pool), ids, clock: systemClock, logger, maxRunRecoveries: 3 });
  const claim = await execution.claimNext({ workerId: 'worker-a', leaseDurationMs: 60_000 });
  if (!claim || claim.kind === 'abandoned') throw new Error('dying worker could not claim');
  const provider = new FakeModelProvider(options.script);
  const kernel = new AgentKernel({ gateway: new DefaultModelGateway({ provider, logger }), logger });
  const session = new DurableKernelSession({
    lease: claim.lease,
    execution,
    agents: new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger }),
    capabilities: options.capabilities,
    observations: new PostgresObservationStore(pool),
    policy: { ...TEST_POLICY, modelCallTimeoutMs: options.modelCallTimeoutMs },
    ids,
    clock: systemClock,
    logger,
  });
  const outcome: Promise<KernelOutcome> = kernel.run(session, { workerId: 'worker-a' });
  cleanups.push(async () => {
    await outcome;
    await pool.end();
  });
  return { claim, provider, outcome };
}

/** Polls a worker until it actually executes something (e.g. once a lease expired). */
async function runUntilExecuted(w: TestWorker): Promise<Extract<WorkerCycle, { kind: 'executed' }>> {
  return waitFor(async () => {
    const cycle = await w.platform.worker.runOnce();
    return cycle.kind === 'executed' ? cycle : null;
  }, 15_000, 50);
}

describe('crash recovery', () => {
  it('worker crash after Observation → lease expiry → second worker completes without repeating the invocation', async () => {
    const taskId = await createTask();
    const handlerCalls = { a: 0, b: 0 };

    // Worker A: READ → observation persisted → hangs on the next model call and never heartbeats.
    const a = await dyingWorker({
      script: [read(GET_TEST_FACT_ID, { factKey: 'platform.name' }), { type: 'timeout', ignoreAbort: true }],
      capabilities: testCapabilities(({ factKey }) => {
        handlerCalls.a += 1;
        return Promise.resolve({ factKey, found: true, value: 'R4' });
      }),
      modelCallTimeoutMs: 3_000,
    });
    const [observation] = await waitFor(async () => {
      const found = await observationsOf(platform.pool, taskId);
      return found.length === 1 ? found : null;
    });
    await waitFor(() => a.provider.callCount === 2);
    // A "dies" here: hung in its second model call, no heartbeats, lease runs out.
    await expireLease(platform.pool, taskId);

    // Worker B: a separate composition (own pool, registries, model) — only PostgreSQL is shared.
    const b = await worker({
      workerId: 'worker-b',
      script: sequence([completeFromObservations('recovered')]),
      capabilities: testCapabilities(({ factKey }) => {
        handlerCalls.b += 1;
        return Promise.resolve({ factKey, found: true, value: 'R4' });
      }),
    });
    const cycle = await runUntilExecuted(b);
    expect(cycle).toMatchObject({ claim: 'resumed', takeover: true, runId: a.claim.run.runId, outcome: { kind: 'terminated', termination: { reason: 'completed' } } });

    // B continued from the durable observation: one model call, no capability re-execution.
    expect(b.provider.callCount).toBe(1);
    expect(contextOf(b.provider.requests[0]!).observations.map((o) => o.observationId)).toEqual([observation!.observationId]);
    expect(handlerCalls).toEqual({ a: 1, b: 0 });
    expect(await observationsOf(platform.pool, taskId)).toHaveLength(1);

    const run = await platform.tasks.getRun(a.claim.run.runId);
    expect(run).toMatchObject({ status: 'completed', recoveries: 1, result: { summary: 'recovered', evidence: [observation!.observationId] } });
    expect((await stepsOf(platform.pool, run.runId)).map((s) => [s.iteration, s.outcome, s.leaseGeneration])).toEqual([
      [1, 'observed', 1],
      [2, 'recorded', 2],
    ]);

    // A "returns" when its model call times out, and is fenced: nothing recorded.
    expect(await a.outcome).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
    expect(await stepsOf(platform.pool, run.runId)).toHaveLength(2);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
  });

  it('crash between decision and observation: the next owner executes the SAME invocation; the stale result is refused', async () => {
    const taskId = await createTask();
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => (releaseA = resolve));
    const handlerCalls = { a: 0, b: 0 };

    const a = await dyingWorker({
      script: [read(GET_TEST_FACT_ID, { factKey: 'platform.name' })],
      capabilities: testCapabilities(
        async ({ factKey }) => {
          handlerCalls.a += 1;
          await gateA;
          return { factKey, found: true, value: 'stale-from-a' };
        },
        // Long enough that A's late result is the handler's own output, not a timeout.
        { timeoutMs: 30_000 },
      ),
      modelCallTimeoutMs: 3_000,
    });
    await waitFor(() => handlerCalls.a === 1);
    const [pending] = await stepsOf(platform.pool, a.claim.run.runId);
    expect(pending).toMatchObject({ outcome: 'pending', leaseGeneration: 1 });
    // A "dies" here: stuck inside the capability, no heartbeats, lease runs out.
    await expireLease(platform.pool, taskId);

    const b = await worker({
      workerId: 'worker-b',
      script: sequence([completeFromObservations('done')]),
      capabilities: testCapabilities(({ factKey }) => {
        handlerCalls.b += 1;
        return Promise.resolve({ factKey, found: true, value: 'fresh-from-b' });
      }),
    });
    const cycle = await runUntilExecuted(b);
    expect(cycle.outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'completed' } });
    // The decision was not re-asked: B's only model call came after the observation.
    expect(b.provider.callCount).toBe(1);

    releaseA();
    expect(await a.outcome).toEqual({ kind: 'interrupted', cause: 'lease_lost' });

    const observations = await observationsOf(platform.pool, taskId);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ source: { invocationId: pending!.invocationId }, payload: { value: 'fresh-from-b' } });
    // Re-executing the READ was necessary (no evidence existed) and used the recorded invocation id.
    expect(handlerCalls).toEqual({ a: 1, b: 1 });
    expect(await stepsOf(platform.pool, a.claim.run.runId)).toMatchObject([
      { iteration: 1, outcome: 'observed', invocationId: pending!.invocationId, observationId: observations[0]!.observationId },
      { iteration: 2, outcome: 'recorded' },
    ]);
  });

  it('graceful restart: a stopped worker releases its lease and a fresh worker resumes the same run at once', async () => {
    const taskId = await createTask();
    const a = await startTestWorker(db.url, { workerId: 'worker-a', script: [read(GET_TEST_FACT_ID, { factKey: 'alpha' }), { type: 'timeout' }] });
    a.platform.worker.start();
    await waitFor(async () => (await observationsOf(platform.pool, taskId)).length === 1 && a.provider.callCount === 2);
    await a.platform.close();
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_owner: null, lease_generation: 1 });

    const b = await worker({ workerId: 'worker-b', script: sequence([completeFromObservations('after restart')]), leaseDurationMs: 30_000, heartbeatIntervalMs: 5_000 });
    const cycle = await b.platform.worker.runOnce();
    expect(cycle).toMatchObject({ kind: 'executed', claim: 'resumed', takeover: false, outcome: { kind: 'terminated', termination: { reason: 'completed' } } });
    const run = (await platform.tasks.getTask(taskId)).runs;
    expect(run).toHaveLength(1);
    expect(await platform.tasks.getRun(run[0]!.runId)).toMatchObject({ status: 'completed', recoveries: 0, usage: { modelCalls: 2, capabilityCalls: 1 } });
  });
});

describe('duplicate workers', () => {
  it('many concurrent workers: one owner and one run per task, one observation per invocation, valid transitions only', async () => {
    const logs = captureLogs();
    const handlerCalls = { n: 0 };
    const pool = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        worker({
          workerId: `dup-${i}`,
          script: readThenComplete(GET_TEST_FACT_ID, { factKey: 'platform.name' }),
          capabilities: testCapabilities(({ factKey }) => {
            handlerCalls.n += 1;
            return Promise.resolve({ factKey, found: true, value: 'R4' });
          }),
          logger: logs.logger,
        }),
      ),
    );
    for (const w of pool) w.platform.worker.start();
    const taskIds: string[] = [];
    for (let i = 0; i < 12; i++) taskIds.push(await createTask());

    await waitFor(async () => {
      const { rows } = await platform.pool.query<{ n: number }>("select count(*)::int as n from agent_tasks where status = 'completed'");
      return rows[0]!.n === taskIds.length;
    }, 30_000, 50);

    const store = new PostgresTaskRuntimeStore(platform.pool);
    for (const taskId of taskIds) {
      const { task, runs } = await platform.tasks.getTask(taskId);
      expect(runs).toHaveLength(1);
      const run = await platform.tasks.getRun(runs[0]!.runId);
      expect(run).toMatchObject({ status: 'completed', recoveries: 0, usage: { modelCalls: 2, capabilityCalls: 1 } });
      expect(await stepsOf(platform.pool, run.runId)).toHaveLength(2);
      expect(await observationsOf(platform.pool, taskId)).toHaveLength(1);
      expect((await store.listTransitions(taskId)).map((t) => `${t.fromStatus}->${t.toStatus}`)).toEqual(['null->pending', 'pending->running', 'running->completed']);
      expect(task.status).toBe('completed');
      expect((await leaseRow(platform.pool, taskId)).lease_generation).toBe(1);
    }
    expect(handlerCalls.n).toBe(taskIds.length);

    const claimedBy = new Map<string, string[]>();
    for (const event of logs.events('task.claimed')) claimedBy.set(event.taskId as string, [...(claimedBy.get(event.taskId as string) ?? []), event.workerId as string]);
    expect([...claimedBy.values()].every((owners) => owners.length === 1)).toBe(true);
    expect(claimedBy.size).toBe(taskIds.length);
    const invocations = await platform.pool.query<{ n: number; d: number }>('select count(*)::int as n, count(distinct invocation_id)::int as d from observations');
    expect(invocations.rows[0]).toEqual({ n: 12, d: 12 });
    // More than one worker actually participated.
    expect(new Set([...claimedBy.values()].flat()).size).toBeGreaterThan(1);
  });
});

describe('R4-J1E-R2.2 crash between a durable response and its turn-closing wait', () => {
  it('the next owner of the run records only the wait: no model call, no second response, one recorded reply', async () => {
    const taskId = await createTask();
    // Worker A: real execution and temporal runtimes; it dies right after the response became durable.
    const pool: Pool = openPool(db.url);
    cleanups.push(() => pool.end());
    const logger = createSilentLogger();
    const ids = uuidV7Generator();
    const store = new PostgresExecutionStore(pool);
    const execution = new ExecutionRuntime({ store, ids, clock: systemClock, logger, maxRunRecoveries: 3 });
    const temporal = new TemporalRuntime({ store, execution, ids, logger });
    const claim = await execution.claimNext({ workerId: 'worker-a', leaseDurationMs: 60_000 });
    if (!claim || claim.kind === 'abandoned') throw new Error('worker A could not claim');
    const durable = new DurableKernelSession({
      lease: claim.lease, execution, temporal,
      agents: new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger }),
      capabilities: testCapabilities(), observations: new PostgresObservationStore(pool), policy: TEST_POLICY, ids, clock: systemClock, logger,
    });
    const dying: KernelSession = {
      load: () => durable.load(),
      prepareContext: (c) => durable.prepareContext(c),
      recordStep: (s) => durable.recordStep(s),
      executeRead: (s, d) => durable.executeRead(s, d),
      executeAction: (s, d) => durable.executeAction(s, d),
      finish: (e) => durable.finish(e),
      // The process dies before the turn-closing wait is written.
      executeTemporal: () => Promise.reject(new KernelInterrupt('unavailable')),
    };
    const kernelA = new AgentKernel({ gateway: new DefaultModelGateway({ provider: new FakeModelProvider([respond('the fact is R4')]), logger }), logger });
    expect(await kernelA.run(dying)).toEqual({ kind: 'interrupted', cause: 'unavailable' });
    const [run] = (await platform.tasks.getTask(taskId)).runs;
    expect((await stepsOf(platform.pool, run!.runId)).map((s) => [s.decision?.type, s.outcome, s.origin])).toEqual([['respond', 'recorded', 'model']]);

    // A's lease runs out; worker B takes over the SAME run and only closes the turn.
    await expireLease(platform.pool, taskId);
    const b = await worker({ workerId: 'worker-b', script: [respond('a second reply must never be asked for')] });
    await runUntilExecuted(b);
    expect(b.provider.callCount).toBe(0);
    const view = await platform.tasks.getTask(taskId);
    expect(view.task.status).toBe('waiting');
    expect(view.runs.map((r) => [r.runId, r.status])).toEqual([[run!.runId, 'suspended']]);
    expect((await stepsOf(platform.pool, run!.runId)).map((s) => [s.decision?.type, s.outcome, s.origin])).toEqual([
      ['respond', 'recorded', 'model'],
      ['wait', 'recorded', 'platform'],
    ]);
  });
});
