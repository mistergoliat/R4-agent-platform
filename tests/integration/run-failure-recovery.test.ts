import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Platform } from '@r4/api';
import { runFailureRecoveryOf, type Handoff } from '@r4/contracts';
import { FindingTaxonomy, genericDeterministicEvaluators, runEvaluation, type EvaluationDefinition } from '@r4/evaluation';
import type { FakeModelStep, ModelRequest } from '@r4/model-gateway';
import { PostgresContextSnapshotStore } from '@r4/persistence-postgres';
import { PostgresTrajectoryReader } from '@r4/evaluator';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { actionCapabilities, createActionTask, ledgerOf, startActionPlatform, WRITES } from '../support/actions.js';
import { captureLogs } from '../support/logs.js';
import { expireLease, startTestWorker, waitFor, type TestWorker, type TestWorkerOptions } from '../support/worker.js';
import { compiledOf, complete, contextOf, propose, read, respond, sequence, type ScriptEntry } from '../support/decisions.js';
import { HUMAN, PARTICIPANT, consult, drain, input, testScheduler } from '../support/temporal.js';
import { GET_TEST_FACT_ID } from '../fixtures/capabilities/get-test-fact.js';
import { ensureTestLedger, handlerCalls, SET_TEST_RECORD_ID } from '../fixtures/capabilities/test-ledger.js';

/**
 * ADR-028 (GAP-H-001): a failed run does not terminate durable work unless
 * the failure establishes that the work is terminal. Implemented for
 * `invalid_decision` and retryable `model_failure`: the run still fails
 * exactly as ADR-008 says (invalid step, failed run), the task stays
 * runnable, and the next ORDINARY claim starts a new run with a freshly
 * compiled context — bounded by `maxRunFailureRecoveries` (default 1),
 * after which (or for a non-retryable model failure) a human is asked
 * through a platform-initiated handoff. Real worker, real PostgreSQL.
 */
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

async function worker(options: Omit<TestWorkerOptions, 'workerId'> & { workerId?: string }): Promise<TestWorker> {
  const w = await startTestWorker(db.url, { workerId: options.workerId ?? `recovery-worker-${workers.length}`, capabilities: actionCapabilities(platform.pool), ...options });
  workers.push(w);
  return w;
}

/** Valid JSON followed by prose: `invalid_structured_output` (R4-H's most frequent live failure). */
const TRAILING_PROSE: FakeModelStep = { type: 'text', content: '{"type":"respond","content":"x"}\n\nEspero que te sirva.' };
const RETRYABLE: FakeModelStep = { type: 'provider_error', kind: 'rate_limited', retryable: true, message: 'HTTP 429' };
const NON_RETRYABLE: FakeModelStep = { type: 'provider_error', retryable: false, message: 'HTTP 401' };
const definition: EvaluationDefinition = { id: 'test.generic', version: 1, taxonomy: FindingTaxonomy.generic(), evaluators: genericDeterministicEvaluators(), privacy: { redactKeys: [] }, semanticTimeoutMs: 1000 };
const answer = (text = 'Here is what I found.'): ScriptEntry[] => [respond(text)];

const task = async (taskId: string) => (await platform.tasks.getTask(taskId)).task;
const runs = async (taskId: string) => Promise.all((await platform.tasks.getTask(taskId)).runs.map((r) => platform.tasks.getRun(r.runId)));
const snapshotsOf = (runId: string) => new PostgresContextSnapshotStore(platform.pool).listForRun(runId);
const platformHandoffs = async (taskId: string) => (await platform.temporal.inspect(taskId)).humans.filter((h): h is Handoff => h.kind === 'handoff' && h.payload.initiatedBy === 'platform');
const attentionFor = async (taskId: string) => (await platform.temporal.attention()).requests.filter((r) => r.taskId === taskId);

