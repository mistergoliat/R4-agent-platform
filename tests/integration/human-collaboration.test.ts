import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Platform } from '@r4/api';
import type { CompiledContextItem } from '@r4/contracts';
import type { ModelRequest } from '@r4/model-gateway';
import { PostgresExecutionStore } from '@r4/persistence-postgres';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { actionCapabilities, createActionTask, ledgerOf, startActionPlatform, WRITES } from '../support/actions.js';
import { startTestWorker, type TestWorker } from '../support/worker.js';
import { complete, compiledOf, contextOf, propose, respond, sequence } from '../support/decisions.js';
import { HUMAN, OTHER_HUMAN, PARTICIPANT, consult, drain, handoff, input, setTemporalOffset, testScheduler, waitInput, waitRows, waitUntil } from '../support/temporal.js';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { ensureTestLedger, handlerCalls, SET_TEST_RECORD_ID, testLedgerCapability, testRecord } from '../fixtures/capabilities/test-ledger.js';

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
  const w = await startTestWorker(db.url, { workerId: `human-worker-${workers.length}`, ...options });
  workers.push(w);
  return w;
}
const events = async (taskId: string, type: string) => (await platform.temporal.inspect(taskId)).events.filter((e) => e.type === type);
const items = (r: ModelRequest, section: keyof ReturnType<typeof compiledOf>['sections']): CompiledContextItem[] => compiledOf(r).sections[section];
const irreversible = (calls = handlerCalls()) => ({ calls, capabilities: actionCapabilities(platform.pool, { riskClass: 'IRREVERSIBLE_WRITE', calls }) });

describe('consultation', () => {
  it('asks a human while keeping agent ownership; the answer is durable, idempotent and reaches the next run with the question', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([consult('Which option should we use?')]) });
    await w.platform.worker.runOnce();
    const { humans, ownership } = await platform.temporal.inspect(taskId);
    const request = humans[0]!;
    expect(request).toMatchObject({ kind: 'consultation', status: 'requested', payload: { question: 'Which option should we use?' } });
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('waiting');
    expect(ownership).toMatchObject({ owner: 'agent', blockedBy: ['wait'] }); // semantic ownership stays with the agent
    expect(await waitRows(platform.pool, taskId)).toEqual([{ kind: 'WAIT_FOR_HUMAN', status: 'waiting', resolution: null }]);

    const answer = { responseKey: 'answer-1', outcome: 'answer' as const, content: 'Use option B.' };
    await Promise.all([platform.temporal.respondHuman(request.requestId, answer, HUMAN), platform.temporal.respondHuman(request.requestId, answer, HUMAN)]);
    await expect(platform.temporal.respondHuman(request.requestId, { ...answer, content: 'Different.' }, HUMAN)).rejects.toMatchObject({ code: 'idempotency_key_reused' });
    await expect(platform.temporal.respondHuman(request.requestId, { ...answer, responseKey: 'answer-2' }, HUMAN)).rejects.toMatchObject({ code: 'human_request_terminal' });
    expect(await events(taskId, 'consultation.answered')).toHaveLength(1);
    expect(await events(taskId, 'task.woken')).toHaveLength(1);

    const seen: ModelRequest[] = [];
    const next = await worker({ script: sequence([(r) => (seen.push(r), complete('used the answer'))]) });
    await next.platform.worker.runOnce();
    const conversation = items(seen[0]!, 'conversation');
    const question = conversation.find((i) => JSON.stringify(i.content).includes('Which option should we use?'))!;
    const reply = conversation.find((i) => JSON.stringify(i.content).includes('Use option B.'))!;
    expect(question).toMatchObject({ authority: 'CONVERSATIONAL', content: { actor: { role: 'agent' }, interaction: { kind: 'consultation', requestId: request.requestId } } });
    // Human provenance, conversational authority: never canonical business truth.
    expect(reply).toMatchObject({ authority: 'CONVERSATIONAL', provenance: { producedBy: 'user:operator-one' }, content: { actor: { role: 'operator', ref: 'operator-one' }, interaction: { outcome: 'answer' } } });
    expect(conversation.indexOf(question)).toBeLessThan(conversation.indexOf(reply));
    expect(items(seen[0]!, 'authoritativeState')).toEqual([]);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
  });

  it('rejects responses without the required scope or of the wrong kind', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([consult('Quick question?')]) });
    await w.platform.worker.runOnce();
    const request = (await platform.temporal.inspect(taskId)).humans[0]!;
    await expect(platform.temporal.respondHuman(request.requestId, { responseKey: 'k', outcome: 'answer', content: 'x' }, { ...HUMAN, scopes: ['task.cancel'] })).rejects.toMatchObject({ code: 'human_scope_denied' });
    await expect(platform.temporal.respondHuman(request.requestId, { responseKey: 'k', outcome: 'approve', content: 'x' }, HUMAN)).rejects.toMatchObject({ code: 'invalid_human_response' });
  });

  it('expires on its durable deadline (temporal clock): the agent wakes and a late answer is refused', async () => {
    const taskId = await createActionTask(platform);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await (await worker({ script: sequence([decideConsultation(expiresAt)]) })).platform.worker.runOnce();
    const request = (await platform.temporal.inspect(taskId)).humans[0]!;
    expect(request.expiresAt).toBe(expiresAt);
    await setTemporalOffset(platform.pool, 2 * 3_600_000);
    expect(await drain(testScheduler(platform.pool).scheduler)).toBe(1);
    expect((await platform.temporal.inspect(taskId)).humans[0]!.status).toBe('expired');
    expect(await waitRows(platform.pool, taskId)).toEqual([{ kind: 'WAIT_FOR_HUMAN', status: 'completed', resolution: 'timer' }]);
    await expect(platform.temporal.respondHuman(request.requestId, { responseKey: 'late', outcome: 'answer', content: 'Late.' }, HUMAN)).rejects.toMatchObject({ code: 'human_request_terminal' });
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('running');
  });
});

