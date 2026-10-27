// R4-J4-R6 EV-2: a task never executes with a runtime profile incompatible with its pinned definition.
// A worker that declares `servedAgents` claims (and reconciles) only tasks pinned to one of them; any
// other task stays durable and visible, and a compatible worker picks it up later.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Platform } from '@r4/api';
import type { ServedAgents } from '@r4/task-runtime';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { actionCapabilities, createActionTask, ledgerOf, startActionPlatform, WRITES } from '../support/actions.js';
import { expireLease, leaseRow, startTestWorker, type TestWorker } from '../support/worker.js';
import { complete, propose, respond, sequence } from '../support/decisions.js';
import { PARTICIPANT, drain, input, testScheduler } from '../support/temporal.js';
import { ensureTestLedger, handlerCalls, SET_TEST_RECORD_ID } from '../fixtures/capabilities/test-ledger.js';

let db: TestDatabase;
let platform: Platform;
const workers: TestWorker[] = [];

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  platform = await startActionPlatform(db.url);
  await ensureTestLedger(platform.pool);
});
afterEach(async () => {
  for (const w of workers.splice(0)) await w.platform.close();
  await platform?.close();
  await db?.drop();
});

async function worker(options: Omit<Parameters<typeof startTestWorker>[1], 'workerId'>): Promise<TestWorker> {
  const w = await startTestWorker(db.url, { workerId: `pinned-worker-${workers.length}`, ...options });
  workers.push(w);
  return w;
}
async function stop(w: TestWorker): Promise<void> {
  await w.platform.close();
  workers.splice(workers.indexOf(w), 1);
}

/** The task's own pin, and a definition of the same agent that is not it (the "other profile"). */
async function pins(taskId: string): Promise<{ own: ServedAgents; other: ServedAgents }> {
  const { task } = await platform.tasks.getTask(taskId);
  return { own: [{ agentId: task.agentId, version: task.agentVersion }], other: [{ agentId: task.agentId, version: task.agentVersion + 1 }] };
}
const runsOf = async (taskId: string) => (await platform.tasks.getTask(taskId)).runs;

describe('task selection', () => {
  it('an incompatible worker never claims the task; it stays pending and a compatible worker runs it', async () => {
    const taskId = await createActionTask(platform);
    const { own, other } = await pins(taskId);

    const incompatible = await worker({ servedAgents: other, script: sequence([]) });
    expect(await incompatible.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    expect(await incompatible.platform.execution.claimNext({ workerId: 'direct', leaseDurationMs: 30_000, served: other })).toBeNull();
    expect(incompatible.provider.callCount).toBe(0);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('pending');
    expect(await runsOf(taskId)).toEqual([]);

    const compatible = await worker({ servedAgents: own, script: sequence([complete('done')]) });
    expect(await compatible.platform.worker.runOnce()).toMatchObject({ kind: 'executed', taskId, claim: 'started' });
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
  });

  it('an empty served list claims nothing; an unprofiled worker (no list) keeps claiming any task', async () => {
    const taskId = await createActionTask(platform);
    const none = await worker({ servedAgents: [], script: sequence([]) });
    expect(await none.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    const unprofiled = await worker({ script: sequence([complete('done')]) });
    expect(await unprofiled.platform.worker.runOnce()).toMatchObject({ kind: 'executed', taskId });
  });
});

describe('rollback, suspension and worker restart', () => {
  it('a suspended task pinned to the rolled-back profile waits durably with its input, then resumes on a compatible worker', async () => {
    const taskId = await createActionTask(platform);
    const { own, other } = await pins(taskId);

    const before = await worker({ servedAgents: own, script: sequence([respond('Which value should I set?')]) });
    await before.platform.worker.runOnce();
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('waiting');
    await stop(before); // rollback: the profile that created the task is gone

    const after = await worker({ servedAgents: other, script: sequence([]) });
    await platform.temporal.submitInput(taskId, input('in-1'), PARTICIPANT, 'input-1');
    for (let i = 0; i < 3; i += 1) expect(await after.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    expect(after.provider.callCount).toBe(0);
    const held = await platform.tasks.getTask(taskId);
    expect(['pending', 'running']).toContain(held.task.status); // runnable, not terminal, not downgraded
    expect(held.runs.map((r) => r.status)).toEqual(['suspended']); // no run under the other profile
    await stop(after);

    const restarted = await worker({ servedAgents: own, script: sequence([complete('continued')]) });
    expect(await restarted.platform.worker.runOnce()).toMatchObject({ kind: 'executed', taskId, claim: 'started' });
    const done = await platform.tasks.getTask(taskId);
    expect(done.task.status).toBe('completed');
    const versions = await platform.pool.query<{ agent_version: number }>('select agent_version from agent_runs where task_id = $1', [taskId]);
    expect(versions.rows.map((r) => r.agent_version)).toEqual([own[0]!.version, own[0]!.version]);
  });
});

describe('recovery', () => {
  it('an expired lease is taken over only by a compatible worker (same run resumed)', async () => {
    const taskId = await createActionTask(platform);
    const { own, other } = await pins(taskId);
    const w = await worker({ servedAgents: own, script: sequence([]) });
    const first = await w.platform.execution.claimNext({ workerId: 'crashed', leaseDurationMs: 30_000, served: own });
    expect(first?.kind).toBe('started');
    await expireLease(platform.pool, taskId);

    expect(await w.platform.execution.claimNext({ workerId: 'incompatible', leaseDurationMs: 30_000, served: other })).toBeNull();
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_owner: 'crashed' });

    const second = await w.platform.execution.claimNext({ workerId: 'compatible', leaseDurationMs: 30_000, served: own });
    expect(second).toMatchObject({ kind: 'resumed', takeover: true, previousOwner: 'crashed', run: { runId: first?.kind === 'started' ? first.run.runId : '' } });
  });

  it('reconciliation of an uncertain effect is claimed only by a compatible worker', async () => {
    const taskId = await createActionTask(platform);
    const { own, other } = await pins(taskId);
    const lost = await worker({
      servedAgents: own,
      capabilities: actionCapabilities(platform.pool, { maxAttempts: 1, calls: handlerCalls(), faults: { afterEffect: () => 'unknown', reconcile: () => 'unknown' } }),
      policy: WRITES,
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'pinned', value: 'one' })]),
    });
    await lost.platform.worker.runOnce();
    await stop(lost);
    const { scheduler } = testScheduler(platform.pool);
    expect(await drain(scheduler)).toBe(1);

    const calls = handlerCalls();
    const incompatible = await worker({ servedAgents: other, capabilities: actionCapabilities(platform.pool, { calls }), policy: WRITES, script: sequence([]) });
    expect(await incompatible.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    expect(calls).toMatchObject({ execute: 0, reconcile: 0 });
    expect((await platform.temporal.inspect(taskId)).schedules.find((s) => s.kind === 'reconciliation')).toMatchObject({ status: 'dispatched' });
    await stop(incompatible);

    const compatible = await worker({ servedAgents: own, capabilities: actionCapabilities(platform.pool, { calls }), policy: WRITES, script: sequence([]) });
    expect(await compatible.platform.worker.runOnce()).toMatchObject({ kind: 'reconciled', outcome: 'resolved' });
    expect((await ledgerOf(platform.pool, taskId)).executions.map((e) => e.status)).toEqual(['succeeded']);
  });
});