describe('recoverable run failure → same task, new run, fresh context', () => {
  it('invalid_decision: the run fails as before (invalid step), the task stays running, the next ordinary claim recovers it', async () => {
    const logs = captureLogs('recovery-it');
    const taskId = await createActionTask(platform);
    const goalsBefore = (await platform.tasks.getTask(taskId)).goals;
    const w = await worker({ logger: logs.logger, script: sequence([TRAILING_PROSE, ...answer()]) });

    const first = await w.platform.worker.runOnce();
    expect(first).toMatchObject({ kind: 'executed', claim: 'started', outcome: { kind: 'terminated', termination: { reason: 'invalid_decision', code: 'invalid_structured_output' } } });
    // ADR-008 intact: invalid step, failed run, nothing rescued from the prose.
    const [failed] = await runs(taskId);
    expect(failed).toMatchObject({ status: 'failed', termination: { reason: 'invalid_decision', failureClass: 'protocol', details: { runFailureRecovery: { outcome: 'continued', consecutiveFailures: 1, maxRunFailureRecoveries: 1 } } } });
    expect((await platform.tasks.getTask(taskId)).runs).toHaveLength(1);
    // The durable task continues: running, no active run, no lease, nothing asked of a human.
    expect(await task(taskId)).toMatchObject({ status: 'running' });
    expect(await attentionFor(taskId)).toEqual([]);

    const second = await w.platform.worker.runOnce();
    expect(second).toMatchObject({ kind: 'executed', claim: 'started', outcome: { kind: 'terminated', termination: { reason: 'waiting' } } });
    const [, recovery] = await runs(taskId);
    expect(recovery).toMatchObject({ sequence: 2, status: 'suspended', recoveries: 0 });
    // A NEW snapshot compiled by C2 for the recovery run; the failed run's snapshot is not reused.
    const [failedSnapshot] = await snapshotsOf(failed!.runId);
    const [freshSnapshot] = await snapshotsOf(recovery!.runId);
    expect(freshSnapshot).toMatchObject({ runId: recovery!.runId, iteration: 1, attempt: 1 });
    expect(freshSnapshot!.snapshotId).not.toBe(failedSnapshot!.snapshotId);
    expect(w.provider.requests[1]!.correlation.runId).toBe(recovery!.runId);
    // No repair hint: nothing in the recovery context says the previous output was invalid.
    expect(JSON.stringify(freshSnapshot!.compiledContext)).not.toMatch(/invalid|Espero que te sirva/);
    expect(await task(taskId)).toMatchObject({ status: 'waiting' });
    // Goal untouched (recovery is independent of goals: here only the generic root exists).
    expect((await platform.tasks.getTask(taskId)).goals).toEqual(goalsBefore);

    expect(logs.events('task.run_failure.recoverable')).toEqual([expect.objectContaining({ taskId, runId: failed!.runId, terminationReason: 'invalid_decision', code: 'invalid_structured_output', attempt: 1, maxRunFailureRecoveries: 1 })]);
    expect(logs.events('task.run_failure.recovery_started')).toEqual([expect.objectContaining({ taskId, runId: recovery!.runId, failedRunId: failed!.runId, attempt: 1 })]);
    expect(logs.events('task.run_failure.recovered')).toEqual([expect.objectContaining({ taskId, runId: recovery!.runId, failedRunId: failed!.runId, consecutiveFailures: 1, terminationReason: 'waiting' })]);
    // Telemetry never carries the invalid output.
    expect(logs.raw()).not.toContain('Espero que te sirva');
  });

  it('retryable model_failure (rate limit, timeout): recovered the same way; the failed call is the run’s last', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([RETRYABLE, { type: 'timeout' }, ...answer()]), policy: { modelCallTimeoutMs: 150 }, maxRunFailureRecoveries: 2 });
    await w.platform.worker.runOnce();
    await w.platform.worker.runOnce();
    await w.platform.worker.runOnce();
    const [r1, r2, r3] = await runs(taskId);
    expect(r1).toMatchObject({ status: 'failed', termination: { reason: 'model_failure', code: 'rate_limited', details: { retryable: true, runFailureRecovery: { outcome: 'continued', consecutiveFailures: 1, maxRunFailureRecoveries: 2 } } } });
    expect(r2).toMatchObject({ status: 'failed', termination: { reason: 'model_failure', code: 'timeout', details: { retryable: true, runFailureRecovery: { outcome: 'continued', consecutiveFailures: 2 } } } });
    expect(r3).toMatchObject({ status: 'suspended' });
    expect(await task(taskId)).toMatchObject({ status: 'waiting' });
    expect(w.provider.callCount).toBe(3); // two failed calls + the reply, which ends the turn (R4-J1E-R2.2)
  });

  it('a task that never had a precise customer goal recovers; recovery creates, changes and closes no goal', async () => {
    const taskId = await createActionTask(platform);
    const before = await platform.tasks.getTask(taskId);
    const transitionsBefore = await platform.pool.query('select count(*)::int as n from goal_transitions where task_id = $1', [taskId]);
    const w = await worker({ script: sequence([TRAILING_PROSE, ...answer()]) });
    await w.platform.worker.runOnce();
    await w.platform.worker.runOnce();
    const after = await platform.tasks.getTask(taskId);
    expect(after.goals).toEqual(before.goals);
    expect(after.task).toMatchObject({ rootGoalId: before.task.rootGoalId, currentGoalId: before.task.currentGoalId });
    expect((await platform.pool.query('select count(*)::int as n from goal_transitions where task_id = $1', [taskId])).rows).toEqual(transitionsBefore.rows);
  });
});

