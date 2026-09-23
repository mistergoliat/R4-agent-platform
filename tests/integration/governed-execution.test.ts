import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Platform } from '@r4/api';
import type { ModelRequest } from '@r4/model-gateway';
import { PostgresActionLedgerStore } from '@r4/persistence-postgres';
import { DEFAULT_ACTION_POLICY } from '@r4/policy-engine';
import { GET_TEST_FACT_ID } from '../fixtures/capabilities/get-test-fact.js';
import { SET_TEST_RECORD_ID, ensureTestLedger, handlerCalls, ledgerOperations, seedTestRecord, testRecord } from '../fixtures/capabilities/test-ledger.js';
import { WRITES, actionCapabilities, createActionTask, ledgerOf, startActionPlatform } from '../support/actions.js';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { complete, compiledOf, contextOf, propose, read, respond, sequence, type ScriptEntry } from '../support/decisions.js';
import { captureLogs } from '../support/logs.js';
import { observationsOf, startTestWorker, stepsOf, type TestWorker } from '../support/worker.js';

/**
 * R4-D governed execution against real PostgreSQL:
 *
 *   model propose_action → proposal (durable) → Policy Engine → decision
 *   → command (platform key) → attempt → write handler → receipt
 *   → observation → next ContextSnapshot → model → complete
 */

let db: TestDatabase;
let platform: Platform;
const workers: TestWorker[] = [];

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  platform = await startActionPlatform(db.url);
  await ensureTestLedger(platform.pool);
});

afterEach(async () => {
  while (workers.length > 0) await workers.pop()!.platform.close();
});

afterAll(async () => {
  await platform?.close();
  await db?.drop();
});

async function worker(options: Omit<Parameters<typeof startTestWorker>[1], 'workerId'> & { workerId?: string }): Promise<TestWorker> {
  const started = await startTestWorker(db.url, { workerId: options.workerId ?? `w-${workers.length + 1}`, ...options });
  workers.push(started);
  return started;
}

async function runToEnd(w: TestWorker) {
  for (;;) {
    const cycle = await w.platform.worker.runOnce();
    if (cycle.kind === 'executed') return cycle;
    if (cycle.kind === 'idle') throw new Error('no task claimed');
  }
}

/** Completes citing every observation the model was shown. */
function completeCiting(summary: string): ScriptEntry {
  return (request: ModelRequest) => complete(summary, contextOf(request).observations.map((o) => o.observationId));
}

