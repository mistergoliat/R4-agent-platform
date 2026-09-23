import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Platform } from '@r4/api';
import { SET_TEST_RECORD_ID, ensureTestLedger, handlerCalls, testRecord } from '../fixtures/capabilities/test-ledger.js';
import { WRITES, actionCapabilities, createActionTask, ledgerOf, startActionPlatform } from '../support/actions.js';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { complete, contextOf, propose, sequence } from '../support/decisions.js';
import { startTestWorker, waitFor, type TestWorker } from '../support/worker.js';
import { PARTICIPANT, input, manageGoal, setTemporalOffset, waitInput, waitUntil } from '../support/temporal.js';

/**
 * R4-E process-level recovery (real OS processes, built dist code):
 *
 *   1. a scheduler process claims a due schedule and is SIGKILLed before
 *      firing → its lease expires on the temporal clock → the real scheduler
 *      process (`apps/scheduler/dist/main.js`) reclaims with a higher
 *      generation → exactly one effective wake;
 *   2. an uncertain effect's reconciliation is dispatched by the scheduler
 *      process, picked up by a worker process that is SIGKILLed mid-reconcile
 *      → another worker reclaims the work → same execution key → receipt +
 *      observation → the task wakes and completes;
 *   3. a waiting task survives worker AND API restarts, and is woken by input
 *      submitted to the restarted API — root goal and focus intact.
 *
 * Requires `npm run build`.
 */
const SCHEDULER_MAIN = fileURLToPath(new URL('../../apps/scheduler/dist/main.js', import.meta.url));
const CLAIM_AND_DIE = fileURLToPath(new URL('./fixtures/claim-and-die-scheduler.mjs', import.meta.url));
const RECONCILING_WORKER = fileURLToPath(new URL('./fixtures/reconciling-worker.mjs', import.meta.url));

let db: TestDatabase;
let platform: Platform;
const children: ChildProcess[] = [];
const workers: TestWorker[] = [];

beforeAll(() => {
  for (const path of [SCHEDULER_MAIN, fileURLToPath(new URL('../../apps/worker/dist/index.js', import.meta.url))]) {
    if (!existsSync(path)) throw new Error(`${path} is missing: run "npm run build" before "npm run test:recovery"`);
  }
});
beforeEach(async () => {
  db = await createMigratedTestDatabase();
  platform = await startActionPlatform(db.url);
  await ensureTestLedger(platform.pool);
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const w of workers.splice(0)) await w.platform.close();
  await platform?.close();
  await db?.drop();
});