function decideConsultation(expiresAt: string) {
  return { type: 'structured' as const, data: { type: 'request_consultation', question: 'Can you confirm by the deadline?', contextRefs: [], expiresAt } };
}

describe('approval', () => {
  it('approve: the proposal is evaluated AGAIN by policy (new ALLOW, old decision untouched), executes once, and the agent continues', async () => {
    const { calls, capabilities } = irreversible();
    const taskId = await createActionTask(platform);
    const first = await worker({ capabilities, policy: WRITES, script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'approved', value: 'one' })]) });
    await first.platform.worker.runOnce();
    const initial = await ledgerOf(platform.pool, taskId);
    expect(initial.decisions.map((d) => d.outcome)).toEqual(['require_approval']);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('requires_approval');
    const request = (await platform.temporal.inspect(taskId)).humans[0]!;
    expect(request).toMatchObject({ kind: 'approval', payload: { proposalId: initial.proposals[0]!.proposalId, policyDecisionId: initial.decisions[0]!.decisionId, capabilityId: SET_TEST_RECORD_ID, capabilityVersion: 1 } });
    expect(calls.execute).toBe(0);

    await platform.temporal.respondHuman(request.requestId, { responseKey: 'decision', outcome: 'approve', content: 'Approved for this record.' }, HUMAN);
    // Approving executes nothing by itself.
    expect(calls.execute).toBe(0);
    expect((await ledgerOf(platform.pool, taskId)).decisions).toHaveLength(1);

    const seen: ModelRequest[] = [];
    const next = await worker({ capabilities, policy: WRITES, script: sequence([(r) => (seen.push(r), complete('done', contextOf(r).observations.map((o) => o.observationId)))]) });
    await next.platform.worker.runOnce();
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.proposals).toEqual(initial.proposals);
    expect(ledger.decisions[0]).toEqual(initial.decisions[0]);
    expect(ledger.decisions.map((d) => [d.outcome, d.reasonCode])).toEqual([['require_approval', 'risk_class_requires_approval'], ['allow', 'human_approved']]);
    expect(calls.execute).toBe(1);
    expect(ledger.receipts).toEqual([expect.objectContaining({ status: 'succeeded', proposalId: initial.proposals[0]!.proposalId })]);
    expect(await testRecord(platform.pool, 'approved')).toMatchObject({ writeCount: 1 });
    expect(contextOf(seen[0]!).observations.map((o) => o.outcome)).toEqual(['rejected', 'succeeded']);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
  });

  it('reject: nothing executes, and the next run observes "this action was rejected" linked to the proposal and the request', async () => {
    const { calls, capabilities } = irreversible();
    const taskId = await createActionTask(platform);
    const first = await worker({ capabilities, policy: WRITES, script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'rejected', value: 'one' })]) });
    await first.platform.worker.runOnce();
    const proposalId = (await ledgerOf(platform.pool, taskId)).proposals[0]!.proposalId;
    const request = (await platform.temporal.inspect(taskId)).humans[0]!;
    await platform.temporal.respondHuman(request.requestId, { responseKey: 'decision', outcome: 'reject', content: 'Not this record.' }, HUMAN);

    const seen: ModelRequest[] = [];
    const next = await worker({ capabilities, policy: WRITES, script: sequence([(r) => (seen.push(r), complete('chose another path'))]) });
    await next.platform.worker.runOnce();
    expect(calls.execute).toBe(0);
    expect(await testRecord(platform.pool, 'rejected')).toBeNull();
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.decisions.map((d) => d.outcome)).toEqual(['require_approval']);
    expect(ledger.executions).toEqual([]);
    const observations = items(seen[0]!, 'observations').map((i) => i.content as { action?: { proposalId: string; approvalRequestId?: string }; error: { code: string; details: Record<string, unknown> } | null });
    const rejection = observations.find((o) => o.error?.code === 'approval_rejected')!;
    expect(rejection.action).toEqual({ proposalId, receiptId: null, approvalRequestId: request.requestId });
    expect(rejection.error!.details).toMatchObject({ approvalRequestId: request.requestId, proposalId, decision: 'rejected', decidedBy: 'operator-one' });
    // The human's note is conversational context linked to the same proposal.
    expect(items(seen[0]!, 'conversation').map((i) => i.content)).toContainEqual(expect.objectContaining({ text: 'Not this record.', interaction: expect.objectContaining({ kind: 'approval', proposalId, outcome: 'reject' }) }));
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
  });

  it('approval cannot bypass policy: a stricter policy, or a changed capability version, at re-evaluation denies — nothing executes', async () => {
    const stricter = { policyId: 'stricter-after-approval', version: 2, riskClasses: { REVERSIBLE_WRITE: { autonomy: 'allow' as const }, IRREVERSIBLE_WRITE: { autonomy: 'deny' as const }, FINANCIAL: { autonomy: 'deny' as const }, EXTERNAL_COMMUNICATION: { autonomy: 'deny' as const }, PRIVILEGED: { autonomy: 'deny' as const } } };
    const cases = [
      { name: 'policy', expectCode: 'risk_class_not_permitted', worker: (calls: ReturnType<typeof handlerCalls>) => ({ capabilities: actionCapabilities(platform.pool, { riskClass: 'IRREVERSIBLE_WRITE', calls }), actionPolicy: stricter }) },
      {
        name: 'capability-version',
        expectCode: 'approval_scope_mismatch',
        worker: (calls: ReturnType<typeof handlerCalls>) => {
          const registry = new CapabilityRegistry();
          const v1 = testLedgerCapability(platform.pool, { riskClass: 'IRREVERSIBLE_WRITE', calls });
          registry.registerWrite({ ...v1, definition: { ...v1.definition, version: 2 } });
          return { capabilities: registry };
        },
      },
    ];
    for (const scenario of cases) {
      const calls = handlerCalls();
      const taskId = await createActionTask(platform);
      await (await worker({ capabilities: irreversible(calls).capabilities, policy: WRITES, script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: `bypass-${scenario.name}`, value: 'x' })]) })).platform.worker.runOnce();
      const request = (await platform.temporal.inspect(taskId)).humans[0]!;
      await platform.temporal.respondHuman(request.requestId, { responseKey: 'ok', outcome: 'approve', content: 'Approved.' }, HUMAN);
      const seen: ModelRequest[] = [];
      await (await worker({ ...scenario.worker(calls), policy: WRITES, script: sequence([(r) => (seen.push(r), complete('denied after approval'))]) })).platform.worker.runOnce();
      const ledger = await ledgerOf(platform.pool, taskId);
      expect(ledger.decisions.map((d) => d.outcome), scenario.name).toEqual(['require_approval', 'deny']);
      expect(ledger.decisions[1]!.reasonCode, scenario.name).toBe(scenario.expectCode);
      expect(ledger.executions, scenario.name).toEqual([]);
      expect(calls.execute, scenario.name).toBe(0);
      expect(contextOf(seen[0]!).observations.map((o) => o.error?.code), scenario.name).toEqual(['approval_required', 'policy_denied']);
    }
  });

  it('approve/reject race: exactly one effective terminal decision', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ capabilities: irreversible().capabilities, policy: WRITES, script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'race', value: 'one' })]) });
    await w.platform.worker.runOnce();
    const request = (await platform.temporal.inspect(taskId)).humans[0]!;
    const answers = await Promise.allSettled((['approve', 'reject'] as const).map((outcome) => platform.temporal.respondHuman(request.requestId, { responseKey: outcome, outcome, content: 'Decision.' }, HUMAN)));
    expect(answers.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(answers.filter((r) => r.status === 'rejected').map((r) => ((r).reason as { code: string }).code)).toEqual(['human_request_terminal']);
    expect((await platform.temporal.inspect(taskId)).events.filter((e) => e.type === 'approval.approved' || e.type === 'approval.rejected')).toHaveLength(1);
  });

  it('withdrawn approval request (cancel) is observed as approval_cancelled; nothing executes', async () => {
    const { calls, capabilities } = irreversible();
    const taskId = await createActionTask(platform);
    await (await worker({ capabilities, policy: WRITES, script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'withdrawn', value: 'one' })]) })).platform.worker.runOnce();
    const request = (await platform.temporal.inspect(taskId)).humans[0]!;
    await platform.temporal.respondHuman(request.requestId, { responseKey: 'w', outcome: 'cancel', content: 'Withdrawn: out of scope.' }, HUMAN);
    const seen: ModelRequest[] = [];
    await (await worker({ capabilities, policy: WRITES, script: sequence([(r) => (seen.push(r), complete('ok'))]) })).platform.worker.runOnce();
    expect(contextOf(seen[0]!).observations.map((o) => o.error?.code)).toEqual(['approval_required', 'approval_cancelled']);
    expect(calls.execute).toBe(0);
  });
});

