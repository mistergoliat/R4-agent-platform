import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PlatformError, systemClock, uuidV7Generator, type ActionAttemptReport, type LeaseToken } from '@r4/contracts';
import { AgentKernel, type KernelOutcome } from '@r4/agent-kernel';
import { AgentRegistry } from '@r4/agent-registry';
import type { CapabilityRegistry } from '@r4/capability-runtime';
import { DefaultModelGateway, FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresActionLedgerStore, PostgresAgentDefinitionStore, PostgresExecutionStore, PostgresObservationStore, type Pool } from '@r4/persistence-postgres';
import { ActionPolicyEngine, DEFAULT_ACTION_POLICY } from '@r4/policy-engine';
import { ActionRuntime, ExecutionRuntime, type ActionAttemptGrant, type ActionProgress, type AuthorizeActionCommand } from '@r4/task-runtime';
import { DurableKernelSession } from '@r4/worker';
import type { Platform } from '@r4/api';
import { SET_TEST_RECORD_ID, ensureTestLedger, handlerCalls, testRecord, type TestLedgerCapabilityOptions } from '../fixtures/capabilities/test-ledger.js';
import { WRITES, actionCapabilities, createActionTask, ledgerOf, startActionPlatform } from '../support/actions.js';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { complete, contextOf, propose, sequence } from '../support/decisions.js';
import { TEST_POLICY, expireLease, observationsOf, startTestWorker, stepsOf, waitFor, type TestWorker } from '../support/worker.js';

/**
 * R4-D crash windows, with deterministic in-process fault injection (the
 * process-level SIGKILL of the hardest window is tests/recovery). A "dying"
 * worker has its own pool, no heartbeat, and stops at the injected point by
 * losing its lease: from then on it can write nothing. The test expires the
 * lease on the database clock and a fresh worker takes over.
 *
 *   A  proposal durable → dies before policy
 *   B  ALLOW + command durable → dies before any attempt
 *   B' attempt row durable → dies before the external call
 *   C  external effect applied → dies before the receipt
 *   D  receipt + observation durable → dies before the next model call
 */

let db: TestDatabase;
let platform: Platform;
const cleanups: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  platform = await startActionPlatform(db.url);
  await ensureTestLedger(platform.pool);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
  await platform?.close();
  await db?.drop();
});

type FaultPoint = 'before_policy' | 'before_attempt' | 'after_attempt_recorded' | 'at_attempt_record';

/** An ActionRuntime whose worker "dies" (loses its lease: writes nothing more) at one point. */
class DyingActions extends ActionRuntime {
  #armed = true;
  readonly #point: FaultPoint;

  constructor(options: ConstructorParameters<typeof ActionRuntime>[0], point: FaultPoint) {
    super(options);
    this.#point = point;
  }