interface Child {
  readonly process: ChildProcess;
  readonly lines: Record<string, unknown>[];
  readonly stderr: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(script: string, env: Record<string, string>): Child {
  const child = spawn(process.execPath, [script], { env: { ...process.env, R4_DATABASE_URL: db.url, R4_LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const lines: Record<string, unknown>[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('{')) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { process: child, lines, stderr: () => stderr, exited };
}

const SCHEDULER_ENV = {
  R4_SCHEDULER_LEASE_MS: '2000',
  R4_SCHEDULER_POLL_MS: '25',
  R4_RECONCILIATION_MAX_ATTEMPTS: '3',
  R4_RECONCILIATION_INITIAL_BACKOFF_MS: '0',
  R4_RECONCILIATION_MAX_BACKOFF_MS: '0',
  R4_RECONCILIATION_DEADLINE_MS: '86400000',
};

async function worker(options: Omit<Parameters<typeof startTestWorker>[1], 'workerId'>): Promise<TestWorker> {
  const w = await startTestWorker(db.url, { workerId: `recovery-worker-${workers.length}`, ...options });
  workers.push(w);
  return w;
}
const events = async (taskId: string, type: string) => (await platform.temporal.inspect(taskId)).events.filter((e) => e.type === type);

describe('scheduler process crash', () => {
  it('SIGKILL after claiming → lease expires → the real scheduler process reclaims → one effective wake', async () => {
    const taskId = await createActionTask(platform);
    await (await worker({ script: sequence([waitUntil('2020-01-01T00:00:00.000Z')]) })).platform.worker.runOnce();

    const dying = start(CLAIM_AND_DIE, { ...SCHEDULER_ENV, R4_SCHEDULER_ID: 'scheduler-a' });
    const claimed = await waitFor(() => dying.lines.find((l) => l.event === 'child.schedule.claimed'), 30_000, 25).catch((error: unknown) => {
      throw new Error(`scheduler A never claimed; stderr: ${dying.stderr().slice(0, 2000)}`, { cause: error });
    });
    dying.process.kill('SIGKILL');
    expect((await dying.exited).signal).toBe('SIGKILL');
    // Claimed, never fired: the task is still waiting.
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('waiting');
    expect(await events(taskId, 'task.woken')).toHaveLength(0);

    await setTemporalOffset(platform.pool, 10_000); // A's lease (2 s) expires on the temporal clock
    const replacement = start(SCHEDULER_MAIN, { ...SCHEDULER_ENV, R4_SCHEDULER_ID: 'scheduler-b' });
    await waitFor(async () => (await platform.tasks.getTask(taskId)).task.status === 'running', 30_000, 50).catch((error: unknown) => {
      throw new Error(`scheduler B never fired; stderr: ${replacement.stderr().slice(0, 2000)}`, { cause: error });
    });
    const schedule = (await platform.temporal.inspect(taskId)).schedules[0]!;
    expect(schedule).toMatchObject({ status: 'fired', generation: (claimed.generation as number) + 1 });
    expect(await events(taskId, 'task.woken')).toHaveLength(1);
    expect((await events(taskId, 'schedule.fired'))[0]!.actorRef).toBe('scheduler-b');

    // A runnable process; on POSIX its SIGTERM handler shuts it down cleanly (Windows has no
    // catchable SIGTERM: kill() terminates the process, which the durable lease already tolerates).
    expect(replacement.lines.some((l) => l.event === 'service.started')).toBe(true);
    replacement.process.kill('SIGTERM');
    const exit = await replacement.exited;
    if (process.platform === 'win32') expect(exit.signal).toBe('SIGTERM');
    else expect(exit.code).toBe(0);
  });

  it('refuses to start without an explicit reconciliation policy', async () => {
    const child = start(SCHEDULER_MAIN, { R4_SCHEDULER_ID: 'scheduler-unconfigured' });
    const { code } = await child.exited;
    expect(code).toBe(1);
    expect(child.stderr()).toContain('R4_RECONCILIATION_MAX_ATTEMPTS');
  });
});

describe('reconciliation process recovery', () => {
  it('uncertain effect → scheduler process dispatches → reconciling worker process SIGKILLed → another worker reconciles with the same key → task resumes', async () => {
    const taskId = await createActionTask(platform, { input: { recordKey: 'process-reconcile', value: 'one' } });
    const lost = actionCapabilities(platform.pool, { maxAttempts: 1, faults: { afterEffect: () => 'unknown', reconcile: () => 'unknown' } });
    const first = await worker({ capabilities: lost, policy: WRITES, script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'process-reconcile', value: 'one' })]) });
    await first.platform.worker.runOnce();
    await first.platform.close();
    workers.splice(0);
    const execution = (await ledgerOf(platform.pool, taskId)).executions[0]!;
    expect(execution.status).toBe('needs_reconciliation');

    const scheduler = start(SCHEDULER_MAIN, { ...SCHEDULER_ENV, R4_SCHEDULER_ID: 'scheduler-r' });
    await waitFor(async () => (await platform.temporal.inspect(taskId)).schedules.find((s) => s.kind === 'reconciliation')?.status === 'dispatched', 30_000, 50).catch((error: unknown) => {
      throw new Error(`scheduler never dispatched; stderr: ${scheduler.stderr().slice(0, 2000)}`, { cause: error });
    });

    const reconciler = start(RECONCILING_WORKER, { R4_WORKER_ID: 'reconciler-a', R4_WORKER_LEASE_MS: '1500', R4_WORKER_HEARTBEAT_MS: '250', R4_WORKER_POLL_MS: '50', R4_EXEC_MAX_WRITE_ACTIONS: '5' });
    const started = await waitFor(() => reconciler.lines.find((l) => l.event === 'child.reconcile.started'), 30_000, 25).catch((error: unknown) => {
      throw new Error(`reconciler never started; stderr: ${reconciler.stderr().slice(0, 2000)}`, { cause: error });
    });
    expect(started.executionKey).toBe(execution.executionKey);
    reconciler.process.kill('SIGKILL');
    expect((await reconciler.exited).signal).toBe('SIGKILL');
    expect(reconciler.lines.some((l) => l.event === 'child.model.called')).toBe(false);
    scheduler.process.kill('SIGTERM');
    await scheduler.exited;

    // The dead reconciler's attempt stays unknown; its lease expires on the temporal clock.
    let ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.attempts.at(-1)).toMatchObject({ kind: 'reconcile', outcome: null, workerId: 'reconciler-a' });
    expect(ledger.receipts).toEqual([]);
    await setTemporalOffset(platform.pool, 10_000);

    const calls = handlerCalls();
    const survivor = await worker({ capabilities: actionCapabilities(platform.pool, { calls }), policy: WRITES, script: sequence([(r) => complete('confirmed', contextOf(r).observations.map((o) => o.observationId))]) });
    expect(await survivor.platform.worker.runOnce()).toMatchObject({ kind: 'reconciled', outcome: 'resolved' });
    expect(calls).toMatchObject({ execute: 0, reconcile: 1 });
    ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.executions).toEqual([expect.objectContaining({ executionId: execution.executionId, executionKey: execution.executionKey, status: 'succeeded' })]);
    expect(ledger.receipts).toEqual([expect.objectContaining({ executionKey: execution.executionKey, status: 'succeeded' })]);
    expect(await testRecord(platform.pool, 'process-reconcile')).toMatchObject({ writeCount: 1 });
    await survivor.platform.worker.runOnce();
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
  });
});

describe('wait survival across process restarts', () => {
  it('a waiting task survives worker and API restarts and wakes on input submitted to the restarted API', async () => {
    const taskId = await createActionTask(platform);
    const root = (await platform.tasks.getTask(taskId)).task.rootGoalId;
    const first = await worker({
      script: sequence([manageGoal({ operation: 'create', parentGoalId: root, description: 'Wait for the missing value', successCriteria: [], makeCurrent: true }), waitInput('need a value')]),
    });
    await first.platform.worker.runOnce();
    const focus = (await platform.tasks.getTask(taskId)).task.currentGoalId;
    await first.platform.close();
    workers.splice(0);
    await platform.close(); // API process gone

    platform = await startActionPlatform(db.url); // API restarted: new pool, new runtimes
    expect((await platform.tasks.getTask(taskId)).task).toMatchObject({ status: 'waiting', rootGoalId: root, currentGoalId: focus });
    await platform.temporal.submitInput(taskId, input('after-restart', 'Value is 7.'), PARTICIPANT, 'after-restart');
    let seenGoals: unknown[] = [];
    const second = await worker({ script: sequence([(r) => ((seenGoals = r.context!.sections.goals.map((i) => i.content)), complete('done'))]) });
    await second.platform.worker.runOnce();
    expect(seenGoals).toEqual(expect.arrayContaining([expect.objectContaining({ goalId: root, isRoot: true }), expect.objectContaining({ goalId: focus, isCurrent: true })]));
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
  });
});