describe('handoff', () => {
  it('agent-requested: the human owns the task, the agent cannot act as owner, release resumes it with the human period in context', async () => {
    const taskId = await createActionTask(platform);
    // R4-J1E-R2.2: a reply would end the turn, so the agent hands off without one.
    const w = await worker({ script: sequence([handoff('The requester needs human judgment on the constraint.')]) });
    await w.platform.worker.runOnce();
    const request = (await platform.temporal.inspect(taskId)).humans[0]!;
    expect((await platform.tasks.getTask(taskId)).task).toMatchObject({ status: 'blocked', statusReason: 'human_handoff' });
    await platform.temporal.respondHuman(request.requestId, { responseKey: 'take', outcome: 'accept', content: 'I own this now.' }, HUMAN);
    expect((await platform.temporal.inspect(taskId)).ownership).toMatchObject({ owner: 'human', humanRef: 'operator-one', blockedBy: ['human_handoff'] });

    // During human ownership: input is durable, yet no autonomous claim and no model call.
    await platform.temporal.submitInput(taskId, input('human-period', 'Participant clarified the constraint to the operator.'), PARTICIPANT, 'human-period');
    expect(await w.platform.worker.runOnce()).toEqual({ kind: 'idle' });
    expect(w.provider.callCount).toBe(1);
    await expect(platform.pool.query("update agent_tasks set status = 'running' where task_id = $1", [taskId])).rejects.toMatchObject({ code: '55000' });
    await expect(platform.temporal.respondHuman(request.requestId, { responseKey: 'wrong', outcome: 'release', content: 'Return.' }, OTHER_HUMAN)).rejects.toMatchObject({ code: 'human_owner_mismatch' });

    await platform.temporal.respondHuman(request.requestId, { responseKey: 'release', outcome: 'release', content: 'Constraint clarified; continue autonomously.' }, HUMAN);
    const seen: ModelRequest[] = [];
    const next = await worker({ script: sequence([(r) => (seen.push(r), complete('resumed'))]) });
    await next.platform.worker.runOnce();
    const conversation = JSON.stringify(items(seen[0]!, 'conversation'));
    for (const said of ['The requester needs human judgment on the constraint.', 'I own this now.', 'Participant clarified the constraint to the operator.', 'Constraint clarified; continue autonomously.']) {
      expect(conversation).toContain(said);
    }
    expect(items(seen[0]!, 'episodicMemory').map((i) => i.content)).toContainEqual(expect.objectContaining({ event: 'task.wait', kind: 'WAIT_FOR_HUMAN', resolution: 'human' }));
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
    expect(await events(taskId, 'task.woken')).toHaveLength(1);
  });

  it('operator-initiated takeover of a working agent: the run stops at its next fenced write, no autonomous work until release', async () => {
    const taskId = await createActionTask(platform);
    let takenOver: Promise<unknown> | null = null;
    const w = await worker({
      script: sequence([
        async () => {
          // The model is mid-decision when a human takes the task.
          takenOver = platform.temporal.takeOver(taskId, { responseKey: 'takeover-1', note: 'Taking this one: sensitive request.' }, HUMAN);
          await takenOver;
          return respond('This must never be recorded.');
        },
      ]),
    });
    const cycle = await w.platform.worker.runOnce();
    expect(cycle).toMatchObject({ kind: 'executed', outcome: { kind: 'interrupted' } });
    const runs = (await platform.tasks.getTask(taskId)).runs;
    expect(runs.map((r) => r.status)).toEqual(['suspended']);
    const steps = await new PostgresExecutionStore(platform.pool).transaction((uow) => uow.listRunSteps(runs[0]!.runId));
    expect(steps).toEqual([]);
    const { humans, ownership } = await platform.temporal.inspect(taskId);
    expect(humans[0]).toMatchObject({ kind: 'handoff', status: 'active', humanRef: 'operator-one', payload: { initiatedBy: 'operator' } });
    expect(ownership).toMatchObject({ owner: 'human', blockedBy: ['human_handoff'] });
    // Idempotent on its key; a second, different takeover is refused.
    expect((await platform.temporal.takeOver(taskId, { responseKey: 'takeover-1', note: 'Taking this one: sensitive request.' }, HUMAN)).requestId).toBe(humans[0]!.requestId);
    await expect(platform.temporal.takeOver(taskId, { responseKey: 'takeover-2', note: 'Me too.' }, OTHER_HUMAN)).rejects.toMatchObject({ code: 'handoff_already_active' });
    expect(await w.platform.worker.runOnce()).toEqual({ kind: 'idle' });

    await platform.temporal.respondHuman(humans[0]!.requestId, { responseKey: 'release', outcome: 'release', content: 'Handled the sensitive part; carry on.' }, HUMAN);
    const seen: ModelRequest[] = [];
    await (await worker({ script: sequence([(r) => (seen.push(r), complete('back'))]) })).platform.worker.runOnce();
    const conversation = JSON.stringify(items(seen[0]!, 'conversation'));
    expect(conversation).toContain('Taking this one: sensitive request.');
    expect(conversation).toContain('Handled the sensitive part; carry on.');
    expect(conversation).not.toContain('This must never be recorded.');
  });

  it('the handoff gate holds on its own: even with the human wait layer bypassed, nothing makes the agent owner', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([waitInput()]) });
    await w.platform.worker.runOnce();
    await platform.temporal.takeOver(taskId, { responseKey: 'gate', note: 'Mine.' }, HUMAN);
    // Simulate a defect elsewhere: the WAIT_FOR_HUMAN wait is closed without a release.
    await platform.pool.query("update task_waits set status = 'completed', resolution = 'human', completed_at = r4_now() where task_id = $1 and status = 'waiting'", [taskId]);
    // Database guard: no transition to running while a human owns the task.
    await expect(platform.pool.query("update agent_tasks set status = 'running' where task_id = $1", [taskId])).rejects.toMatchObject({ code: '55000' });
    // Runtime guard: a wake is refused while the handoff is active.
    const task = (await platform.tasks.getTask(taskId)).task;
    const stale = (await platform.temporal.inspect(taskId)).waits[0]!;
    const woken = await platform.temporal.write(async (uow, events) => platform.temporal.wakeWithin(uow, task, stale, 'input', new Date().toISOString(), events));
    expect(woken.status).toBe('blocked');
    expect(await w.platform.execution.claimNext({ workerId: 'zombie', leaseDurationMs: 60_000 })).toBeNull();
    expect((await platform.temporal.inspect(taskId)).ownership.owner).toBe('human');
  });

  it('takeover of a waiting task supersedes the wait and its timer', async () => {
    const taskId = await createActionTask(platform);
    await (await worker({ script: sequence([waitUntil(new Date(Date.now() + 3_600_000).toISOString())]) })).platform.worker.runOnce();
    await platform.temporal.takeOver(taskId, { responseKey: 't', note: 'Operator takes over.' }, HUMAN);
    expect(await waitRows(platform.pool, taskId)).toEqual([
      { kind: 'WAIT_UNTIL', status: 'cancelled', resolution: 'handoff' },
      { kind: 'WAIT_FOR_HUMAN', status: 'waiting', resolution: null },
    ]);
    expect((await platform.temporal.inspect(taskId)).schedules.map((s) => s.status)).toEqual(['cancelled']);
  });

  it('race: agent wake/claims vs operator takeover — once the handoff is active the agent can never become owner', async () => {
    for (let round = 0; round < 5; round++) {
      const taskId = await createActionTask(platform);
      const w = await worker({ script: sequence([waitInput()]) });
      await w.platform.worker.runOnce();
      await platform.temporal.submitInput(taskId, input(`wake-${round}`), PARTICIPANT, `wake-${round}`); // runnable again
      const claimers = Array.from({ length: 4 }, (_, i) => w.platform.execution.claimNext({ workerId: `racer-${round}-${i}`, leaseDurationMs: 60_000 }).catch(() => null));
      const [takeover, ...claims] = await Promise.all([platform.temporal.takeOver(taskId, { responseKey: `t-${round}`, note: 'Mine.' }, HUMAN), ...claimers]);
      expect(takeover.status).toBe('active');
      const won = claims.flatMap((c) => (c && c.kind !== 'abandoned' ? [c] : []));
      expect(won.length).toBeLessThanOrEqual(1);
      // Whoever claimed before the takeover lost its lease: no fenced write succeeds.
      for (const claim of won) {
        await expect(w.platform.execution.recordStep(claim.lease, { runId: claim.run.runId, iteration: 1, decision: { type: 'respond', content: 'zombie' }, outcome: 'recorded', usage: { inputTokens: 0, outputTokens: 0 } })).rejects.toBeTruthy();
      }
      expect(await w.platform.execution.claimNext({ workerId: `late-${round}`, leaseDurationMs: 60_000 })).toBeNull();
      expect((await platform.tasks.getTask(taskId)).task.status).toBe('blocked');
      expect((await platform.temporal.inspect(taskId)).ownership.owner).toBe('human');
    }
  });
});

