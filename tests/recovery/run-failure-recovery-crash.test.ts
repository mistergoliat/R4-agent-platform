import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Platform } from '@r4/api';
import { runFailureRecoveryOf } from '@r4/contracts';
import { PostgresContextSnapshotStore } from '@r4/persistence-postgres';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { complete, sequence } from '../support/decisions.js';
import { startTestPlatform, validTaskBody } from '../support/platform.js';
import { leaseRow, startTestWorker, waitFor, type TestWorker } from '../support/worker.js';

/**
 * ADR-028 under a real crash: a worker process fails a run recoverably
 * (invalid output), claims the recovery run like any run, and is SIGKILLed
 * while that run's model call is in flight. C1 semantics apply unchanged:
 * the orphaned recovery run keeps its lease until expiry, then another
 * worker takes over THE SAME run (fencing by generation) — a crash never
 * creates a third run and never counts as a run failure.
 *
 * Requires the built packages (`npm run build`): the child runs dist code.
 */
const CHILD = fileURLToPath(new URL('./fixtures/crashing-recovery-worker.mjs', import.meta.url));
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

describe('worker process crash during a recovery run (SIGKILL)', () => {
  it('recoverable failure → recovery run claimed → SIGKILL mid-call → lease expiry → same run taken over → no third run', async () => {
    const { view } = await platform.tasks.createTask({
      request: validTaskBody({ taskType: 'probe.fact_lookup', goal: { description: 'Retrieve test fact and complete task' }, input: { factKey: 'platform.name' } }),
      requestedBy: { kind: 'service', ref: 'recovery' },
      correlationId: 'sigkill-run-failure-recovery',
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
        R4_EXEC_MAX_ITERATIONS: '20',
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

    // The child failed run 1 recoverably, claimed run 2 (the recovery), persisted its fresh snapshot and is inside its model call.
    const started = await waitFor(() => childLines.find((l) => l.event === 'task.run_failure.recovery_started'), 30_000, 50);
    await waitFor(() => childLines.some((l) => l.event === 'context.snapshot.persisted' && l.runId === started.runId), 10_000, 50);
    await waitFor(() => childLines.some((l) => l.event === 'task.lease.renewed' && l.generation === 2), 10_000, 50);

    child.kill('SIGKILL');
    expect(await exited).toBe('SIGKILL');

    const summaries = (await platform.tasks.getTask(taskId)).runs;
    expect(summaries).toHaveLength(2);
    const failed = await platform.tasks.getRun(summaries[0]!.runId);
    const recovery = await platform.tasks.getRun(summaries[1]!.runId);
    expect(runFailureRecoveryOf(failed.termination)).toEqual({ outcome: 'continued', consecutiveFailures: 1, maxRunFailureRecoveries: 1 });
    expect(recovery).toMatchObject({ runId: started.runId, sequence: 2, status: 'running' });
    // Killed, not stopped: the recovery run's lease was NOT released.
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_owner: 'process-a', lease_generation: 2 });

    workerB = await startTestWorker(db.url, { workerId: 'process-b', script: sequence([complete('recovered after SIGKILL')]) });
    const cycle = await waitFor(async () => {
      const c = await workerB!.platform.worker.runOnce();
      return c.kind === 'executed' ? c : null;
    }, 15_000, 50);

    expect(cycle).toMatchObject({ claim: 'resumed', takeover: true, runId: recovery.runId, outcome: { kind: 'terminated', termination: { reason: 'completed' } } });
    expect(await platform.tasks.getRun(recovery.runId)).toMatchObject({ status: 'completed', recoveries: 1 });
    expect((await platform.tasks.getTask(taskId)).runs).toHaveLength(2);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
    // The crash was a lease recovery of the same run, not another run failure: run 1 keeps its record, run 2 has none.
    expect(runFailureRecoveryOf((await platform.tasks.getRun(recovery.runId)).termination)).toBeNull();
    // Each run compiled its own context. The takeover stays in the recovery run's iteration 1 (B's different
    // composition compiles a superseding attempt there, per C2) — never a snapshot of a new run.
    const stored = await new PostgresContextSnapshotStore(platform.pool).listForRun(recovery.runId);
    expect(stored.every((s) => s.runId === recovery.runId && s.iteration === 1)).toBe(true);
    expect(childLines.filter((l) => l.event === 'context.snapshot.persisted').map((l) => l.runId)).toEqual([failed.runId, recovery.runId]);
  });
});