describe('probe scenario: propose → allow → execute once → receipt → observation → complete', () => {
  it('runs the whole governed path end to end', async () => {
    const logs = captureLogs('governed-it');
    const calls = handlerCalls();
    const taskId = await createActionTask(platform, { correlationId: 'probe-scenario', input: { recordKey: 'probe', value: 'v1' } });
    const w = await worker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'probe', value: 'v1' }), completeCiting('record set')]),
      capabilities: actionCapabilities(platform.pool, { calls }),
      policy: WRITES,
      logger: logs.logger,
    });

    const cycle = await runToEnd(w);
    expect(cycle.outcome).toEqual({ kind: 'terminated', termination: expect.objectContaining({ reason: 'completed' }) });

    // Domain: exactly one effect, applied with the platform's execution key.
    expect(await testRecord(platform.pool, 'probe')).toMatchObject({ value: 'v1', version: 1, writeCount: 1 });
    expect(calls.execute).toBe(1);

    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.proposals).toHaveLength(1);
    expect(ledger.decisions).toEqual([expect.objectContaining({ outcome: 'allow', riskClass: 'REVERSIBLE_WRITE', reasonCode: 'autonomous', capabilityId: SET_TEST_RECORD_ID, identityAssurance: 'provisional' })]);
    expect(ledger.decisions[0]!.policy).toMatchObject({ policyId: DEFAULT_ACTION_POLICY.policyId, version: 1, engineVersion: 'r4.policy-engine.v1' });
    expect(ledger.executions).toEqual([expect.objectContaining({ status: 'succeeded', proposalId: ledger.proposals[0]!.proposalId, policyDecisionId: ledger.decisions[0]!.decisionId })]);
    const execution = ledger.executions[0]!;
    expect(execution.executionKey).toMatch(/^r4x_[0-9a-f]{32}$/);
    expect(calls.keys).toEqual([execution.executionKey]);
    expect((await ledgerOperations(platform.pool)).filter((o) => o.executionKey === execution.executionKey)).toEqual([{ executionKey: execution.executionKey, recordKey: 'probe', outcome: 'applied' }]);
    expect(ledger.attempts).toEqual([expect.objectContaining({ attemptNumber: 1, kind: 'execute', outcome: 'applied', workerId: 'w-1', leaseGeneration: 1 })]);
    expect(ledger.receipts).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        executionKey: execution.executionKey,
        resourceRef: 'test-record:probe',
        externalOperationRef: 'test-op:v1',
        result: { recordKey: 'probe', version: 1, value: 'v1' },
        error: null,
        evidence: expect.objectContaining({ obtainedVia: 'execute', attemptNumber: 1, attempts: 1, replayed: false }),
      }),
    ]);

    // The observation is receipt-backed, reached the next model call, and is the completion's evidence.
    const [observation] = await observationsOf(platform.pool, taskId);
    expect(observation).toMatchObject({
      outcome: 'succeeded',
      source: { kind: 'action', capabilityId: SET_TEST_RECORD_ID, proposalId: ledger.proposals[0]!.proposalId, executionId: execution.executionId, receiptId: ledger.receipts[0]!.receiptId },
      payload: { receiptId: ledger.receipts[0]!.receiptId, status: 'succeeded', result: { recordKey: 'probe', version: 1, value: 'v1' } },
      validUntil: null,
    });
    const second = w.provider.requests[1]!;
    expect(contextOf(second).observations.map((o) => o.observationId)).toEqual([observation!.observationId]);
    expect(compiledOf(second).sections.observations[0]!.content).toMatchObject({ action: { proposalId: ledger.proposals[0]!.proposalId, receiptId: ledger.receipts[0]!.receiptId } });
    const run = (await platform.tasks.getTask(taskId)).runs[0]!;
    expect((await stepsOf(platform.pool, run.runId)).map((s) => [s.iteration, s.decision?.type, s.outcome, s.proposalId !== null, s.observationId])).toEqual([
      [1, 'propose_action', 'observed', true, observation!.observationId],
      [2, 'complete', 'recorded', false, null],
    ]);
    expect((await platform.tasks.getRun(run.runId)).result).toMatchObject({ summary: 'record set', evidence: [observation!.observationId] });
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');

    // Telemetry covers every stage, with metadata only.
    for (const name of ['action.proposed', 'policy.evaluated', 'action.command.created', 'action.execution.started', 'action.attempt.recorded', 'action.receipt.persisted', 'action.observation.persisted']) {
      expect(logs.events(name), name).toHaveLength(1);
      expect(logs.events(name)[0], name).toMatchObject({ taskId, runId: run.runId, agentId: 'action-probe', proposalId: ledger.proposals[0]!.proposalId, correlationId: 'probe-scenario' });
    }
    expect(logs.events('action.receipt.persisted')[0]).toMatchObject({ executionId: execution.executionId, capabilityId: SET_TEST_RECORD_ID, riskClass: 'REVERSIBLE_WRITE', attempt: 1, workerId: 'w-1', status: 'succeeded' });
    expect(logs.raw()).not.toContain('"v1"');
  });
});