describe('cancellation of human work', () => {
  it('cancels a pending approval request: task cancelled, request cancelled, the REQUIRE_APPROVAL decision untouched', async () => {
    const taskId = await createActionTask(platform);
    await (await worker({ capabilities: irreversible().capabilities, policy: WRITES, script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'cancel-approval', value: 'x' })]) })).platform.worker.runOnce();
    const before = await ledgerOf(platform.pool, taskId);
    const cancelled = await platform.temporal.cancelTask(taskId, HUMAN);
    expect(cancelled.status).toBe('cancelled');
    const { humans, wait } = await platform.temporal.inspect(taskId);
    expect(humans.map((h) => [h.kind, h.status])).toEqual([['approval', 'cancelled']]);
    expect(wait).toBeNull();
    expect((await ledgerOf(platform.pool, taskId)).decisions).toEqual(before.decisions);
    await expect(platform.temporal.respondHuman(humans[0]!.requestId, { responseKey: 'late', outcome: 'approve', content: 'Too late.' }, HUMAN)).rejects.toMatchObject({ code: 'human_request_terminal' });
  });

  it('cancels a pending handoff request, a consultation and a timer wait durably', async () => {
    for (const decision of [handoff('Please take over.'), consult('Help?'), waitUntil('2099-01-01T00:00:00.000Z')]) {
      const taskId = await createActionTask(platform);
      await (await worker({ script: sequence([decision]) })).platform.worker.runOnce();
      await platform.temporal.cancelTask(taskId, HUMAN);
      expect((await platform.tasks.getTask(taskId)).task.status).toBe('cancelled');
      const inspected = await platform.temporal.inspect(taskId);
      expect(inspected.wait).toBeNull();
      expect(inspected.schedules.every((s) => s.status === 'cancelled')).toBe(true);
      expect(inspected.humans.every((h) => h.status === 'cancelled')).toBe(true);
      expect(inspected.ownership.owner).toBe('none');
      expect(await drain(testScheduler(platform.pool).scheduler)).toBe(0);
      // Idempotent: cancelling again changes nothing.
      expect((await platform.temporal.cancelTask(taskId, HUMAN)).status).toBe('cancelled');
    }
  });

  it('(R4-I) a trusted platform caller cancels through the same transition: the active run is fenced, attributed to the platform, no human identity', async () => {
    const PLATFORM = { note: 'retire pre-rollout conversation', actorRef: 'platform:production-control', correlationId: 'production-control:test' };
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([]) });
    const claim = await w.platform.execution.claimNext({ workerId: 'platform-cancel', leaseDurationMs: 60_000 });
    if (claim?.kind !== 'started') throw new Error(`expected a started run, got ${claim?.kind ?? 'nothing'}`);
    expect(claim.run.taskId).toBe(taskId);

    const { task, alreadyTerminal } = await platform.temporal.cancelTaskByPlatform(taskId, PLATFORM);
    expect([task.status, task.statusReason, alreadyTerminal]).toEqual(['cancelled', 'cancelled', false]);
    // Existing fencing: the worker that held the run can no longer write, and nobody can claim the task.
    await expect(w.platform.execution.recordStep(claim.lease, { runId: claim.run.runId, iteration: 1, decision: { type: 'respond', content: 'zombie' }, outcome: 'recorded', usage: { inputTokens: 0, outputTokens: 0 } })).rejects.toBeTruthy();
    expect(await w.platform.execution.claimNext({ workerId: 'late', leaseDurationMs: 60_000 })).toBeNull();
    expect((await platform.pool.query('select status from agent_runs where task_id = $1', [taskId])).rows).toEqual([{ status: 'cancelled' }]);
    expect((await platform.pool.query("select actor_kind, actor_ref, correlation_id from agent_task_transitions where task_id = $1 and to_status = 'cancelled'", [taskId])).rows).toEqual([{ actor_kind: 'system', actor_ref: PLATFORM.actorRef, correlation_id: PLATFORM.correlationId }]);
    expect(await events(taskId, 'task.cancelled')).toEqual([expect.objectContaining({ actorRef: PLATFORM.actorRef, correlationId: PLATFORM.correlationId, data: { targetStatus: 'cancelled', initiatedBy: 'platform', content: PLATFORM.note } })]);

    // Repeating it is a no-op that says so.
    const before = await platform.temporal.inspect(taskId);
    expect(await platform.temporal.cancelTaskByPlatform(taskId, PLATFORM)).toMatchObject({ task: { status: 'cancelled' }, alreadyTerminal: true });
    expect(await platform.temporal.inspect(taskId)).toEqual(before);
  });

  it('(R4-I) a platform cancellation needs a note, a valid actor and a correlation id; an unknown task fails closed', async () => {
    const taskId = await createActionTask(platform);
    for (const bad of [{ note: ' ' }, { actorRef: 'not a ref' }, { correlationId: '' }]) {
      await expect(platform.temporal.cancelTaskByPlatform(taskId, { note: 'x', actorRef: 'platform:production-control', correlationId: 'c', ...bad })).rejects.toMatchObject({ code: 'validation_failed' });
    }
    await expect(platform.temporal.cancelTaskByPlatform('00000000-0000-7000-8000-000000000000', { note: 'x', actorRef: 'platform:production-control', correlationId: 'c' })).rejects.toMatchObject({ code: 'task_not_found' });
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('pending');
  });
});