  #die(token: LeaseToken): never {
    this.#armed = false;
    throw new PlatformError('conflict', 'lease_lost', `injected death of ${token.owner}`);
  }

  override authorizeAction(token: LeaseToken, command: AuthorizeActionCommand): Promise<ActionProgress> {
    if (this.#armed && this.#point === 'before_policy') this.#die(token);
    return super.authorizeAction(token, command);
  }

  override advanceAction(token: LeaseToken, proposalId: string): Promise<ActionProgress | ActionAttemptGrant> {
    if (this.#armed && this.#point === 'before_attempt') this.#die(token);
    return super.advanceAction(token, proposalId);
  }

  override async recordAttempt(token: LeaseToken, proposalId: string, attemptId: string, report: ActionAttemptReport): Promise<ActionProgress> {
    // The external call already happened (or failed to): dying here loses its answer.
    if (this.#armed && this.#point === 'at_attempt_record') this.#die(token);
    const progress = await super.recordAttempt(token, proposalId, attemptId, report);
    if (this.#armed && this.#point === 'after_attempt_recorded') this.#die(token);
    return progress;
  }
}

async function dyingWorker(options: { script: FakeModelScript; capabilities: CapabilityRegistry; point?: FaultPoint; workerId?: string }) {
  const pool: Pool = openPool(db.url);
  const logger = createSilentLogger();
  const ids = uuidV7Generator();
  const store = new PostgresExecutionStore(pool);
  const execution = new ExecutionRuntime({ store, ids, clock: systemClock, logger, maxRunRecoveries: 3 });
  const actionOptions = { store, authorizer: new ActionPolicyEngine(DEFAULT_ACTION_POLICY), ids, clock: systemClock, logger };
  const actions = options.point ? new DyingActions(actionOptions, options.point) : new ActionRuntime(actionOptions);
  const workerId = options.workerId ?? 'worker-a';
  const claim = await execution.claimNext({ workerId, leaseDurationMs: 60_000 });
  if (!claim || claim.kind === 'abandoned') throw new Error('dying worker could not claim');
  const provider = new FakeModelProvider(options.script);
  const kernel = new AgentKernel({ gateway: new DefaultModelGateway({ provider, logger }), logger });
  const session = new DurableKernelSession({
    lease: claim.lease,
    execution,
    agents: new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger }),
    capabilities: options.capabilities,
    observations: new PostgresObservationStore(pool),
    policy: { ...TEST_POLICY, ...WRITES },
    actions,
    ids,
    clock: systemClock,
    logger,
  });
  const outcome: Promise<KernelOutcome> = kernel.run(session, { workerId });
  cleanups.push(async () => {
    await outcome;
    await pool.end();
  });
  return { claim, provider, outcome, execution };
}

async function worker(options: Omit<Parameters<typeof startTestWorker>[1], 'workerId'> & { workerId?: string }): Promise<TestWorker> {
  const started = await startTestWorker(db.url, { workerId: options.workerId ?? 'worker-b', policy: WRITES, ...options });
  cleanups.push(() => started.platform.close());
  return started;
}

async function takeOver(w: TestWorker) {
  return waitFor(async () => {
    const cycle = await w.platform.worker.runOnce();
    return cycle.kind === 'executed' ? cycle : null;
  }, 15_000, 25);
}

const completeCiting = (summary: string) => (request: Parameters<Extract<FakeModelScript, (...args: never[]) => unknown>>[0]) =>
  complete(summary, contextOf(request).observations.map((o) => o.observationId));

function capabilities(options: TestLedgerCapabilityOptions = {}) {
  return actionCapabilities(platform.pool, options);
}

describe('crash windows', () => {
  it('A: proposal durable, death before policy → the next owner evaluates policy and executes once (no model call for it)', async () => {
    const taskId = await createActionTask(platform);
    const calls = handlerCalls();
    const a = await dyingWorker({ script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'window-a', value: 'x' })]), capabilities: capabilities({ calls }), point: 'before_policy' });
    expect(await a.outcome).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
    let ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.proposals).toHaveLength(1);
    expect(ledger.decisions).toEqual([]);

    await expireLease(platform.pool, taskId);
    const b = await worker({ script: sequence([completeCiting('recovered A')]), capabilities: capabilities({ calls }) });
    const cycle = await takeOver(b);
    expect(cycle).toMatchObject({ claim: 'resumed', takeover: true, outcome: { termination: { reason: 'completed' } } });
    ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.decisions).toEqual([expect.objectContaining({ outcome: 'allow', leaseGeneration: 2 })]);
    expect(ledger.receipts).toHaveLength(1);
    expect(calls.execute).toBe(1);
    expect(await testRecord(platform.pool, 'window-a')).toMatchObject({ writeCount: 1 });
    // B's only model call came after the outcome: the pending proposal was resolved without asking the model.
    expect(b.provider.callCount).toBe(1);
    expect(contextOf(b.provider.requests[0]!).observations).toHaveLength(1);
  });

  it('B: ALLOW + command durable, death before any attempt → same command, same execution key', async () => {
    const taskId = await createActionTask(platform);
    const calls = handlerCalls();
    const a = await dyingWorker({ script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'window-b', value: 'x' })]), capabilities: capabilities({ calls }), point: 'before_attempt' });
    expect(await a.outcome).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
    const before = await ledgerOf(platform.pool, taskId);
    expect(before.executions).toEqual([expect.objectContaining({ status: 'prepared' })]);
    expect(before.attempts).toEqual([]);

    await expireLease(platform.pool, taskId);
    const b = await worker({ script: sequence([completeCiting('recovered B')]), capabilities: capabilities({ calls }) });
    await takeOver(b);
    const after = await ledgerOf(platform.pool, taskId);
    expect(after.executions).toEqual([expect.objectContaining({ executionId: before.executions[0]!.executionId, executionKey: before.executions[0]!.executionKey, status: 'succeeded' })]);
    expect(after.attempts).toEqual([expect.objectContaining({ attemptNumber: 1, kind: 'execute', workerId: 'worker-b', outcome: 'applied' })]);
    expect(calls.keys).toEqual([before.executions[0]!.executionKey]);
    expect(await testRecord(platform.pool, 'window-b')).toMatchObject({ writeCount: 1 });
  });

  it("B': attempt row durable, death before the external call → replay with the same key; one effect", async () => {
    const taskId = await createActionTask(platform);
    const calls = handlerCalls();
    const a = await dyingWorker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'window-b2', value: 'x' })]),
      // The call never reaches the ledger; the worker dies before it can record anything.
      capabilities: capabilities({ calls, faults: { beforeEffect: () => { throw new Error('process stopping'); } } }),
      point: 'at_attempt_record',
    });
    expect(await a.outcome).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
    expect(await testRecord(platform.pool, 'window-b2')).toBeNull();
    expect((await ledgerOf(platform.pool, taskId)).attempts).toEqual([expect.objectContaining({ attemptNumber: 1, outcome: null, finishedAt: null })]);

    await expireLease(platform.pool, taskId);
    const b = await worker({ script: sequence([completeCiting('recovered B2')]), capabilities: capabilities({ calls }) });
    await takeOver(b);
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.attempts.map((x) => [x.attemptNumber, x.kind, x.workerId, x.outcome])).toEqual([
      [1, 'execute', 'worker-a', null],
      [2, 'replay', 'worker-b', 'applied'],
    ]);
    expect(new Set(calls.keys)).toEqual(new Set([ledger.executions[0]!.executionKey]));
    expect(ledger.receipts).toEqual([expect.objectContaining({ status: 'succeeded', evidence: expect.objectContaining({ obtainedVia: 'replay', attemptNumber: 2, attempts: 2, replayed: false }) })]);
    expect(await testRecord(platform.pool, 'window-b2')).toMatchObject({ writeCount: 1 });
  });

  it('C: effect applied, death before the receipt → the next owner replays the same key: NO second effect, one receipt', async () => {
    const taskId = await createActionTask(platform);
    const calls = handlerCalls();
    const a = await dyingWorker({ script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'window-c', value: 'x' })]), capabilities: capabilities({ calls }), point: 'at_attempt_record' });
    expect(await a.outcome).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
    // The world changed; R4 has no receipt and must not pretend either way.
    expect(await testRecord(platform.pool, 'window-c')).toMatchObject({ writeCount: 1, version: 1 });
    const mid = await ledgerOf(platform.pool, taskId);
    expect(mid.receipts).toEqual([]);
    expect(mid.executions[0]!.status).toBe('executing');
    expect(await observationsOf(platform.pool, taskId)).toEqual([]);

    await expireLease(platform.pool, taskId);
    const b = await worker({ script: sequence([completeCiting('recovered C')]), capabilities: capabilities({ calls }) });
    const cycle = await takeOver(b);
    expect(cycle.outcome).toMatchObject({ termination: { reason: 'completed' } });
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(await testRecord(platform.pool, 'window-c')).toMatchObject({ writeCount: 1, version: 1 });
    expect(calls.execute).toBe(2);
    expect(new Set(calls.keys).size).toBe(1);
    expect(ledger.receipts).toHaveLength(1);
    expect(ledger.receipts[0]).toMatchObject({ status: 'succeeded', result: { version: 1 }, evidence: { obtainedVia: 'replay', replayed: true, attempts: 2 } });
    expect((await new PostgresActionLedgerStore(platform.pool).metrics(taskId)).duplicatesPrevented).toBe(1);
    expect(await observationsOf(platform.pool, taskId)).toHaveLength(1);
  });

  it('D: receipt + observation durable, death before the next model call → no re-execution; next snapshot has the observation', async () => {
    const taskId = await createActionTask(platform);
    const calls = handlerCalls();
    const a = await dyingWorker({ script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'window-d', value: 'x' })]), capabilities: capabilities({ calls }), point: 'after_attempt_recorded' });
    expect(await a.outcome).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
    const [observation] = await observationsOf(platform.pool, taskId);
    expect(observation).toMatchObject({ outcome: 'succeeded' });

    await expireLease(platform.pool, taskId);
    const b = await worker({ script: sequence([completeCiting('recovered D')]), capabilities: capabilities({ calls }) });
    await takeOver(b);
    expect(calls.execute).toBe(1);
    expect(await testRecord(platform.pool, 'window-d')).toMatchObject({ writeCount: 1 });
    expect(contextOf(b.provider.requests[0]!).observations.map((o) => o.observationId)).toEqual([observation!.observationId]);
    const run = (await platform.tasks.getTask(taskId)).runs[0]!;
    const steps = await stepsOf(platform.pool, run.runId);
    expect(steps.map((s) => [s.iteration, s.decision?.type, s.outcome])).toEqual([
      [1, 'propose_action', 'observed'],
      [2, 'complete', 'recorded'],
    ]);
    // Iteration 2's snapshot (compiled by B) contains the action observation.
    const snapshot = await platform.pool.query<{ compiled_context: { sections: { observations: { itemId: string }[] } } }>('select compiled_context from context_snapshots where snapshot_id = $1', [steps[1]!.contextSnapshotId]);
    expect(snapshot.rows[0]!.compiled_context.sections.observations.map((i) => i.itemId)).toEqual([`observation:${observation!.observationId}`]);
  });
});