describe('policy outcomes', () => {
  it('DENY: observation of the denial, nothing executed, the agent continues and can replan', async () => {
    const calls = handlerCalls();
    const taskId = await createActionTask(platform);
    const w = await worker({
      script: sequence([propose('platform_test.privileged_record', { recordKey: 'denied', value: 'x' }), completeCiting('could not')]),
      capabilities: actionCapabilities(platform.pool, {}, [{ capabilityId: 'platform_test.privileged_record', riskClass: 'PRIVILEGED', calls }]),
      policy: WRITES,
    });
    const cycle = await runToEnd(w);
    expect(cycle.outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'completed' } });
    expect(calls.execute).toBe(0);
    expect(await testRecord(platform.pool, 'denied')).toBeNull();
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.decisions).toEqual([expect.objectContaining({ outcome: 'deny', reasonCode: 'risk_class_not_permitted', riskClass: 'PRIVILEGED' })]);
    expect(ledger.executions).toEqual([]);
    expect(ledger.receipts).toEqual([]);
    const [observation] = await observationsOf(platform.pool, taskId);
    expect(observation).toMatchObject({ outcome: 'rejected', error: { code: 'policy_denied', details: { reasonCode: 'risk_class_not_permitted' } }, source: { kind: 'action', executionId: null, receiptId: null } });
    expect(contextOf(w.provider.requests[1]!).observations[0]).toMatchObject({ outcome: 'rejected', error: { code: 'policy_denied' } });
  });

  it('REQUIRE_APPROVAL: nothing executes; decision + observation durable; run suspended, task requires_approval, lease released', async () => {
    const calls = handlerCalls();
    const taskId = await createActionTask(platform);
    const w = await worker({
      script: sequence([propose('platform_test.irreversible_record', { recordKey: 'approval', value: 'x' })]),
      capabilities: actionCapabilities(platform.pool, {}, [{ capabilityId: 'platform_test.irreversible_record', riskClass: 'IRREVERSIBLE_WRITE', calls }]),
      policy: WRITES,
    });
    const cycle = await runToEnd(w);
    expect(cycle.outcome).toEqual({ kind: 'terminated', termination: { reason: 'approval_required', code: 'risk_class_requires_approval', message: expect.any(String), details: expect.objectContaining({ riskClass: 'IRREVERSIBLE_WRITE' }) } });
    expect(calls.execute).toBe(0);
    expect(await testRecord(platform.pool, 'approval')).toBeNull();
    expect(w.provider.callCount).toBe(1);

    const view = await platform.tasks.getTask(taskId);
    expect(view.task).toMatchObject({ status: 'requires_approval', statusReason: 'approval_required' });
    const run = await platform.tasks.getRun(view.runs[0]!.runId);
    expect(run).toMatchObject({ status: 'suspended', termination: { reason: 'approval_required', failureClass: null }, failure: null });
    const lease = await platform.pool.query('select lease_owner from agent_tasks where task_id = $1', [taskId]);
    expect(lease.rows[0]).toEqual({ lease_owner: null });

    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.decisions).toEqual([expect.objectContaining({ outcome: 'require_approval', reasonCode: 'risk_class_requires_approval' })]);
    expect(ledger.executions).toEqual([]);
    const [observation] = await observationsOf(platform.pool, taskId);
    expect(observation).toMatchObject({ outcome: 'rejected', error: { code: 'approval_required' }, source: { policyDecisionId: ledger.decisions[0]!.decisionId } });
    // Nothing claims it: requires_approval is not claimable, and the approval workflow is R4-E.
    expect(await w.platform.worker.runOnce()).toEqual({ kind: 'idle' });
  });

  it('approval required by the capability itself, and FINANCIAL without verified identity is denied', async () => {
    const taskA = await createActionTask(platform);
    const a = await worker({
      script: sequence([propose('platform_test.approved_record', { recordKey: 'cap-approval', value: 'x' })]),
      capabilities: actionCapabilities(platform.pool, {}, [{ capabilityId: 'platform_test.approved_record', approvalPolicy: 'required' }]),
      policy: WRITES,
    });
    expect((await runToEnd(a)).outcome).toMatchObject({ termination: { reason: 'approval_required', code: 'capability_requires_approval' } });
    expect((await ledgerOf(platform.pool, taskA)).executions).toEqual([]);

    const taskB = await createActionTask(platform);
    const b = await worker({
      script: sequence([propose('platform_test.financial_record', { recordKey: 'money', value: 'x' }), completeCiting('denied')]),
      capabilities: actionCapabilities(platform.pool, {}, [{ capabilityId: 'platform_test.financial_record', riskClass: 'FINANCIAL' }]),
      policy: WRITES,
    });
    expect((await runToEnd(b)).outcome).toMatchObject({ termination: { reason: 'completed' } });
    expect((await ledgerOf(platform.pool, taskB)).decisions).toEqual([expect.objectContaining({ outcome: 'deny', reasonCode: 'insufficient_identity', riskClass: 'FINANCIAL', identityAssurance: 'provisional' })]);
    expect(await testRecord(platform.pool, 'money')).toBeNull();
  });

  it('missing trusted identity requirement → DENY (unauthenticated requester)', async () => {
    const taskId = await createActionTask(platform, { requestedBy: { kind: 'unauthenticated', ref: 'anonymous' } });
    const w = await worker({
      script: sequence([propose('platform_test.identified_record', { recordKey: 'identity', value: 'x' }), completeCiting('denied')]),
      capabilities: actionCapabilities(platform.pool, {}, [{ capabilityId: 'platform_test.identified_record', identityRequirement: 'provisional' }]),
      policy: WRITES,
    });
    await runToEnd(w);
    expect((await ledgerOf(platform.pool, taskId)).decisions).toEqual([expect.objectContaining({ outcome: 'deny', reasonCode: 'identity_requirement_unmet', identityAssurance: 'none' })]);
    expect(await testRecord(platform.pool, 'identity')).toBeNull();
  });

  it('a write capability without write handlers (unsafe semantics) is visible but never executes', async () => {
    const taskId = await createActionTask(platform);
    const registry = actionCapabilities(platform.pool);
    let executed = 0;
    registry.register({
      definition: {
        capabilityId: 'platform_test.unkeyed_write',
        version: 1,
        description: 'A write registered without replay/reconciliation semantics. Test-only.',
        owner: 'platform-test',
        riskClass: 'REVERSIBLE_WRITE',
        requiredScopes: ['platform_test.write'],
        identityRequirement: 'none',
        confirmationPolicy: 'none',
        approvalPolicy: 'none',
        idempotency: 'unsupported',
        retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
        timeoutMs: 1_000,
        freshnessTtlMs: null,
        auditLevel: 'full',
      },
      input: (await import('zod')).z.object({}),
      output: (await import('zod')).z.object({}),
      handler: () => {
        executed += 1;
        return Promise.resolve({});
      },
    });
    const w = await worker({ script: sequence([propose('platform_test.unkeyed_write', {}), completeCiting('no')]), capabilities: registry, policy: WRITES });
    await runToEnd(w);
    expect(executed).toBe(0);
    expect((await ledgerOf(platform.pool, taskId)).decisions).toEqual([expect.objectContaining({ outcome: 'deny', reasonCode: 'unsafe_write_semantics' })]);
  });

  it('the policy version and hash of every historical decision stay explainable after the policy changes', async () => {
    const custom = { ...DEFAULT_ACTION_POLICY, version: 2, riskClasses: { ...DEFAULT_ACTION_POLICY.riskClasses, REVERSIBLE_WRITE: { autonomy: 'deny' as const } } };
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'v2-policy', value: 'x' }), completeCiting('denied')]), capabilities: actionCapabilities(platform.pool), policy: WRITES, actionPolicy: custom });
    await runToEnd(w);
    const [decision] = (await ledgerOf(platform.pool, taskId)).decisions;
    expect(decision).toMatchObject({ outcome: 'deny', reasonCode: 'risk_class_not_permitted', rule: 'risk_classes.REVERSIBLE_WRITE.autonomy', policy: { policyId: 'r4-default-action-policy', version: 2 } });
    const rows = await platform.pool.query<{ policy_version: number; policy_hash: string }>('select distinct policy_version, policy_hash from policy_decisions order by policy_version');
    // Decisions under v1 and v2 coexist, each with its own hash.
    expect(rows.rows.map((r) => r.policy_version)).toEqual([1, 2]);
    expect(new Set(rows.rows.map((r) => r.policy_hash)).size).toBe(2);
  });
});