describe('recovery is finite: exhaustion and non-retryable failures go to a human, never to `failed`', () => {
  it('N+1 consecutive recoverable failures → blocked + platform handoff visible in attention; no further run', async () => {
    const logs = captureLogs('recovery-it');
    const taskId = await createActionTask(platform);
    const w = await worker({ logger: logs.logger, script: sequence([TRAILING_PROSE, TRAILING_PROSE]) });
    await w.platform.worker.runOnce();
    await w.platform.worker.runOnce();
    expect(await w.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    expect(await w.platform.execution.claimNext({ workerId: 'eager', leaseDurationMs: 60_000 })).toBeNull();

    const all = await runs(taskId);
    expect(all.map((r) => [r.status, runFailureRecoveryOf(r.termination)?.outcome])).toEqual([['failed', 'continued'], ['failed', 'exhausted']]);
    expect(await task(taskId)).toMatchObject({ status: 'blocked', statusReason: 'run_failure_recovery_exhausted' });
    const [handoff] = await platformHandoffs(taskId);
    expect(handoff).toMatchObject({ kind: 'handoff', status: 'requested', runId: all[1]!.runId, payload: { initiatedBy: 'platform', reason: 'run_failure_recovery_exhausted', contextRefs: [] } });
    expect(handoff!.payload.summary).not.toMatch(/Espero/);
    expect(await attentionFor(taskId)).toEqual([expect.objectContaining({ requestId: handoff!.requestId })]);
    expect((await platform.temporal.inspect(taskId)).ownership).toMatchObject({ owner: 'none', blockedBy: ['human_handoff'] });
    expect(w.provider.callCount).toBe(2);
    expect(logs.events('task.run_failure.recovery_exhausted')).toEqual([expect.objectContaining({ taskId, runId: all[1]!.runId, consecutiveFailures: 2, maxRunFailureRecoveries: 1 })]);
    expect(logs.events('handoff.requested')).toEqual([expect.objectContaining({ taskId, initiatedBy: 'platform', reason: 'run_failure_recovery_exhausted' })]);

    // The conversation is not over: new input is accepted (durable) while a human decides.
    await expect(platform.temporal.submitInput(taskId, input('late-1', 'Are you there?'), PARTICIPANT, 'late')).resolves.toMatchObject({ replayed: false });
    expect(await w.platform.worker.runOnce()).toEqual({ kind: 'idle' });
  });

  it('the recovery budget is configurable (maxRunFailureRecoveries = 2 → exhausted at the third failure)', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([TRAILING_PROSE, TRAILING_PROSE, TRAILING_PROSE]), maxRunFailureRecoveries: 2 });
    for (let i = 0; i < 4; i += 1) await w.platform.worker.runOnce();
    expect((await runs(taskId)).map((r) => runFailureRecoveryOf(r.termination))).toEqual([
      { outcome: 'continued', consecutiveFailures: 1, maxRunFailureRecoveries: 2 },
      { outcome: 'continued', consecutiveFailures: 2, maxRunFailureRecoveries: 2 },
      { outcome: 'exhausted', consecutiveFailures: 3, maxRunFailureRecoveries: 2 },
    ]);
    expect(await task(taskId)).toMatchObject({ status: 'blocked', statusReason: 'run_failure_recovery_exhausted' });
  });

  it('non-retryable model failure → not retried, blocked + platform handoff with its own reason (nothing was exhausted)', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([NON_RETRYABLE, ...answer()]) });
    await w.platform.worker.runOnce();
    expect(await w.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    const [run] = await runs(taskId);
    expect(run).toMatchObject({ status: 'failed', termination: { reason: 'model_failure', code: 'provider_error', details: { retryable: false, runFailureRecovery: { outcome: 'handed_off', consecutiveFailures: null } } } });
    expect(await task(taskId)).toMatchObject({ status: 'blocked', statusReason: 'non_retryable_model_failure' });
    expect(await platformHandoffs(taskId)).toEqual([expect.objectContaining({ status: 'requested', payload: expect.objectContaining({ reason: 'non_retryable_model_failure' }) })]);
    expect(w.provider.callCount).toBe(1);

    // Human-recoverable: accept, release → autonomy resumes in a normal new run.
    const [handoff] = await platformHandoffs(taskId);
    await platform.temporal.respondHuman(handoff!.requestId, { responseKey: 'accept', outcome: 'accept', content: 'Checking the provider.' }, HUMAN);
    await platform.temporal.respondHuman(handoff!.requestId, { responseKey: 'release', outcome: 'release', content: 'Provider fixed; continue.' }, HUMAN);
    expect(await task(taskId)).toMatchObject({ status: 'running' });
    await w.platform.worker.runOnce();
    expect(await task(taskId)).toMatchObject({ status: 'waiting' });
    expect((await runs(taskId)).map((r) => r.status)).toEqual(['failed', 'suspended']);
  });

  it('a human release resets the consecutive count (history kept); cancelling the request resumes too', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([TRAILING_PROSE, TRAILING_PROSE, TRAILING_PROSE, ...answer()]) });
    await w.platform.worker.runOnce();
    await w.platform.worker.runOnce();
    const [handoff] = await platformHandoffs(taskId);
    // An operator takes the platform's request (accept), then releases it.
    await platform.temporal.takeOver(taskId, { responseKey: 'take', note: 'Looking into it.' }, HUMAN);
    const activated = (await platform.temporal.inspect(taskId)).events.find((e) => e.type === 'handoff.activated')!;
    expect(activated.data).toMatchObject({ requestId: handoff!.requestId, initiatedBy: 'platform' });
    await platform.temporal.respondHuman(handoff!.requestId, { responseKey: 'release', outcome: 'release', content: 'Go on.' }, HUMAN);

    await w.platform.worker.runOnce(); // invalid again: the count starts from 1 → recoverable, not exhausted
    await w.platform.worker.runOnce(); // recovery run answers
    const all = await runs(taskId);
    expect(all.map((r) => runFailureRecoveryOf(r.termination)?.outcome ?? r.status)).toEqual(['continued', 'exhausted', 'continued', 'suspended']);
    expect(runFailureRecoveryOf(all[2]!.termination)).toMatchObject({ consecutiveFailures: 1 });
    expect(await task(taskId)).toMatchObject({ status: 'waiting' });

    // Cancelling the platform's request (instead of accept + release) also returns autonomy.
    const other = await createActionTask(platform);
    const w2 = await worker({ script: sequence([TRAILING_PROSE, TRAILING_PROSE, ...answer()]) });
    await w2.platform.worker.runOnce();
    await w2.platform.worker.runOnce();
    const [request] = await platformHandoffs(other);
    await platform.temporal.respondHuman(request!.requestId, { responseKey: 'cancel', outcome: 'cancel', content: 'No human needed.' }, HUMAN);
    expect(await task(other)).toMatchObject({ status: 'running' });
    await w2.platform.worker.runOnce();
    expect(await task(other)).toMatchObject({ status: 'waiting' });
  });
});

