import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Platform } from '@r4/api';
import type { ModelRequest } from '@r4/model-gateway';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { actionCapabilities, createActionTask, ledgerOf, startActionPlatform, WRITES } from '../support/actions.js';
import { expireLease, startTestWorker, type TestWorker } from '../support/worker.js';
import { complete, contextOf, propose, sequence } from '../support/decisions.js';
import { HUMAN, drain, setTemporalOffset, testScheduler, waitRows } from '../support/temporal.js';
import { ensureTestLedger, handlerCalls, SET_TEST_RECORD_ID, testRecord } from '../fixtures/capabilities/test-ledger.js';

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
  const w = await startTestWorker(db.url, { workerId: `reconcile-worker-${workers.length}`, ...options });
  workers.push(w);
  return w;
}
async function stop(w: TestWorker): Promise<void> {
  await w.platform.close();
  workers.splice(workers.indexOf(w), 1);
}
/** A write whose effect is applied but whose answer is lost, and which cannot be reconciled by this worker. */
const lostAnswer = (calls = handlerCalls()) => actionCapabilities(platform.pool, { maxAttempts: 1, calls, faults: { afterEffect: () => 'unknown', reconcile: () => 'unknown' } });
const reconcileSchedule = async (taskId: string) => (await platform.temporal.inspect(taskId)).schedules.find((s) => s.kind === 'reconciliation')!;
const events = async (taskId: string, type: string) => (await platform.temporal.inspect(taskId)).events.filter((e) => e.type === type);

async function uncertainTask(recordKey: string) {
  const taskId = await createActionTask(platform);
  const w = await worker({ capabilities: lostAnswer(), policy: WRITES, script: sequence([propose(SET_TEST_RECORD_ID, { recordKey, value: 'one' })]) });
  await w.platform.worker.runOnce();
  return { taskId, w };
}

describe('reconciliation work is born with the uncertainty', () => {
  it('unknown attempt outcome → durable work in the same transaction; no cognition while ambiguous', async () => {
    const { taskId, w } = await uncertainTask('born');
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.executions.map((e) => e.status)).toEqual(['needs_reconciliation']);
    const schedule = await reconcileSchedule(taskId);
    expect(schedule).toMatchObject({ kind: 'reconciliation', referenceId: ledger.executions[0]!.executionId, status: 'pending', policy: null });
    expect((await platform.tasks.getTask(taskId)).task).toMatchObject({ status: 'blocked', statusReason: 'write_outcome_uncertain' });
    expect(await waitRows(platform.pool, taskId)).toEqual([{ kind: 'WAIT_FOR_RECONCILIATION', status: 'waiting', resolution: null }]);
    expect((await platform.temporal.inspect(taskId)).ownership).toMatchObject({ owner: 'agent', blockedBy: ['uncertain_action'] });
    // Nothing may run the model now: no claim, no call.
    expect(await w.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    expect(w.provider.callCount).toBe(1);
    expect(await w.platform.execution.claimNext({ workerId: 'eager', leaseDurationMs: 60_000 })).toBeNull();
    // "needs_reconciliation without durable work" is unrepresentable (deferred constraint).
    await expect(platform.pool.query("delete from schedules where kind = 'reconciliation'")).resolves.toBeTruthy();
    await expect(platform.pool.query("update action_executions set version = version + 1 where status = 'needs_reconciliation'")).rejects.toMatchObject({ message: expect.stringMatching(/no reconciliation work/) });
  });

  it('end to end after a worker restart: scheduler dispatches, a worker reconciles with the SAME executionKey, receipt + observation, task resumes', async () => {
    const { taskId, w } = await uncertainTask('restart');
    const original = (await ledgerOf(platform.pool, taskId)).executions[0]!;
    await stop(w); // the process that saw the uncertainty is gone

    const { scheduler } = testScheduler(platform.pool);
    expect(await drain(scheduler)).toBe(1);
    expect(await reconcileSchedule(taskId)).toMatchObject({ status: 'dispatched', policy: { maxAttempts: 3 } });

    const calls = handlerCalls();
    const seen: ModelRequest[] = [];
    const fresh = await worker({ capabilities: actionCapabilities(platform.pool, { calls }), policy: WRITES, script: sequence([(r) => (seen.push(r), complete('confirmed from receipt', contextOf(r).observations.map((o) => o.observationId)))]) });
    expect(await fresh.platform.worker.runOnce()).toMatchObject({ kind: 'reconciled', outcome: 'resolved', executionId: original.executionId });
    expect(fresh.provider.callCount).toBe(0); // reconciliation is not cognition
    expect(calls).toMatchObject({ execute: 0, reconcile: 1 });
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.executions.map((e) => [e.executionId, e.executionKey, e.status])).toEqual([[original.executionId, original.executionKey, 'succeeded']]);
    // D already tried one in-run reconcile (unknown) before declaring the outcome uncertain; E's is the next one.
    expect(ledger.attempts.map((a) => [a.attemptNumber, a.kind, a.outcome])).toEqual([[1, 'execute', 'unknown'], [2, 'reconcile', 'unknown'], [3, 'reconcile', 'applied']]);
    expect(ledger.receipts).toEqual([expect.objectContaining({ executionKey: original.executionKey, status: 'succeeded', evidence: expect.objectContaining({ obtainedVia: 'reconcile' }) })]);
    expect(await testRecord(platform.pool, 'restart')).toMatchObject({ writeCount: 1 });
    expect(await reconcileSchedule(taskId)).toMatchObject({ status: 'completed', attempts: 1 });
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('running');

    await fresh.platform.worker.runOnce();
    expect(contextOf(seen[0]!).observations.map((o) => o.outcome)).toEqual(['succeeded']);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
    expect(await events(taskId, 'reconciliation.resolved')).toHaveLength(1);
  });
});