describe('validation, evidence and budget', () => {
  it('invalid arguments → write_validation_failure observation (no policy, no command); the agent continues', async () => {
    const calls = handlerCalls();
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'BAD KEY', value: 1 }), completeCiting('invalid')]), capabilities: actionCapabilities(platform.pool, { calls }), policy: WRITES });
    expect((await runToEnd(w)).outcome).toMatchObject({ termination: { reason: 'completed' } });
    expect(calls.execute).toBe(0);
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.proposals).toHaveLength(1);
    expect(ledger.decisions).toEqual([]);
    const [observation] = await observationsOf(platform.pool, taskId);
    expect(observation).toMatchObject({ outcome: 'rejected', error: { code: 'write_validation_failure', details: { cause: 'invalid_arguments' } }, source: { policyDecisionId: null } });
  });

  it('evidence references must be observations of this task; a real one is recorded on the proposal', async () => {
    const other = await createActionTask(platform);
    const foreign = await worker({ script: sequence([read(GET_TEST_FACT_ID, { factKey: 'alpha' }), completeCiting('ok')]), capabilities: actionCapabilities(platform.pool), policy: WRITES });
    await runToEnd(foreign);
    const [foreignObservation] = await observationsOf(platform.pool, other);

    const taskId = await createActionTask(platform);
    const invented = await worker({ script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'evidence', value: 'x' }, [foreignObservation!.observationId])]), capabilities: actionCapabilities(platform.pool), policy: WRITES });
    expect((await runToEnd(invented)).outcome).toMatchObject({ termination: { reason: 'invalid_decision', code: 'unknown_evidence' } });
    expect((await ledgerOf(platform.pool, taskId)).proposals).toEqual([]);

    const good = await createActionTask(platform);
    const citing = await worker({
      script: sequence([
        read(GET_TEST_FACT_ID, { factKey: 'alpha' }),
        (request) => propose(SET_TEST_RECORD_ID, { recordKey: 'evidence', value: 'x' }, [contextOf(request).observations[0]!.observationId]),
        completeCiting('ok'),
      ]),
      capabilities: actionCapabilities(platform.pool),
      policy: WRITES,
    });
    await runToEnd(citing);
    const [readObservation] = await observationsOf(platform.pool, good);
    expect((await ledgerOf(platform.pool, good)).proposals[0]!.evidenceRefs).toEqual([readObservation!.observationId]);
  });

  it('write budget: exhausted before an additional write execution is created', async () => {
    const calls = handlerCalls();
    const taskId = await createActionTask(platform, { budget: { maxWrites: 1 } });
    const w = await worker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'budget-1', value: 'x' }), propose(SET_TEST_RECORD_ID, { recordKey: 'budget-2', value: 'y' })]),
      capabilities: actionCapabilities(platform.pool, { calls }),
      policy: WRITES,
    });
    const cycle = await runToEnd(w);
    expect(cycle.outcome).toMatchObject({ termination: { reason: 'budget_exhausted', code: 'max_write_actions', details: { dimension: 'maxWriteActions', limit: 1, used: 1 } } });
    expect(calls.execute).toBe(1);
    expect(await testRecord(platform.pool, 'budget-2')).toBeNull();
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.proposals).toHaveLength(1);
    expect(ledger.executions).toHaveLength(1);
    const run = (await platform.tasks.getTask(taskId)).runs[0]!;
    expect((await stepsOf(platform.pool, run.runId)).map((s) => [s.decision?.type, s.outcome, s.error?.code ?? null])).toEqual([
      ['propose_action', 'observed', null],
      ['propose_action', 'refused', 'budget_exhausted'],
    ]);
    // The model saw its remaining write budget.
    expect(contextOf(w.provider.requests[1]!).budget.remaining.writeActions).toBe(0);
  });

  it('with no write budget (default worker policy) write capabilities are not offered and no write can happen', async () => {
    const calls = handlerCalls();
    await createActionTask(platform);
    const w = await worker({ script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'nobudget', value: 'x' })]), capabilities: actionCapabilities(platform.pool, { calls }) });
    const cycle = await runToEnd(w);
    expect(contextOf(w.provider.requests[0]!).capabilities.map((c) => c.capabilityId)).toEqual([GET_TEST_FACT_ID]);
    expect(cycle.outcome).toMatchObject({ termination: { reason: 'budget_exhausted', code: 'max_write_actions', details: { limit: 0 } } });
    expect(calls.execute).toBe(0);
  });

  it('separate identical proposals are separate actions (no semantic dedupe); each executes once', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'twice', value: 'same' }), propose(SET_TEST_RECORD_ID, { recordKey: 'twice', value: 'same' }), completeCiting('twice')]),
      capabilities: actionCapabilities(platform.pool),
      policy: WRITES,
    });
    await runToEnd(w);
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.executions).toHaveLength(2);
    expect(new Set(ledger.executions.map((e) => e.executionKey)).size).toBe(2);
    expect(await testRecord(platform.pool, 'twice')).toMatchObject({ version: 2, writeCount: 2 });
  });
});