describe('stale worker protection (fencing reused from C1)', () => {
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    return { open, opened, arrived, reached };
  }

  it('A loses its lease while its call is in flight (before the effect); B recovers with the same key; A returns late and can write nothing', async () => {
    const taskId = await createActionTask(platform);
    const calls = handlerCalls();
    const g = gate();
    let first = true;
    const a = await dyingWorker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'stale-before', value: 'x' })]),
      capabilities: capabilities({
        calls,
        timeoutMs: 20_000,
        faults: {
          beforeEffect: async () => {
            if (!first) return;
            first = false;
            g.reached();
            await g.opened;
          },
        },
      }),
    });
    await g.arrived;
    await expireLease(platform.pool, taskId);
    const b = await worker({ script: sequence([completeCiting('b completed')]), capabilities: capabilities({ calls }) });
    await takeOver(b);

    // A comes back: its call reaches the ledger with the SAME key (deduplicated), then every write is refused.
    g.open();
    expect(await a.outcome).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(new Set(calls.keys)).toEqual(new Set([ledger.executions[0]!.executionKey]));
    expect(await testRecord(platform.pool, 'stale-before')).toMatchObject({ writeCount: 1 });
    expect(ledger.receipts).toHaveLength(1);
    expect(ledger.attempts.map((x) => [x.workerId, x.outcome])).toEqual([
      ['worker-a', null],
      ['worker-b', 'applied'],
    ]);
    expect(await observationsOf(platform.pool, taskId)).toHaveLength(1);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
  });

  it('A answers after its lease EXPIRED but before any takeover: fencing alone refuses the receipt; the next owner produces the only one', async () => {
    const taskId = await createActionTask(platform);
    const g = gate();
    let first = true;
    const a = await dyingWorker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'expired-owner', value: 'x' })]),
      capabilities: capabilities({
        timeoutMs: 20_000,
        faults: {
          afterEffect: async () => {
            if (first) {
              first = false;
              g.reached();
              await g.opened;
            }
            return 'answer' as const;
          },
        },
      }),
    });
    await g.arrived;
    // Nobody took over: A is still the recorded owner, with the same generation — only the expiry has passed.
    await expireLease(platform.pool, taskId);
    g.open();
    expect(await a.outcome).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
    let ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.receipts).toEqual([]);
    expect(ledger.attempts).toEqual([expect.objectContaining({ workerId: 'worker-a', outcome: null })]);
    expect(await observationsOf(platform.pool, taskId)).toEqual([]);

    const b = await worker({ script: sequence([completeCiting('b completed')]), capabilities: capabilities() });
    await takeOver(b);
    ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.receipts).toEqual([expect.objectContaining({ evidence: expect.objectContaining({ obtainedVia: 'replay', replayed: true }) })]);
    expect(await testRecord(platform.pool, 'expired-owner')).toMatchObject({ writeCount: 1 });
  });

  it("A's effect already happened when it lost its lease: B obtains the same effective result by key; A cannot report success", async () => {
    const taskId = await createActionTask(platform);
    const calls = handlerCalls();
    const g = gate();
    let first = true;
    const a = await dyingWorker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'stale-after', value: 'x' })]),
      capabilities: capabilities({
        calls,
        timeoutMs: 20_000,
        faults: {
          afterEffect: async () => {
            if (first) {
              first = false;
              g.reached();
              await g.opened;
            }
            return 'answer' as const;
          },
        },
      }),
    });
    await g.arrived;
    expect(await testRecord(platform.pool, 'stale-after')).toMatchObject({ writeCount: 1 });
    await expireLease(platform.pool, taskId);
    const b = await worker({ script: sequence([completeCiting('b completed')]), capabilities: capabilities({ calls }) });
    await takeOver(b);
    g.open();
    expect(await a.outcome).toEqual({ kind: 'interrupted', cause: 'lease_lost' });

    const ledger = await ledgerOf(platform.pool, taskId);
    expect(await testRecord(platform.pool, 'stale-after')).toMatchObject({ writeCount: 1, version: 1 });
    expect(ledger.receipts).toEqual([expect.objectContaining({ status: 'succeeded', result: { recordKey: 'stale-after', version: 1, value: 'x' }, evidence: expect.objectContaining({ obtainedVia: 'replay', replayed: true }) })]);
    // A's attempt never got an outcome recorded, and A wrote no receipt, observation, step or task change.
    expect(ledger.attempts.find((x) => x.workerId === 'worker-a')).toMatchObject({ outcome: null });
    const run = (await platform.tasks.getTask(taskId)).runs[0]!;
    expect((await stepsOf(platform.pool, run.runId)).every((s) => s.leaseGeneration === (s.iteration === 1 ? 1 : 2))).toBe(true);
    expect(await platform.tasks.getRun(run.runId)).toMatchObject({ status: 'completed', recoveries: 1 });
  });
});