describe('durable backoff, exhaustion and the operator seam', () => {
  it('reschedules unknown reconciliations on the durable policy, exhausts without guessing, and resumes only after an operator re-arms it', async () => {
    const { taskId } = await uncertainTask('backoff');
    const policy = { maxAttempts: 2, initialBackoffMs: 60_000, maxBackoffMs: 120_000, deadlineMs: 86_400_000 };
    const { scheduler } = testScheduler(platform.pool, { policy });
    const stubborn = await worker({ capabilities: lostAnswer(), policy: WRITES, script: sequence([]) });

    expect(await drain(scheduler)).toBe(1);
    expect(await stubborn.platform.worker.runOnce()).toMatchObject({ kind: 'reconciled', outcome: 'rescheduled' });
    const first = await reconcileSchedule(taskId);
    expect(first).toMatchObject({ status: 'pending', attempts: 1 });
    expect(Date.parse(first.dueAt) - Date.parse(first.updatedAt)).toBe(60_000);
    expect(await drain(scheduler)).toBe(0); // not due: backoff is durable, no worker sleeps on it
    await setTemporalOffset(platform.pool, 61_000);
    expect(await drain(scheduler)).toBe(1);
    expect(await stubborn.platform.worker.runOnce()).toMatchObject({ kind: 'reconciled', outcome: 'exhausted' });
    expect(await reconcileSchedule(taskId)).toMatchObject({ status: 'exhausted', attempts: 2 });
    expect((await ledgerOf(platform.pool, taskId)).executions[0]!.status).toBe('needs_reconciliation'); // never guessed
    expect((await platform.temporal.attention()).exhaustedReconciliations.map((s) => s.taskId)).toEqual([taskId]);
    expect(stubborn.provider.callCount).toBe(0);
    await setTemporalOffset(platform.pool, 10 * 86_400_000);
    expect(await drain(scheduler)).toBe(0); // exhausted work never fires on its own

    const executionId = (await ledgerOf(platform.pool, taskId)).executions[0]!.executionId;
    await expect(platform.temporal.rescheduleReconciliation(executionId, { responseKey: 'r1' }, { ...HUMAN, scopes: ['task.cancel'] })).rejects.toMatchObject({ code: 'human_scope_denied' });
    const rearmed = await platform.temporal.rescheduleReconciliation(executionId, { responseKey: 'r1' }, HUMAN);
    expect(rearmed).toMatchObject({ status: 'pending', attempts: 0, policy });
    expect(await platform.temporal.rescheduleReconciliation(executionId, { responseKey: 'r1' }, HUMAN)).toMatchObject({ status: 'pending' }); // idempotent
    await expect(platform.temporal.rescheduleReconciliation(executionId, { responseKey: 'r2' }, HUMAN)).rejects.toMatchObject({ code: 'reconciliation_not_exhausted' });
    expect(await drain(scheduler)).toBe(1);
    const healthy = await worker({ capabilities: actionCapabilities(platform.pool), policy: WRITES, script: sequence([complete('resumed')]) });
    expect(await healthy.platform.worker.runOnce()).toMatchObject({ kind: 'reconciled', outcome: 'resolved' });
    await healthy.platform.worker.runOnce();
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
    const attempts = (await ledgerOf(platform.pool, taskId)).attempts;
    expect(attempts.map((a) => a.kind)).toEqual(['execute', 'reconcile', 'reconcile', 'reconcile', 'reconcile']);
    expect(new Set(attempts.map((a) => a.executionId)).size).toBe(1);
  });
});