describe('optimistic concurrency is the domain\'s: a conflict is a structured result, never retried', () => {
  it('expectedVersion 3 against version 4 → rejected receipt, action_rejected observation, one attempt', async () => {
    await seedTestRecord(platform.pool, 'versioned', 'four', 4);
    const calls = handlerCalls();
    const taskId = await createActionTask(platform);
    const w = await worker({
      script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'versioned', value: 'stale', expectedVersion: 3 }), completeCiting('conflict seen')]),
      capabilities: actionCapabilities(platform.pool, { calls }),
      policy: WRITES,
    });
    expect((await runToEnd(w)).outcome).toMatchObject({ termination: { reason: 'completed' } });
    expect(calls.execute).toBe(1);
    expect(await testRecord(platform.pool, 'versioned')).toMatchObject({ value: 'four', version: 4, writeCount: 0 });
    const ledger = await ledgerOf(platform.pool, taskId);
    expect(ledger.attempts).toEqual([expect.objectContaining({ kind: 'execute', outcome: 'rejected', errorCode: 'version_conflict' })]);
    expect(ledger.executions[0]!.validatedArguments).toEqual({ recordKey: 'versioned', value: 'stale', expectedVersion: 3 });
    expect(ledger.receipts).toEqual([expect.objectContaining({ status: 'rejected', result: null, error: expect.objectContaining({ code: 'version_conflict', details: expect.objectContaining({ expectedVersion: 3, currentVersion: 4 }) }) })]);
    const [observation] = await observationsOf(platform.pool, taskId);
    expect(observation).toMatchObject({ outcome: 'rejected', payload: null, error: { code: 'action_rejected', details: { domainCode: 'version_conflict' } } });
    expect(contextOf(w.provider.requests[1]!).observations[0]).toMatchObject({ outcome: 'rejected', error: { code: 'action_rejected' } });
  });
});

