import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Platform } from '@r4/api';
import { GET_TEST_FACT_ID } from '../fixtures/capabilities/get-test-fact.js';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { completeFromObservations, contextOf, sequence } from '../support/decisions.js';
import { startTestPlatform, validTaskBody } from '../support/platform.js';
import { leaseRow, observationsOf, startTestWorker, stepsOf, testCapabilities, waitFor, type TestWorker } from '../support/worker.js';

/**
 * Real crash: a worker running in its own OS process is killed with SIGKILL
 * (no shutdown hook, no lease release) right after its observation is
 * persisted. A second worker must take over after lease expiry, rebuild the
 * loop from PostgreSQL alone and complete without re-executing the READ.
 *
 * Requires the built packages (`npm run build`): the child runs dist code.
 */
const CHILD = fileURLToPath(new URL('./fixtures/crashing-worker.mjs', import.meta.url));
const WORKER_DIST = fileURLToPath(new URL('../../apps/worker/dist/index.js', import.meta.url));

let db: TestDatabase;
let platform: Platform;
let child: ChildProcess | null = null;
let workerB: TestWorker | null = null;
const childLines: Record<string, unknown>[] = [];

beforeAll(async () => {
  if (!existsSync(WORKER_DIST)) throw new Error('apps/worker/dist is missing: run "npm run build" before "npm run test:recovery"');
  db = await createMigratedTestDatabase();
  platform = await startTestPlatform(db.url);
});

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await workerB?.platform.close();
  await platform?.close();
  await db?.drop();
});

describe('worker process crash (SIGKILL)', () => {
  it('crash after Observation → lease expiry → second worker → completion, READ not repeated', async () => {
    const { view } = await platform.tasks.createTask({
      request: validTaskBody({ taskType: 'probe.fact_lookup', goal: { description: 'Retrieve test fact and complete task' }, input: { factKey: 'platform.name' } }),
      requestedBy: { kind: 'service', ref: 'recovery' },
      correlationId: 'sigkill-recovery',
    });
    const taskId = view.task.taskId;

    child = spawn(process.execPath, [CHILD], {
      env: {
        ...process.env,
        R4_DATABASE_URL: db.url,
        R4_WORKER_ID: 'process-a',
        R4_WORKER_LEASE_MS: '1500',
        R4_WORKER_HEARTBEAT_MS: '250',
        R4_WORKER_POLL_MS: '50',
        R4_EXEC_MODEL_CALL_TIMEOUT_MS: '600000',
        R4_LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('{')) childLines.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child!.once('exit', (_code, signal) => resolve(signal)));

    // Wait until the observation is durable AND the process has heartbeated at least once.
    const [observation] = await waitFor(async () => {
      const found = await observationsOf(platform.pool, taskId);
      return found.length === 1 ? found : null;
    }, 30_000, 50);
    await waitFor(() => childLines.some((l) => l.event === 'task.lease.renewed'), 10_000, 50);

    child.kill('SIGKILL');
    expect(await exited).toBe('SIGKILL');

    // Killed, not stopped: the lease was NOT released and the run is orphaned.
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_owner: 'process-a', lease_generation: 1 });
    const runId = (await platform.tasks.getTask(taskId)).runs[0]!.runId;
    expect((await platform.tasks.getRun(runId)).status).toBe('running');

    let bHandlerCalls = 0;
    workerB = await startTestWorker(db.url, {
      workerId: 'process-b',
      script: sequence([completeFromObservations('recovered after SIGKILL')]),
      capabilities: testCapabilities(({ factKey }) => {
        bHandlerCalls += 1;
        return Promise.resolve({ factKey, found: true, value: 'R4' });
      }),
    });
    const cycle = await waitFor(async () => {
      const c = await workerB!.platform.worker.runOnce();
      return c.kind === 'executed' ? c : null;
    }, 15_000, 50);

    expect(cycle).toMatchObject({ claim: 'resumed', takeover: true, runId, outcome: { kind: 'terminated', termination: { reason: 'completed' } } });
    expect(await platform.tasks.getRun(runId)).toMatchObject({
      status: 'completed',
      recoveries: 1,
      usage: { capabilityCalls: 1 },
      result: { summary: 'recovered after SIGKILL', evidence: [observation!.observationId] },
    });
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');

    // Exactly one execution of the READ, ever — by the killed process.
    expect(childLines.filter((l) => l.event === 'child.handler.executed')).toHaveLength(1);
    expect(bHandlerCalls).toBe(0);
    expect(await observationsOf(platform.pool, taskId)).toHaveLength(1);
    // B rebuilt the loop from PostgreSQL: its single model call saw A's observation.
    expect(workerB.provider.callCount).toBe(1);
    expect(contextOf(workerB.provider.requests[0]!).observations.map((o) => o.observationId)).toEqual([observation!.observationId]);
    expect((await stepsOf(platform.pool, runId)).map((s) => [s.iteration, s.decision?.type, s.outcome, s.leaseGeneration])).toEqual([
      [1, 'read_capability', 'observed', 1],
      [2, 'complete', 'recorded', 2],
    ]);

    // The killed process reported its own telemetry while alive.
    const events = new Set(childLines.map((l) => l.event));
    for (const name of ['worker.started', 'task.claimed', 'run.started', 'agent.decision', 'capability.invoked', 'observation.persisted', 'task.lease.renewed']) {
      expect(events.has(name), name).toBe(true);
    }
    expect(childLines.find((l) => l.event === 'observation.persisted')).toMatchObject({ taskId, workerId: 'process-a', iteration: 1, correlationId: 'sigkill-recovery' });
    // The child inlines the fixture capability (it runs plain JS): keep them in sync.
    expect(childLines.find((l) => l.event === 'capability.invoked')).toMatchObject({ capabilityId: GET_TEST_FACT_ID });
  });
});
