import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Platform } from '@r4/api';
import { SET_TEST_RECORD_ID, ensureTestLedger, handlerCalls, ledgerOperations, testRecord } from '../fixtures/capabilities/test-ledger.js';
import { WRITES, actionCapabilities, createActionTask, ledgerOf, startActionPlatform } from '../support/actions.js';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { complete, contextOf, sequence } from '../support/decisions.js';
import { leaseRow, observationsOf, startTestWorker, stepsOf, waitFor, type TestWorker } from '../support/worker.js';

/**
 * R4-D's central exit gate, with a real process crash:
 *
 *   worker A (own OS process) owns the task → its write handler commits the
 *   external effect → SIGKILL BEFORE any receipt → lease expires → worker B
 *   takes over → same execution key → idempotent replay → NO second effect →
 *   exactly one receipt → the agent continues with the observation.
 *
 * Requires the built packages (`npm run build`): the child runs dist code.
 */
const CHILD = fileURLToPath(new URL('./fixtures/crashing-write-worker.mjs', import.meta.url));
const WORKER_DIST = fileURLToPath(new URL('../../apps/worker/dist/index.js', import.meta.url));

let db: TestDatabase;
let platform: Platform;
let child: ChildProcess | null = null;
let workerB: TestWorker | null = null;
const childLines: Record<string, unknown>[] = [];

beforeAll(async () => {
  if (!existsSync(WORKER_DIST)) throw new Error('apps/worker/dist is missing: run "npm run build" before "npm run test:recovery"');
  db = await createMigratedTestDatabase();
  platform = await startActionPlatform(db.url);
  await ensureTestLedger(platform.pool);
});

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await workerB?.platform.close();
  await platform?.close();
  await db?.drop();
});

describe('governed write: worker process crash after the external effect (SIGKILL)', () => {
  it('effect committed → SIGKILL before receipt → takeover → same key replayed → one effect, one receipt, agent continues', async () => {
    const taskId = await createActionTask(platform, { correlationId: 'sigkill-write', input: { recordKey: 'sigkill', value: 'once' } });

    child = spawn(process.execPath, [CHILD], {
      env: {
        ...process.env,
        R4_DATABASE_URL: db.url,
        R4_WORKER_ID: 'process-a',
        R4_WORKER_LEASE_MS: '1500',
        R4_WORKER_HEARTBEAT_MS: '250',
        R4_WORKER_POLL_MS: '50',
        R4_EXEC_MAX_WRITE_ACTIONS: '5',
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
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child!.once('exit', (_code, signal) => resolve(signal)));

    // The external effect is committed and the process is alive and heartbeating, waiting for an answer.
    const committed = await waitFor(() => childLines.find((l) => l.event === 'child.effect.committed'), 30_000, 25).catch((error: unknown) => {
      throw new Error(`child never committed the effect; stderr: ${stderr.slice(0, 2000)}; last lines: ${JSON.stringify(childLines.slice(-5))}`, { cause: error });
    });
    await waitFor(() => childLines.some((l) => l.event === 'task.lease.renewed'), 10_000, 25);
    expect(await testRecord(platform.pool, 'sigkill')).toMatchObject({ value: 'once', version: 1, writeCount: 1 });

    child.kill('SIGKILL');
    expect(await exited).toBe('SIGKILL');

    // Killed after the effect and before any receipt: R4 knows an attempt started, nothing more.
    const beforeRecovery = await ledgerOf(platform.pool, taskId);
    expect(beforeRecovery.executions).toEqual([expect.objectContaining({ status: 'executing', executionKey: committed.executionKey })]);
    expect(beforeRecovery.attempts).toEqual([expect.objectContaining({ attemptNumber: 1, kind: 'execute', workerId: 'process-a', outcome: null })]);
    expect(beforeRecovery.receipts).toEqual([]);
    expect(await observationsOf(platform.pool, taskId)).toEqual([]);
    expect(await leaseRow(platform.pool, taskId)).toMatchObject({ lease_owner: 'process-a', lease_generation: 1 });
    const runId = (await platform.tasks.getTask(taskId)).runs[0]!.runId;
    expect((await platform.tasks.getRun(runId)).status).toBe('running');

    const calls = handlerCalls();
    workerB = await startTestWorker(db.url, {
      workerId: 'process-b',
      script: sequence([(request) => complete('record confirmed by receipt', contextOf(request).observations.map((o) => o.observationId))]),
      capabilities: actionCapabilities(platform.pool, { calls }),
      policy: WRITES,
    });
    const cycle = await waitFor(async () => {
      const c = await workerB!.platform.worker.runOnce();
      return c.kind === 'executed' ? c : null;
    }, 15_000, 50);
    expect(cycle).toMatchObject({ claim: 'resumed', takeover: true, runId, outcome: { kind: 'terminated', termination: { reason: 'completed' } } });

    // NO second side effect: the ledger applied exactly one operation, under the one platform key.
    expect(await testRecord(platform.pool, 'sigkill')).toMatchObject({ value: 'once', version: 1, writeCount: 1 });
    expect((await ledgerOperations(platform.pool)).filter((o) => o.recordKey === 'sigkill')).toEqual([{ executionKey: committed.executionKey, recordKey: 'sigkill', outcome: 'applied' }]);
    expect(calls.keys).toEqual([committed.executionKey]);

    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.executions).toEqual([expect.objectContaining({ status: 'succeeded', executionKey: committed.executionKey })]);
    expect(ledger.attempts.map((a) => [a.attemptNumber, a.kind, a.workerId, a.leaseGeneration, a.outcome])).toEqual([
      [1, 'execute', 'process-a', 1, null],
      [2, 'replay', 'process-b', 2, 'applied'],
    ]);
    // Exactly one receipt, reconstructed from the domain's answer to the same key.
    expect(ledger.receipts).toHaveLength(1);
    expect(ledger.receipts[0]).toMatchObject({
      status: 'succeeded',
      executionKey: committed.executionKey,
      result: { recordKey: 'sigkill', version: 1, value: 'once' },
      evidence: { obtainedVia: 'replay', attemptNumber: 2, attempts: 2, replayed: true },
    });

    // The agent continued: B's only model call saw the receipt-backed observation.
    const observations = await observationsOf(platform.pool, taskId);
    expect(observations).toEqual([expect.objectContaining({ outcome: 'succeeded', source: expect.objectContaining({ kind: 'action', receiptId: ledger.receipts[0]!.receiptId }) })]);
    expect(workerB.provider.callCount).toBe(1);
    expect(contextOf(workerB.provider.requests[0]!).observations.map((o) => o.observationId)).toEqual([observations[0]!.observationId]);
    expect((await stepsOf(platform.pool, runId)).map((s) => [s.iteration, s.decision?.type, s.outcome, s.leaseGeneration])).toEqual([
      [1, 'propose_action', 'observed', 1],
      [2, 'complete', 'recorded', 2],
    ]);
    expect(await platform.tasks.getRun(runId)).toMatchObject({ status: 'completed', recoveries: 1, result: { evidence: [observations[0]!.observationId] } });
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');

    // The killed process emitted the governed-execution telemetry up to the external call.
    const events = new Set(childLines.map((l) => l.event));
    for (const name of ['action.proposed', 'policy.evaluated', 'action.command.created', 'action.execution.started']) expect(events.has(name), name).toBe(true);
    expect(events.has('action.receipt.persisted')).toBe(false);
    expect(childLines.find((l) => l.event === 'action.execution.started')).toMatchObject({ taskId, workerId: 'process-a', capabilityId: SET_TEST_RECORD_ID, attempt: 1 });
  });
});