describe('trusted context cannot be escalated by the model', () => {
  it('model-supplied identity/scopes/keys in arguments are data at most; handlers see only the platform context', async () => {
    const calls = handlerCalls();
    const taskId = await createActionTask(platform, { requestedBy: { kind: 'user', ref: 'requester-1' } });
    const smuggled = { recordKey: 'escalate', value: 'x', grantedScopes: ['platform.admin'], actor: { kind: 'system', ref: 'root' }, executionKey: 'r4x_00000000000000000000000000000000', identityAssurance: 'verified' };
    const w = await worker({ script: sequence([propose(SET_TEST_RECORD_ID, smuggled), completeCiting('rejected')]), capabilities: actionCapabilities(platform.pool, { calls }), policy: WRITES });
    await runToEnd(w);
    // The strict input schema rejects the extra fields: nothing reaches policy or the domain.
    expect(calls.execute).toBe(0);
    expect((await observationsOf(platform.pool, taskId))[0]).toMatchObject({ error: { code: 'write_validation_failure' } });

    // A decision carrying trusted fields at the decision level is not a decision at all.
    const second = await createActionTask(platform);
    const w2 = await worker({
      script: sequence([{ type: 'structured', data: { type: 'propose_action', capabilityId: SET_TEST_RECORD_ID, arguments: { recordKey: 'escalate', value: 'x' }, idempotencyKey: 'mine', policyDecision: 'allow', riskClass: 'READ' } }]),
      capabilities: actionCapabilities(platform.pool, { calls }),
      policy: WRITES,
    });
    expect((await runToEnd(w2)).outcome).toMatchObject({ termination: { reason: 'invalid_decision', code: 'invalid_decision_schema' } });
    expect((await ledgerOf(platform.pool, second)).proposals).toEqual([]);

    // A valid proposal: the handler received the platform's context, not anything the model said.
    const third = await createActionTask(platform, { requestedBy: { kind: 'user', ref: 'requester-1' } });
    const w3 = await worker({ script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'escalate', value: 'x' }), completeCiting('ok')]), capabilities: actionCapabilities(platform.pool, { calls }), policy: WRITES });
    await runToEnd(w3);
    const [context] = calls.contexts;
    expect(context!.execution).toEqual({
      taskId: third,
      runId: (await platform.tasks.getTask(third)).runs[0]!.runId,
      agentId: 'action-probe',
      agentVersion: 1,
      correlationId: 'governed-it',
      grantedScopes: ['platform_test.read', 'platform_test.write'],
      actor: { kind: 'user', ref: 'requester-1' },
      identityAssurance: 'provisional',
    });
    expect(context!.executionKey).toBe((await ledgerOf(platform.pool, third)).executions[0]!.executionKey);
  });
});