describe('races between the failed run and the recovery claim', () => {
  it('new customer input between the runs is accepted and appears in the recovery run’s fresh context', async () => {
    const taskId = await createActionTask(platform);
    const seen: ModelRequest[] = [];
    const w = await worker({ script: sequence([TRAILING_PROSE, (r) => (seen.push(r), respond('Got both messages.'))]) });
    await w.platform.worker.runOnce();
    const accepted = await platform.temporal.submitInput(taskId, input('between-1', 'Also: it must fit in 3 by 3 metres.'), PARTICIPANT, 'between');
    expect(accepted).toMatchObject({ replayed: false });
    await w.platform.worker.runOnce();
    expect(JSON.stringify(compiledOf(seen[0]!).sections.conversation)).toContain('Also: it must fit in 3 by 3 metres.');
    const memory = await platform.pool.query<{ entry_id: string }>("select entry_id from memory_entries where task_id = $1 and memory_type = 'CONVERSATIONAL'", [taskId]);
    const [, recovery] = await runs(taskId);
    const [snapshot] = await snapshotsOf(recovery!.runId);
    expect(snapshot!.decisions.filter((d) => d.decision === 'included').map((d) => d.itemId)).toEqual(expect.arrayContaining(memory.rows.map((m) => `memory:${m.entry_id}`)));
  });

  it('operator takeover before the recovery claim wins: no autonomous run until release', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([TRAILING_PROSE, ...answer()]) });
    await w.platform.worker.runOnce();
    await platform.temporal.takeOver(taskId, { responseKey: 'take', note: 'I will handle it.' }, HUMAN);
    expect(await task(taskId)).toMatchObject({ status: 'blocked', statusReason: 'human_handoff' });
    expect(await w.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    await platform.temporal.submitInput(taskId, input('during-1', 'Hello?'), PARTICIPANT, 'during');
    expect(await w.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    expect(w.provider.callCount).toBe(1);
    const active = (await platform.temporal.inspect(taskId)).humans.find((h) => h.kind === 'handoff' && h.status === 'active')!;
    await platform.temporal.respondHuman(active.requestId, { responseKey: 'release', outcome: 'release', content: 'Back to you.' }, HUMAN);
    await w.platform.worker.runOnce();
    expect((await runs(taskId)).map((r) => r.status)).toEqual(['failed', 'suspended']);
  });

  it('two workers compete for the recovery: exactly one claim, exactly one recovery run', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([TRAILING_PROSE]) });
    await w.platform.worker.runOnce();
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => w.platform.execution.claimNext({ workerId: `racer-${i}`, leaseDurationMs: 60_000 })));
    const won = claims.filter((c) => c !== null);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ kind: 'started', run: { sequence: 2 } });
    expect((await platform.tasks.getTask(taskId)).runs).toHaveLength(2);
  });

  it('worker death during the recovery run: the SAME recovery run is taken over (fencing), no third run', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([TRAILING_PROSE]) });
    await w.platform.worker.runOnce();
    // Worker B claims the recovery run and its model call never returns; it then "dies" (lease expires on the DB clock).
    let entered = false;
    const hanging = await worker({ workerId: 'dying', script: () => ((entered = true), new Promise<FakeModelStep>(() => undefined)), heartbeatIntervalMs: 60_000, leaseDurationMs: 120_000, policy: { modelCallTimeoutMs: 600_000 } });
    void hanging.platform.worker.runOnce().catch(() => undefined);
    await waitFor(() => entered, 10_000);
    const [, recovery] = await runs(taskId);
    expect(recovery).toMatchObject({ sequence: 2, status: 'running' });
    await expireLease(platform.pool, taskId);

    const survivor = await worker({ workerId: 'survivor', script: sequence(answer()) });
    const cycle = await waitFor(async () => {
      const c = await survivor.platform.worker.runOnce();
      return c.kind === 'executed' ? c : null;
    }, 15_000, 50);
    expect(cycle).toMatchObject({ claim: 'resumed', takeover: true, runId: recovery!.runId });
    const all = await runs(taskId);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ runId: recovery!.runId, status: 'suspended', recoveries: 1 });
  });
});