describe('uncertain outcomes are never guessed', () => {
  it('unknown answer + reconciliation available → reconcile → receipt (obtained via reconcile), one effect', async () => {
    const taskId = await createActionTask(platform);
    const calls = handlerCalls();
    const b = await worker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'reconciled', value: 'x' }), completeCiting('reconciled')]),
      capabilities: capabilities({ calls, recovery: 'reconcile_before_retry', faults: { afterEffect: () => 'throw' } }),
    });
    expect((await takeOver(b)).outcome).toMatchObject({ termination: { reason: 'completed' } });
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.attempts.map((x) => [x.kind, x.outcome, x.errorCode])).toEqual([
      ['execute', 'unknown', 'handler_error'],
      ['reconcile', 'applied', null],
    ]);
    expect(calls).toMatchObject({ execute: 1, reconcile: 1 });
    expect(ledger.receipts).toEqual([expect.objectContaining({ status: 'succeeded', evidence: expect.objectContaining({ obtainedVia: 'reconcile' }) })]);
    expect(await testRecord(platform.pool, 'reconciled')).toMatchObject({ writeCount: 1 });
  });

  it('reconciliation says not applied → a replay with the same key applies it once', async () => {
    const taskId = await createActionTask(platform);
    let failFirst = true;
    const b = await worker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'not-applied', value: 'x' }), completeCiting('ok')]),
      capabilities: capabilities({
        recovery: 'reconcile_before_retry',
        faults: {
          beforeEffect: () => {
            if (failFirst) {
              failFirst = false;
              throw new Error('request never left');
            }
          },
        },
      }),
    });
    await takeOver(b);
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.attempts.map((x) => [x.kind, x.outcome])).toEqual([
      ['execute', 'unknown'],
      ['reconcile', 'not_applied'],
      ['replay', 'applied'],
    ]);
    expect(ledger.receipts[0]!.evidence).toMatchObject({ obtainedVia: 'replay', attempts: 3 });
    expect(await testRecord(platform.pool, 'not-applied')).toMatchObject({ writeCount: 1 });
  });

  it('transport retry under idempotent replay: the domain returns the earlier effect (duplicate prevented)', async () => {
    const taskId = await createActionTask(platform);
    let lose = true;
    const b = await worker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'replayed', value: 'x' }), completeCiting('ok')]),
      capabilities: capabilities({
        withoutReconcile: true,
        faults: {
          afterEffect: () => {
            const mode = lose ? 'unknown' : 'answer';
            lose = false;
            return mode;
          },
        },
      }),
    });
    await takeOver(b);
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.attempts.map((x) => [x.kind, x.outcome, x.errorCode])).toEqual([
      ['execute', 'unknown', 'domain_unknown'],
      ['replay', 'applied', null],
    ]);
    expect(ledger.receipts[0]!.evidence).toMatchObject({ obtainedVia: 'replay', replayed: true });
    expect(await testRecord(platform.pool, 'replayed')).toMatchObject({ writeCount: 1 });
  });

  it('outcome cannot be established → execution needs_reconciliation, no observation, run suspended, task blocked, no model continuation', async () => {
    const taskId = await createActionTask(platform);
    const calls = handlerCalls();
    const b = await worker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'uncertain', value: 'x' }), completeCiting('must never run')]),
      capabilities: capabilities({ calls, withoutReconcile: true, maxAttempts: 1, faults: { afterEffect: () => 'unknown' } }),
    });
    const cycle = await takeOver(b);
    expect(cycle.outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'write_outcome_uncertain', code: 'write_outcome_uncertain', details: { attempts: 1 } } });
    // The effect DID happen in the world; the platform does not know that and says so.
    expect(await testRecord(platform.pool, 'uncertain')).toMatchObject({ writeCount: 1 });
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.executions).toEqual([expect.objectContaining({ status: 'needs_reconciliation' })]);
    expect(ledger.receipts).toEqual([]);
    expect(await observationsOf(platform.pool, taskId)).toEqual([]);
    expect(b.provider.callCount).toBe(1);
    const view = await platform.tasks.getTask(taskId);
    expect(view.task).toMatchObject({ status: 'blocked', statusReason: 'write_outcome_uncertain' });
    expect(await platform.tasks.getRun(view.runs[0]!.runId)).toMatchObject({ status: 'suspended', termination: { reason: 'write_outcome_uncertain', failureClass: 'action' }, failure: null });
    expect((await stepsOf(platform.pool, view.runs[0]!.runId)).map((s) => s.outcome)).toEqual(['pending']);
    expect(await b.platform.worker.runOnce()).toEqual({ kind: 'idle' });
  });

  it('the reconciler itself failing is classified as write_reconciliation_failure (still suspended, never guessed)', async () => {
    const taskId = await createActionTask(platform);
    const b = await worker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'reconcile-fails', value: 'x' })]),
      capabilities: capabilities({ recovery: 'reconcile_before_retry', maxAttempts: 1, faults: { afterEffect: () => 'throw', reconcile: () => 'throw' } }),
    });
    expect((await takeOver(b)).outcome).toMatchObject({ termination: { reason: 'write_outcome_uncertain', code: 'write_reconciliation_failure' } });
    expect((await ledgerOf(platform.pool, taskId)).attempts.map((x) => [x.kind, x.outcome, x.errorCode])).toEqual([
      ['execute', 'unknown', 'handler_error'],
      ['reconcile', 'unknown', 'reconciliation_error'],
    ]);
  });

  it('cancellation while the call is in flight: the late answer is refused and the execution is flagged needs_reconciliation', async () => {
    const taskId = await createActionTask(platform);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    const a = await dyingWorker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'cancelled', value: 'x' })]),
      capabilities: capabilities({
        timeoutMs: 20_000,
        faults: {
          afterEffect: async () => {
            reached();
            await released;
            return 'answer' as const;
          },
        },
      }),
    });
    await arrived;
    await platform.tasks.transitionTask({ taskId, to: 'cancelled', actor: { kind: 'service', ref: 'operator' }, correlationId: 'cancel' });
    release();
    expect(await a.outcome).toMatchObject({ kind: 'interrupted' });
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.executions).toEqual([expect.objectContaining({ status: 'needs_reconciliation' })]);
    expect(ledger.receipts).toEqual([]);
    expect(await testRecord(platform.pool, 'cancelled')).toMatchObject({ writeCount: 1 });
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('cancelled');
  });
});