describe('uncertainty from every exit path', () => {
  it('cancellation during an uncertain action defers the terminal status until the receipt exists', async () => {
    const { taskId } = await uncertainTask('cancel-uncertain');
    expect((await platform.temporal.cancelTask(taskId, HUMAN)).status).toBe('blocked');
    expect((await platform.temporal.inspect(taskId)).ownership.terminalIntent).toBe('cancelled');
    await drain(testScheduler(platform.pool).scheduler);
    const healthy = await worker({ capabilities: actionCapabilities(platform.pool), policy: WRITES, script: sequence([]) });
    expect(await healthy.platform.worker.runOnce()).toMatchObject({ kind: 'reconciled', outcome: 'resolved' });
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('cancelled');
    expect((await ledgerOf(platform.pool, taskId)).receipts[0]?.status).toBe('succeeded');
    expect(await events(taskId, 'task.woken')).toHaveLength(0);
    expect(healthy.provider.callCount).toBe(0);
  });

  it('(R4-I) a platform cancellation during an uncertain action is deferred exactly like a human one', async () => {
    const { taskId } = await uncertainTask('platform-cancel-uncertain');
    const cancellation = { note: 'retire conversation', actorRef: 'platform:production-control', correlationId: 'production-control:test' };
    expect(await platform.temporal.cancelTaskByPlatform(taskId, cancellation)).toMatchObject({ task: { status: 'blocked' }, alreadyTerminal: false });
    expect((await platform.temporal.inspect(taskId)).ownership.terminalIntent).toBe('cancelled');
    expect((await platform.pool.query('select actor_kind, actor_ref from task_terminal_intents where task_id = $1', [taskId])).rows).toEqual([{ actor_kind: 'system', actor_ref: 'platform:production-control' }]);
    await drain(testScheduler(platform.pool).scheduler);
    const healthy = await worker({ capabilities: actionCapabilities(platform.pool), policy: WRITES, script: sequence([]) });
    expect(await healthy.platform.worker.runOnce()).toMatchObject({ kind: 'reconciled', outcome: 'resolved' });
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('cancelled');
    expect(healthy.provider.callCount).toBe(0);
  });

  it('a run abandoned mid-call (recovery limit): flagged with its work in the same transaction; failure applies only after reconciliation', async () => {
    const taskId = await createActionTask(platform);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    const hanging = actionCapabilities(platform.pool, { timeoutMs: 20_000, faults: { afterEffect: async () => { reached(); await released; return 'answer' as const; } } });
    const dying = await worker({ capabilities: hanging, policy: WRITES, maxRunRecoveries: 0, script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'abandoned', value: 'one' })]) });
    const outcome = dying.platform.worker.runOnce();
    await arrived; // the effect is applied; the answer has not come back
    await expireLease(platform.pool, taskId);
    const other = await worker({ capabilities: actionCapabilities(platform.pool), policy: WRITES, maxRunRecoveries: 0, script: sequence([]) });
    expect(await other.platform.worker.runOnce()).toMatchObject({ kind: 'abandoned' });
    release();
    await outcome; // the late answer is refused (fenced)

    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.executions.map((e) => e.status)).toEqual(['needs_reconciliation']);
    expect(ledger.receipts).toEqual([]);
    expect(await reconcileSchedule(taskId)).toMatchObject({ status: 'pending' });
    expect((await platform.tasks.getTask(taskId)).task).toMatchObject({ status: 'blocked', statusReason: 'awaiting_reconciliation' });
    expect((await platform.temporal.inspect(taskId)).ownership.terminalIntent).toBe('failed');

    await drain(testScheduler(platform.pool).scheduler);
    expect(await other.platform.worker.runOnce()).toMatchObject({ kind: 'reconciled', outcome: 'resolved' });
    expect((await platform.tasks.getTask(taskId)).task).toMatchObject({ status: 'failed', statusReason: 'lease_lost' });
    expect((await ledgerOf(platform.pool, taskId)).receipts.map((r) => r.status)).toEqual(['succeeded']);
    expect(await testRecord(platform.pool, 'abandoned')).toMatchObject({ writeCount: 1 });
  });

  it('operator takeover during uncertainty: release before the receipt keeps the task blocked; the receipt then resumes it', async () => {
    const { taskId } = await uncertainTask('handoff-uncertain');
    const request = await platform.temporal.takeOver(taskId, { responseKey: 'manual', note: 'Checking the external system by hand.' }, HUMAN);
    expect((await platform.temporal.inspect(taskId)).ownership).toMatchObject({ owner: 'human', blockedBy: ['human_handoff', 'uncertain_action'] });
    await platform.temporal.respondHuman(request.requestId, { responseKey: 'rel', outcome: 'release', content: 'Could not confirm; leaving it to reconciliation.' }, HUMAN);
    // Released, but the effect is still unknown: no autonomous work yet.
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('blocked');
    expect((await platform.temporal.inspect(taskId)).ownership).toMatchObject({ owner: 'agent', blockedBy: ['uncertain_action'] });
    await drain(testScheduler(platform.pool).scheduler);
    const healthy = await worker({ capabilities: actionCapabilities(platform.pool), policy: WRITES, script: sequence([complete('resumed after both')]) });
    expect(await healthy.platform.worker.runOnce()).toMatchObject({ kind: 'reconciled', outcome: 'resolved' });
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('running');
    await healthy.platform.worker.runOnce();
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
  });

  it('a reconciling worker that dies is replaced; its late result is fenced by the schedule generation', async () => {
    const { taskId } = await uncertainTask('reconciler-dies');
    await drain(testScheduler(platform.pool).scheduler);
    const healthy = await worker({ capabilities: actionCapabilities(platform.pool), policy: WRITES, script: sequence([]) });
    // Claim the work and "die" before recording: the lease expires on the temporal clock.
    const claimed = await platform.pool.query("update schedules set status = 'in_progress', owner = 'dead-worker', generation = generation + 1, lease_expires_at = r4_now() + interval '1 second' where kind = 'reconciliation' returning generation");
    expect(claimed.rows).toHaveLength(1);
    await setTemporalOffset(platform.pool, 5_000);
    expect(await healthy.platform.worker.runOnce()).toMatchObject({ kind: 'reconciled', outcome: 'resolved' });
    expect((await reconcileSchedule(taskId)).generation).toBe((claimed.rows[0] as { generation: number }).generation + 1);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('running');
  });
});