describe('durable effects before the failure are preserved, never replayed', () => {
  it('a READ observed before the invalid output is in the recovery context; the invocation is not repeated', async () => {
    const taskId = await createActionTask(platform);
    const capabilities = actionCapabilities(platform.pool);
    const seen: ModelRequest[] = [];
    const w = await worker({
      capabilities,
      script: sequence([read(GET_TEST_FACT_ID, { factKey: 'alpha' }), TRAILING_PROSE, (r) => (seen.push(r), complete('used the fact', contextOf(r).observations.map((o) => o.observationId)))]),
    });
    await w.platform.worker.runOnce();
    await w.platform.worker.runOnce();
    const observations = await platform.pool.query<{ observation_id: string; run_id: string }>('select observation_id, run_id from observations where task_id = $1', [taskId]);
    expect(observations.rows).toHaveLength(1);
    const [failed, recovery] = await runs(taskId);
    expect(observations.rows[0]!.run_id).toBe(failed!.runId);
    expect(contextOf(seen[0]!).observations.map((o) => o.observationId)).toEqual([observations.rows[0]!.observation_id]);
    expect(recovery).toMatchObject({ status: 'completed', usage: { capabilityCalls: 0 } });
    const executions = (await platform.pool.query("select count(*)::int as n from agent_run_steps where task_id = $1 and decision_type = 'read_capability'", [taskId])).rows[0].n;
    expect(executions).toBe(1);
  });

  it('a governed write before the invalid output: one proposal, one execution, one attempt, one receipt, same executionKey; not replayed', async () => {
    const calls = handlerCalls();
    const taskId = await createActionTask(platform, { budget: { maxWrites: 1 } });
    const seen: ModelRequest[] = [];
    const w = await worker({
      capabilities: actionCapabilities(platform.pool, { calls }),
      policy: WRITES,
      script: sequence([
        propose(SET_TEST_RECORD_ID, { recordKey: 'recovery', value: 'one' }),
        TRAILING_PROSE,
        (r) => (seen.push(r), propose(SET_TEST_RECORD_ID, { recordKey: 'recovery-2', value: 'two' })),
      ]),
    });
    await w.platform.worker.runOnce();
    const before = await ledgerOf(platform.pool, taskId);
    expect(before.executions).toHaveLength(1);
    await w.platform.worker.runOnce();
    const after = await ledgerOf(platform.pool, taskId);
    // The recovery run saw the receipt-backed observation…
    const receiptObservation = contextOf(seen[0]!).observations.find((o) => o.outcome === 'succeeded');
    expect(receiptObservation).toBeTruthy();
    // …and nothing of the earlier write was replayed or re-keyed.
    expect(after.proposals).toHaveLength(1);
    expect(after.executions.map((e) => [e.executionId, e.executionKey, e.status])).toEqual(before.executions.map((e) => [e.executionId, e.executionKey, 'succeeded']));
    expect(after.attempts).toHaveLength(1);
    expect(after.receipts).toHaveLength(1);
    expect(after.receipts[0]!.executionKey).toBe(before.executions[0]!.executionKey);
    expect(calls.execute).toBe(1);
    // The task-scoped write budget did not reset with the new run: a second write is refused.
    const [, recovery] = await runs(taskId);
    expect(recovery).toMatchObject({ status: 'failed', termination: { reason: 'budget_exhausted', code: 'max_write_actions' } });
    expect(await task(taskId)).toMatchObject({ status: 'failed', statusReason: 'budget_exhausted' });
  });

  it('reconciliation before cognition: an uncertain write blocks every claim; only after the outcome is established may cognition (and its recovery) run', async () => {
    const taskId = await createActionTask(platform);
    const lost = await worker({ policy: WRITES, capabilities: actionCapabilities(platform.pool, { maxAttempts: 1, faults: { afterEffect: () => 'unknown', reconcile: () => 'unknown' } }), script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'uncertain', value: 'one' })]) });
    await lost.platform.worker.runOnce();
    expect(await task(taskId)).toMatchObject({ status: 'blocked', statusReason: 'write_outcome_uncertain' });
    expect(await lost.platform.worker.runOnce()).toEqual({ kind: 'idle' });

    const seen: ModelRequest[] = [];
    const w = await worker({ policy: WRITES, script: sequence([TRAILING_PROSE, (r) => (seen.push(r), complete('confirmed', contextOf(r).observations.map((o) => o.observationId)))]) });
    const { scheduler } = testScheduler(platform.pool);
    expect(await drain(scheduler)).toBe(1);
    expect(await w.platform.worker.runOnce()).toMatchObject({ kind: 'reconciled', outcome: 'resolved' });
    expect(w.provider.callCount).toBe(0); // no cognition before the outcome is established
    const receipt = (await ledgerOf(platform.pool, taskId)).receipts[0]!;
    await w.platform.worker.runOnce(); // cognition: invalid → recoverable
    await w.platform.worker.runOnce(); // recovery
    const [, failed, recovery] = await runs(taskId);
    expect(runFailureRecoveryOf(failed!.termination)).toMatchObject({ outcome: 'continued' });
    for (const r of [failed!, recovery!]) expect(Date.parse(r.startedAt)).toBeGreaterThanOrEqual(Date.parse(receipt.recordedAt));
    expect(contextOf(seen[0]!).observations.some((o) => o.outcome === 'succeeded')).toBe(true);
    expect(await task(taskId)).toMatchObject({ status: 'completed' });

    // Defense in depth: a task `running` with no active run and no wait — the recovery state — that has an
    // uncertain effect is never claimed: the claim itself excludes it, not only the task status.
    const probe = await createActionTask(platform);
    const lost2 = await worker({ policy: WRITES, capabilities: actionCapabilities(platform.pool, { maxAttempts: 1, faults: { afterEffect: () => 'unknown', reconcile: () => 'unknown' } }), script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'uncertain-2', value: 'one' })]) });
    await lost2.platform.worker.runOnce();
    await platform.pool.query("update task_waits set status = 'completed', resolution = 'reconciliation', completed_at = clock_timestamp() where task_id = $1 and status = 'waiting'", [probe]);
    await platform.pool.query("update agent_tasks set status = 'running' where task_id = $1", [probe]);
    expect((await ledgerOf(platform.pool, probe)).executions.map((e) => e.status)).toEqual(['needs_reconciliation']);
    expect(await lost2.platform.execution.claimNext({ workerId: 'eager', leaseDurationMs: 60_000 })).toBeNull();
  });

  it('human-owned states are never claimed for recovery: a pending consultation holds the task', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([consult('Which record?'), TRAILING_PROSE, ...answer()]) });
    await w.platform.worker.runOnce();
    expect(await task(taskId)).toMatchObject({ status: 'waiting' });
    expect(await w.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    const [request] = (await platform.temporal.inspect(taskId)).humans;
    await platform.temporal.respondHuman(request!.requestId, { responseKey: 'a', outcome: 'answer', content: 'alpha' }, HUMAN);
    await w.platform.worker.runOnce(); // invalid → recoverable
    await w.platform.worker.runOnce(); // recovery
    expect((await runs(taskId)).map((r) => r.status)).toEqual(['suspended', 'failed', 'suspended']);
  });
});

