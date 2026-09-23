import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentRunSchema, runStepSchema, systemClock, uuidV7Generator, type AgentRun, type Principal, type TaskView } from '@r4/contracts';
import type { CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { PostgresExecutionStore, PostgresTaskRuntimeStore } from '@r4/persistence-postgres';
import { ExecutionRuntime } from '@r4/task-runtime';
import type { WorkerCycle } from '@r4/worker';
import type { Platform } from '@r4/api';
import { GET_TEST_FACT_ID } from '../fixtures/capabilities/get-test-fact.js';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { complete, completeFromObservations, contextOf, read, respond, sequence } from '../support/decisions.js';
import { captureLogs } from '../support/logs.js';
import { startTestPlatform, validTaskBody } from '../support/platform.js';
import { leaseRow, observationsOf, startTestWorker, stepsOf, testCapabilities, waitFor, type TestWorker, type TestWorkerOptions } from '../support/worker.js';

const actor: Principal = { kind: 'service', ref: 'worker-it' };
let db: TestDatabase;
let platform: Platform;
const workers: TestWorker[] = [];

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  platform = await startTestPlatform(db.url);
});

afterEach(async () => {
  for (const w of workers.splice(0)) await w.platform.close();
  await platform?.close();
  await db?.drop();
});

async function worker(options: Omit<TestWorkerOptions, 'workerId'> & { workerId?: string }): Promise<TestWorker> {
  const w = await startTestWorker(db.url, { workerId: options.workerId ?? `worker-${workers.length + 1}`, ...options });
  workers.push(w);
  return w;
}

async function createTask(overrides: Record<string, unknown> = {}): Promise<string> {
  const { view } = await platform.tasks.createTask({
    request: validTaskBody({ taskType: 'probe.fact_lookup', goal: { description: 'Retrieve test fact and complete task' }, input: { factKey: 'platform.name' }, ...overrides }),
    requestedBy: actor,
    correlationId: 'worker-it',
  });
  return view.task.taskId;
}

async function runOnly(taskId: string): Promise<AgentRun> {
  const { runs } = await platform.tasks.getTask(taskId);
  expect(runs).toHaveLength(1);
  return platform.tasks.getRun(runs[0]!.runId);
}

function executed(cycle: WorkerCycle) {
  if (cycle.kind !== 'executed') throw new Error(`expected an executed cycle, got ${cycle.kind}`);
  return cycle;
}

/** Test-only write-class capability. It must never run. */
function withWriteCapability(calls: { n: number }): CapabilityRegistry {
  const registry = testCapabilities();
  registry.register({
    definition: {
      capabilityId: 'platform_test.write_thing',
      version: 1,
      description: 'Synthetic reversible write. Test-only; must never execute in C1.',
      owner: 'platform-test',
      riskClass: 'REVERSIBLE_WRITE',
      requiredScopes: ['platform_test.read'],
      identityRequirement: 'none',
      confirmationPolicy: 'none',
      approvalPolicy: 'none',
      idempotency: 'key_required',
      retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
      timeoutMs: 1_000,
      freshnessTtlMs: null,
      auditLevel: 'full',
    },
    input: z.strictObject({ value: z.string() }),
    output: z.strictObject({ ok: z.boolean() }),
    handler: () => {
      calls.n += 1;
      return Promise.resolve({ ok: true });
    },
  });
  return registry;
}