describe('immutability of the ledger (database-enforced)', () => {
  it('receipts, proposals, decisions, observations and finished attempts cannot be changed or deleted; commands are immutable', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([propose(SET_TEST_RECORD_ID, { recordKey: 'immutable', value: 'x' }), completeCiting('ok')]), capabilities: actionCapabilities(platform.pool), policy: WRITES });
    await runToEnd(w);
    const ledger = await ledgerOf(platform.pool, taskId);
    const receipt = ledger.receipts[0]!;
    const refused = async (sql: string, values: unknown[]) => {
      await expect(platform.pool.query(sql, values)).rejects.toThrow();
    };
    await refused(`update action_receipts set status = 'failed', error_code = 'x' where receipt_id = $1`, [receipt.receiptId]);
    await refused('delete from action_receipts where receipt_id = $1', [receipt.receiptId]);
    await refused(`update action_proposals set arguments = '{}' where proposal_id = $1`, [receipt.proposalId]);
    await refused(`update policy_decisions set outcome = 'deny' where proposal_id = $1`, [receipt.proposalId]);
    await refused(`update observations set outcome = 'failed', error_code = 'x' where task_id = $1`, [taskId]);
    await refused('delete from observations where task_id = $1', [taskId]);
    await refused(`update action_execution_attempts set outcome = 'failed' where attempt_id = $1`, [receipt.evidence.attemptId]);
    await refused(`update action_executions set execution_key = 'r4x_ffffffffffffffffffffffffffffffff' where execution_id = $1`, [receipt.executionId]);
    await refused(`update action_executions set validated_arguments = '{"value":"other"}' where execution_id = $1`, [receipt.executionId]);
    await refused(`update action_executions set status = 'executing' where execution_id = $1`, [receipt.executionId]);
    expect(await ledgerOf(platform.pool, taskId)).toEqual(ledger);
  });

  it('a resolved status without its receipt, an execution without ALLOW, and an unreceipted success observation are unrepresentable', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([propose('platform_test.privileged_record', { recordKey: 'nope', value: 'x' }), completeCiting('ok')]), capabilities: actionCapabilities(platform.pool, {}, [{ capabilityId: 'platform_test.privileged_record', riskClass: 'PRIVILEGED' }]), policy: WRITES });
    await runToEnd(w);
    const { proposals, decisions } = await ledgerOf(platform.pool, taskId);
    const deny = decisions[0]!;
    // No command can reference a DENY decision (composite FK on the ALLOW outcome).
    await expect(
      platform.pool.query(
        `insert into action_executions (execution_id, proposal_id, policy_decision_id, task_id, run_id, capability_id, capability_version, risk_class, execution_key,
           recovery_strategy, reconcile_supported, max_attempts, initial_backoff_ms, validated_arguments, trusted_context, status, version, correlation_id, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, $3, $4, 'platform_test.privileged_record', 1, 'PRIVILEGED', 'r4x_11111111111111111111111111111111',
           'idempotent_replay', true, 1, 0, '{}', '{}', 'succeeded', 1, 'c', now(), now())`,
        [proposals[0]!.proposalId, deny.decisionId, taskId, deny.runId],
      ),
    ).rejects.toThrow();
    // The observation for a success must reference a receipt.
    await expect(
      platform.pool.query(
        `insert into observations (observation_id, task_id, run_id, agent_id, source_kind, capability_id, outcome, observed_at, provenance, correlation_id, proposal_id)
         values (gen_random_uuid(), $1, $2, 'action-probe', 'action', 'x.y', 'succeeded', now(), '{}', 'c', gen_random_uuid())`,
        [taskId, deny.runId],
      ),
    ).rejects.toThrow();
  });
});