describe('what never triggers recovery', () => {
  it('an accepted decision is final: a valid run is never re-run; terminal failures stay terminal', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([complete('done')]) });
    await w.platform.worker.runOnce();
    expect(await w.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    expect((await runs(taskId)).map((r) => r.status)).toEqual(['completed']);

    // budget_exhausted is not a recoverable failure (unchanged since C1): the task fails, no recovery run.
    const other = await createActionTask(platform, { budget: { maxModelCalls: 1 } });
    const w2 = await worker({ script: sequence([read(GET_TEST_FACT_ID, { factKey: 'one' }), read(GET_TEST_FACT_ID, { factKey: 'two' })]) });
    await w2.platform.worker.runOnce();
    expect(await w2.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    const [exhausted] = await runs(other);
    expect(exhausted).toMatchObject({ status: 'failed', termination: { reason: 'budget_exhausted' } });
    expect(runFailureRecoveryOf(exhausted!.termination)).toBeNull();
    expect(await task(other)).toMatchObject({ status: 'failed' });
  });

  it('Quality observes a failed/recovered trajectory and changes nothing: no status, no run, no claim', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([TRAILING_PROSE]) });
    await w.platform.worker.runOnce();
    const count = async () => (await platform.pool.query<{ n: string }>('select (select count(*) from agent_runs) + (select count(*) from agent_run_steps) + (select count(*) from human_requests) + (select count(*) from agent_task_transitions) as n')).rows[0]!.n;
    const before = { status: (await task(taskId)).status, rows: await count() };
    const subject = await new PostgresTrajectoryReader(platform.pool).subject(taskId);
    const evaluation = await runEvaluation(subject, definition, { reproducibility: { gitSha: 'unknown', protocolVersion: 'test', modelUnderTest: null } });
    expect(evaluation.result.findings.some((f) => f.category === 'MODEL_PROTOCOL')).toBe(true);
    expect(evaluation.result.metrics['r4.execution_outcomes.recoverableRunFailures']).toMatchObject({ value: 1 });
    expect({ status: (await task(taskId)).status, rows: await count() }).toEqual(before);
  });
});