describe('C1 trajectory: pending → claim → READ → Observation → COMPLETE → completed', () => {
  it('executes a task automatically, end to end, through the platform-probe agent', async () => {
    const calls = { n: 0 };
    const w = await worker({
      script: sequence([(req) => read(GET_TEST_FACT_ID, { factKey: String(contextOf(req).task.input.factKey) }), completeFromObservations('The platform name is R4')]),
      capabilities: testCapabilities(({ factKey }) => {
        calls.n += 1;
        return Promise.resolve({ factKey, found: true, value: 'R4' });
      }),
    });
    w.platform.worker.start();

    // Created through the public API; nothing triggers the worker manually.
    const created = await platform.app.inject({ method: 'POST', url: '/v1/tasks', payload: validTaskBody({ taskType: 'probe.fact_lookup', goal: { description: 'Retrieve test fact and complete task' }, input: { factKey: 'platform.name' } }) });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.taskId as string;
    const done = await waitFor(async () => {
      const body = (await platform.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}` })).json<TaskView>();
      return body.task.status === 'completed' ? body : null;
    });

    const run = agentRunSchema.parse((await platform.app.inject({ method: 'GET', url: `/v1/runs/${done.runs[0]!.runId}` })).json());
    const [observation] = await observationsOf(platform.pool, taskId);
    expect(done.runs).toEqual([{ runId: run.runId, sequence: 1, status: 'completed' }]);
    expect(run).toMatchObject({
      status: 'completed',
      termination: { reason: 'completed', failureClass: null, code: 'completed' },
      usage: { modelCalls: 2, capabilityCalls: 1 },
      recoveries: 0,
      result: { summary: 'The platform name is R4', evidence: [observation!.observationId] },
    });
    expect(done.task).toMatchObject({ status: 'completed', statusReason: 'run_completed', result: run.result });
    expect(observation).toMatchObject({ runId: run.runId, outcome: 'succeeded', payload: { factKey: 'platform.name', found: true, value: 'R4' } });
    expect(calls.n).toBe(1);

    const steps = await stepsOf(platform.pool, run.runId);
    for (const step of steps) expect(runStepSchema.safeParse(step).success).toBe(true);
    expect(steps.map((s) => [s.iteration, s.decision?.type, s.outcome, s.observationId])).toEqual([
      [1, 'read_capability', 'observed', observation!.observationId],
      [2, 'complete', 'recorded', null],
    ]);
    // The second model call saw the persisted observation.
    expect(contextOf(w.provider.requests[1]!).observations.map((o) => o.observationId)).toEqual([observation!.observationId]);

    const transitions = await new PostgresTaskRuntimeStore(platform.pool).listTransitions(taskId);
    expect(transitions.map((t) => [t.fromStatus, t.toStatus, t.actor.kind])).toEqual([
      [null, 'pending', 'unauthenticated'],
      ['pending', 'running', 'system'],
      ['running', 'completed', 'system'],
    ]);
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_owner: null, lease_generation: 1 });
  });

  it('records respond as run output and continues the loop', async () => {
    const taskId = await createTask();
    const w = await worker({ script: [respond('looking it up'), complete('done')] });
    const cycle = executed(await w.platform.worker.runOnce());
    expect(cycle.outcome).toEqual({ kind: 'terminated', termination: expect.objectContaining({ reason: 'completed' }) });
    const run = await runOnly(taskId);
    expect((await stepsOf(platform.pool, run.runId)).map((s) => [s.decision?.type, s.outcome])).toEqual([
      ['respond', 'recorded'],
      ['complete', 'recorded'],
    ]);
    expect(contextOf(w.provider.requests[1]!).responses).toEqual([{ iteration: 1, content: 'looking it up' }]);
  });
});

describe('classified failures', () => {
  async function runFailing(script: TestWorkerOptions['script'], capabilities?: CapabilityRegistry, policy?: TestWorkerOptions['policy']) {
    const taskId = await createTask();
    const w = await worker({ script, ...(capabilities ? { capabilities } : {}), ...(policy ? { policy } : {}) });
    executed(await w.platform.worker.runOnce());
    const run = await runOnly(taskId);
    return { taskId, run, task: (await platform.tasks.getTask(taskId)).task, steps: await stepsOf(platform.pool, run.runId), observations: await observationsOf(platform.pool, taskId) };
  }

  it('provider error → model_failure (model class)', async () => {
    const r = await runFailing([{ type: 'provider_error', message: 'upstream 500' }]);
    expect(r.run).toMatchObject({ status: 'failed', termination: { reason: 'model_failure', failureClass: 'model', code: 'provider_error' }, failure: { code: 'provider_error' } });
    expect(r.task).toMatchObject({ status: 'failed', statusReason: 'model_failure' });
    expect(r.steps.map((s) => [s.outcome, s.error?.code])).toEqual([['model_failed', 'provider_error']]);
  });

  it('model timeout → model_failure (timeout)', async () => {
    const r = await runFailing([{ type: 'timeout', ignoreAbort: true }], undefined, { modelCallTimeoutMs: 150 });
    expect(r.run.termination).toMatchObject({ reason: 'model_failure', code: 'timeout' });
  });

  it('invalid decision → invalid_decision (protocol class), nothing stored beyond the error', async () => {
    const r = await runFailing([{ type: 'structured', data: { type: 'respond', content: 'x', reasoning: 'SECRET CHAIN OF THOUGHT' } }]);
    expect(r.run.termination).toMatchObject({ reason: 'invalid_decision', failureClass: 'protocol', code: 'invalid_decision_schema' });
    expect(r.steps).toMatchObject([{ outcome: 'invalid', decision: null }]);
    const raw = await platform.pool.query('select row_to_json(s)::text as j from agent_run_steps s where run_id = $1', [r.run.runId]);
    expect(raw.rows[0].j).not.toContain('SECRET');
  });

  it('unknown decision type → invalid_decision', async () => {
    const r = await runFailing([{ type: 'structured', data: { type: 'delegate' } }]);
    expect(r.run.termination).toMatchObject({ reason: 'invalid_decision', code: 'unknown_decision_type' });
  });

  it('unknown capability → invalid_decision, nothing executed', async () => {
    const r = await runFailing([read('platform_test.does_not_exist', {})]);
    expect(r.run.termination).toMatchObject({ reason: 'invalid_decision', code: 'unknown_capability' });
    expect(r.observations).toEqual([]);
  });

  it('write-class capability → rejected (capability_not_permitted); its handler never runs', async () => {
    const calls = { n: 0 };
    const r = await runFailing([read('platform_test.write_thing', { value: 'x' })], withWriteCapability(calls));
    expect(r.run.termination).toMatchObject({ reason: 'invalid_decision', code: 'capability_not_permitted' });
    expect(calls.n).toBe(0);
    expect(r.observations).toEqual([]);
  });

  it('invalid arguments → rejected observation fed back; the agent can recover', async () => {
    const calls = { n: 0 };
    const capabilities = testCapabilities(({ factKey }) => {
      calls.n += 1;
      return Promise.resolve({ factKey, found: false, value: null });
    });
    const r = await runFailing(sequence([read(GET_TEST_FACT_ID, { factKey: 42 }), completeFromObservations('arguments were rejected')]), capabilities);
    expect(r.run.termination?.reason).toBe('completed');
    expect(r.observations).toMatchObject([{ outcome: 'rejected', error: { code: 'invalid_arguments' } }]);
    expect(r.steps.map((s) => s.outcome)).toEqual(['observed', 'recorded']);
    expect(calls.n).toBe(0);
  });

  it('capability error → failed observation fed back as evidence', async () => {
    const capabilities = testCapabilities(() => Promise.reject(new Error('fact store offline')));
    const r = await runFailing(sequence([read(GET_TEST_FACT_ID, { factKey: 'alpha' }), completeFromObservations('source failed')]), capabilities);
    expect(r.observations).toMatchObject([{ outcome: 'failed', error: { code: 'handler_error', message: 'fact store offline' } }]);
    expect(r.run).toMatchObject({ status: 'completed', result: { evidence: [r.observations[0]!.observationId] } });
  });

  it('complete citing evidence the task never observed → invalid_decision', async () => {
    const r = await runFailing([complete('fabricated', ['01890000-0000-7000-8000-000000000000'])]);
    expect(r.run.termination).toMatchObject({ reason: 'invalid_decision', code: 'unknown_evidence' });
    expect(r.task.result).toBeNull();
  });
});

describe('budgets', () => {
  it('stops a model that READs forever, deterministically', async () => {
    const taskId = await createTask();
    const w = await worker({ script: () => read(GET_TEST_FACT_ID, { factKey: 'alpha' }), policy: { maxReadCapabilityCalls: 3 } });
    executed(await w.platform.worker.runOnce());
    const run = await runOnly(taskId);
    expect(run).toMatchObject({
      status: 'failed',
      termination: { reason: 'budget_exhausted', failureClass: 'budget', code: 'max_read_capability_calls', details: { limit: 3, used: 3 } },
      usage: { modelCalls: 4, capabilityCalls: 3 },
    });
    expect((await stepsOf(platform.pool, run.runId)).map((s) => s.outcome)).toEqual(['observed', 'observed', 'observed', 'refused']);
    expect(await observationsOf(platform.pool, taskId)).toHaveLength(3);
    expect((await platform.tasks.getTask(taskId)).task).toMatchObject({ status: 'failed', statusReason: 'budget_exhausted' });
  });

  it('applies the task budget when tighter than the policy', async () => {
    const taskId = await createTask({ budget: { maxModelCalls: 2 } });
    const w = await worker({ script: () => respond('still thinking') });
    executed(await w.platform.worker.runOnce());
    expect((await runOnly(taskId)).termination).toMatchObject({ reason: 'budget_exhausted', code: 'max_model_calls' });
    expect(w.provider.callCount).toBe(2);
  });
});

describe('cancellation', () => {
  it('stops at the next fenced write when the task is cancelled mid-run; no evidence is recorded after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered = { n: 0 };
    const taskId = await createTask();
    const w = await worker({
      script: [read(GET_TEST_FACT_ID, { factKey: 'alpha' })],
      capabilities: testCapabilities(async ({ factKey }) => {
        entered.n += 1;
        await gate;
        return { factKey, found: true, value: 'first' };
      }),
    });
    const cycle = w.platform.worker.runOnce();
    await waitFor(() => entered.n === 1);
    await platform.tasks.transitionTask({ taskId, to: 'cancelled', reason: 'requester_cancelled', actor, correlationId: 'cancel' });
    release();

    expect(executed(await cycle).outcome).toEqual({ kind: 'interrupted', cause: 'task_not_runnable' });
    const run = await runOnly(taskId);
    expect(run).toMatchObject({ status: 'cancelled', termination: { reason: 'cancelled' } });
    expect(await observationsOf(platform.pool, taskId)).toEqual([]);
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_owner: null });
  });
});

describe('cancellation during a model call', () => {
  it('is detected by the heartbeat as task_not_runnable (not a lost lease) and the lease is released', async () => {
    const logs = captureLogs();
    const taskId = await createTask();
    const w = await worker({ script: [{ type: 'timeout' }], leaseDurationMs: 1_000, heartbeatIntervalMs: 200, logger: logs.logger, policy: { modelCallTimeoutMs: 20_000 } });
    const cycle = w.platform.worker.runOnce();
    await waitFor(() => w.provider.callCount === 1);
    await platform.tasks.transitionTask({ taskId, to: 'cancelled', reason: 'requester_cancelled', actor, correlationId: 'cancel' });

    const started = Date.now();
    expect(executed(await cycle).outcome).toEqual({ kind: 'interrupted', cause: 'task_not_runnable' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(logs.events('lease.lost')).toEqual([]);
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_owner: null });
    expect(await runOnly(taskId)).toMatchObject({ status: 'cancelled', termination: { reason: 'cancelled' } });
  });
});

describe('heartbeat', () => {
  // Margins are sized for a loaded CI machine: the step lasts > 2.5 leases, so
  // only renewals can keep ownership, while one late heartbeat is tolerated.
  it('keeps the lease alive through a long step; nobody else can claim meanwhile', async () => {
    const logs = captureLogs();
    const taskId = await createTask();
    const w = await worker({
      script: sequence([read(GET_TEST_FACT_ID, { factKey: 'alpha' }), completeFromObservations()]),
      capabilities: testCapabilities(
        async ({ factKey }) => {
          await new Promise((resolve) => setTimeout(resolve, 4_000));
          return { factKey, found: true, value: 'slow' };
        },
        { timeoutMs: 12_000 },
      ),
      leaseDurationMs: 1_500,
      heartbeatIntervalMs: 250,
      logger: logs.logger,
    });
    const intruder = new ExecutionRuntime({ store: new PostgresExecutionStore(platform.pool), ids: uuidV7Generator(), clock: systemClock, logger: createSilentLogger(), maxRunRecoveries: 3 });

    const cycle = w.platform.worker.runOnce();
    const attempts: unknown[] = [];
    const probe = (async () => {
      for (let i = 0; i < 12; i++) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        attempts.push(await intruder.claimNext({ workerId: 'intruder', leaseDurationMs: 30_000 }));
      }
    })();
    const outcome = executed(await cycle).outcome;
    await probe;

    expect(outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'completed' } });
    // The READ really ran for its full duration (not cut short by a capability timeout).
    expect(await observationsOf(platform.pool, taskId)).toMatchObject([{ outcome: 'succeeded', payload: { value: 'slow' } }]);
    expect(attempts.filter((a) => a !== null)).toEqual([]);
    const renewals = logs.events('task.lease.renewed').filter((e) => e.taskId === taskId);
    expect(renewals.length).toBeGreaterThanOrEqual(8);
    expect(renewals.every((e) => e.workerId === 'worker-1' && e.generation === 1)).toBe(true);
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_generation: 1 });
  });

  it('detects a lost lease through the heartbeat and aborts the in-flight model call', async () => {
    const logs = captureLogs();
    const taskId = await createTask();
    const w = await worker({ script: [{ type: 'timeout' }], leaseDurationMs: 1_000, heartbeatIntervalMs: 200, logger: logs.logger, policy: { modelCallTimeoutMs: 20_000 } });
    const cycle = w.platform.worker.runOnce();
    await waitFor(() => w.provider.callCount === 1);
    // Another worker takes over (simulated by force-expiring and claiming).
    await platform.pool.query(`update agent_tasks set lease_expires_at = clock_timestamp() - interval '1 ms' where task_id = $1`, [taskId]);
    const started = Date.now();
    expect(executed(await cycle).outcome).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
    // Aborted by the heartbeat long before the 20 s model timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(logs.events('lease.lost')[0]).toMatchObject({ taskId, workerId: 'worker-1', detectedBy: 'heartbeat' });
    // The interrupted call was not recorded as a model failure.
    expect(await stepsOf(platform.pool, (await runOnly(taskId)).runId)).toEqual([]);
    expect((await runOnly(taskId)).status).toBe('running');
  });
});

describe('telemetry', () => {
  it('emits the C1 events with correlation, task, run, agent, worker and iteration — and no content', async () => {
    const logs = captureLogs();
    const taskId = await createTask({ input: { factKey: 'platform.name', note: 'SECRET-INPUT' }, goal: { description: 'SECRET-GOAL' } });
    const w = await worker({ script: sequence([read(GET_TEST_FACT_ID, { factKey: 'platform.name' }), completeFromObservations('SECRET-SUMMARY')]), logger: logs.logger });
    await w.platform.worker.runOnce();
    const runId = (await runOnly(taskId)).runId;

    for (const name of ['task.claimed', 'run.started', 'agent.decision', 'capability.invoked', 'observation.persisted', 'run.completed']) {
      expect(logs.events(name).length, name).toBeGreaterThan(0);
    }
    for (const name of ['agent.decision', 'capability.invoked', 'observation.persisted']) {
      for (const event of logs.events(name)) {
        expect(event, name).toMatchObject({ correlationId: 'worker-it', taskId, runId, agentId: 'platform-probe', workerId: 'worker-1' });
        expect(typeof event.iteration, name).toBe('number');
      }
    }
    expect(logs.events('run.completed')[0]).toMatchObject({ taskId, runId, terminationReason: 'completed', workerId: 'worker-1' });
    // Gateway telemetry inherits the run's correlation context.
    expect(logs.events('model.call.completed')[0]).toMatchObject({ taskId, runId, agentId: 'platform-probe' });
    expect(logs.raw()).not.toContain('SECRET');
  });
});