describe('metrics foundation', () => {
  it('derives rates, attempts, failures, uncertainty, duplicates prevented and receipt latency from the ledger', async () => {
    const metrics = await new PostgresActionLedgerStore(platform.pool).metrics();
    expect(metrics.proposals).toBeGreaterThan(5);
    expect(metrics.decisions.allow).toBeGreaterThan(0);
    expect(metrics.decisions.deny).toBeGreaterThan(0);
    expect(metrics.decisions.requireApproval).toBeGreaterThan(0);
    expect(metrics.validationRejections).toBeGreaterThan(0);
    expect(metrics.receipts.succeeded).toBeGreaterThan(0);
    expect(metrics.receipts.rejected).toBeGreaterThan(0);
    expect(metrics.attempts.execute).toBe(metrics.executions);
    expect(metrics.receiptLatencyMs.count).toBe(metrics.receipts.succeeded + metrics.receipts.rejected + metrics.receipts.failed);
    expect(metrics.receiptLatencyMs.max).toBeGreaterThanOrEqual(0);
  });
});

describe('respond and read still work next to actions', () => {
  it('interleaves read, respond and propose in one run', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({
      script: sequence([read(GET_TEST_FACT_ID, { factKey: 'alpha' }), respond('about to write'), propose(SET_TEST_RECORD_ID, { recordKey: 'mixed', value: 'x' }), completeCiting('done')]),
      capabilities: actionCapabilities(platform.pool),
      policy: WRITES,
    });
    expect((await runToEnd(w)).outcome).toMatchObject({ termination: { reason: 'completed' } });
    const observations = await observationsOf(platform.pool, taskId);
    expect(observations.map((o) => o.source.kind)).toEqual(['capability', 'action']);
    expect(contextOf(w.provider.requests[3]!).observations).toHaveLength(2);
  });
});
