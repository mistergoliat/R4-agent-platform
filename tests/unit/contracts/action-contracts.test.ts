import { describe, expect, it } from 'vitest';
import {
  actionAttemptSchema,
  actionProposalSchema,
  actionReceiptSchema,
  agentDecisionSchema,
  capabilityDefinitionSchema,
  executionKeySchema,
  identityAssuranceOf,
  observationSchema,
  policyDecisionSchema,
  proposeActionDecisionSchema,
  runStepSchema,
  runTerminationSchema,
  uuidv7,
} from '@r4/contracts';

const T0 = '2026-01-01T00:00:00.000Z';
const id = () => uuidv7();

describe('propose_action decision: intent only, no trusted fields', () => {
  it('accepts capability id, arguments and optional evidence refs', () => {
    expect(proposeActionDecisionSchema.safeParse({ type: 'propose_action', capabilityId: 'x.y', arguments: { a: 1 } }).success).toBe(true);
    expect(proposeActionDecisionSchema.safeParse({ type: 'propose_action', capabilityId: 'x.y', arguments: {}, evidenceRefs: [id()] }).success).toBe(true);
  });

  it.each(['idempotencyKey', 'executionKey', 'policyDecision', 'riskClass', 'permission', 'receipt', 'status', 'identity', 'actor', 'grantedScopes', 'leaseToken', 'approved'])('rejects a model-supplied %s', (field) => {
    const parsed = agentDecisionSchema.safeParse({ type: 'propose_action', capabilityId: 'x.y', arguments: {}, [field]: 'anything' });
    expect(parsed.success).toBe(false);
  });

  it('rejects duplicate or malformed evidence refs', () => {
    const ref = id();
    expect(proposeActionDecisionSchema.safeParse({ type: 'propose_action', capabilityId: 'x.y', arguments: {}, evidenceRefs: [ref, ref] }).success).toBe(false);
    expect(proposeActionDecisionSchema.safeParse({ type: 'propose_action', capabilityId: 'x.y', arguments: {}, evidenceRefs: ['not-a-uuid'] }).success).toBe(false);
  });
});

describe('ActionProposal / PolicyDecision / ActionAttempt / ActionReceipt schemas', () => {
  it('proposal requires the platform identifiers', () => {
    const proposal = { proposalId: id(), taskId: id(), runId: id(), stepId: id(), iteration: 1, agentId: 'probe', agentVersion: 1, capabilityId: 'x.y', arguments: {}, evidenceRefs: [], contextSnapshotId: null, leaseGeneration: 1, correlationId: 'c', createdAt: T0 };
    expect(actionProposalSchema.safeParse(proposal).success).toBe(true);
    expect(actionProposalSchema.safeParse({ ...proposal, executed: true }).success).toBe(false);
  });

  it('policy decision records outcome, reason, rule and the policy identity (id, version, hash, engine)', () => {
    const decision = {
      decisionId: id(), proposalId: id(), taskId: id(), runId: id(), agentId: 'probe', agentVersion: 1, capabilityId: 'x.y', capabilityVersion: 1, riskClass: 'REVERSIBLE_WRITE',
      outcome: 'allow', reasonCode: 'autonomous', rule: 'risk_classes.REVERSIBLE_WRITE.autonomy', message: '', policy: { policyId: 'p', version: 1, hash: 'a'.repeat(64), engineVersion: 'e' },
      identityAssurance: 'none', leaseGeneration: 1, correlationId: 'c', evaluatedAt: T0,
    };
    expect(policyDecisionSchema.safeParse(decision).success).toBe(true);
    expect(policyDecisionSchema.safeParse({ ...decision, outcome: 'maybe' }).success).toBe(false);
    expect(policyDecisionSchema.safeParse({ ...decision, policy: { ...decision.policy, hash: 'short' } }).success).toBe(false);
  });

  it('attempts: outcome recorded exactly with finishedAt; only reconciliation can say not_applied; only attempt 1 is "execute"', () => {
    const base = { attemptId: id(), executionId: id(), attemptNumber: 1, kind: 'execute', workerId: 'w', leaseGeneration: 1, startedAt: T0, finishedAt: null, outcome: null, errorCode: null, detail: null };
    expect(actionAttemptSchema.safeParse(base).success).toBe(true);
    expect(actionAttemptSchema.safeParse({ ...base, outcome: 'applied' }).success).toBe(false);
    expect(actionAttemptSchema.safeParse({ ...base, finishedAt: T0, outcome: 'not_applied' }).success).toBe(false);
    expect(actionAttemptSchema.safeParse({ ...base, attemptNumber: 2 }).success).toBe(false);
    expect(actionAttemptSchema.safeParse({ ...base, attemptNumber: 2, kind: 'reconcile', finishedAt: T0, outcome: 'not_applied' }).success).toBe(true);
  });

  it('receipts: error exactly when not succeeded; only success carries a result; the key is a platform key', () => {
    const receipt = {
      receiptId: id(), executionId: id(), proposalId: id(), taskId: id(), runId: id(), capabilityId: 'x.y', capabilityVersion: 1, executionKey: `r4x_${'a'.repeat(32)}`,
      status: 'succeeded', resourceRef: null, externalOperationRef: null, result: { v: 1 }, error: null, executedAt: T0, recordedAt: T0,
      evidence: { obtainedVia: 'execute', attemptId: id(), attemptNumber: 1, attempts: 1, replayed: false }, correlationId: 'c',
    };
    expect(actionReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(actionReceiptSchema.safeParse({ ...receipt, status: 'failed' }).success).toBe(false);
    expect(actionReceiptSchema.safeParse({ ...receipt, status: 'rejected', error: { code: 'conflict', message: '', details: null } }).success).toBe(false);
    expect(actionReceiptSchema.safeParse({ ...receipt, status: 'rejected', result: null, error: { code: 'conflict', message: '', details: null } }).success).toBe(true);
    expect(actionReceiptSchema.safeParse({ ...receipt, executionKey: 'model-chosen-key' }).success).toBe(false);
    expect(executionKeySchema.safeParse(`r4x_${'0'.repeat(32)}`).success).toBe(true);
  });
});

describe('observations and steps of actions', () => {
  const observation = (source: Record<string, unknown>, outcome: string, error: unknown = null) => ({
    observationId: id(), taskId: id(), runId: id(), agentId: 'probe', source: { kind: 'action', capabilityId: 'x.y', capabilityVersion: 1, proposalId: id(), policyDecisionId: id(), executionId: id(), receiptId: id(), ...source },
    outcome, payload: null, error, observedAt: T0, validUntil: null, provenance: {}, correlationId: 'c',
  });

  it('a succeeded action observation must reference its receipt', () => {
    expect(observationSchema.safeParse(observation({}, 'succeeded')).success).toBe(true);
    expect(observationSchema.safeParse(observation({ receiptId: null }, 'succeeded')).success).toBe(false);
  });

  it('a receipt implies an execution; an execution implies a policy decision', () => {
    const denied = { code: 'policy_denied', message: '', details: null };
    expect(observationSchema.safeParse(observation({ executionId: null, receiptId: null }, 'rejected', denied)).success).toBe(true);
    expect(observationSchema.safeParse(observation({ executionId: null }, 'rejected', denied)).success).toBe(false);
    expect(observationSchema.safeParse(observation({ policyDecisionId: null, receiptId: null }, 'rejected', denied)).success).toBe(false);
  });

  it('there is no observation error code for an unknown outcome (it is never observed as failed)', () => {
    const uncertain = observation({ executionId: id(), receiptId: null }, 'failed', { code: 'write_outcome_uncertain', message: '', details: null });
    expect(observationSchema.safeParse(uncertain).success).toBe(false);
  });

  it('a step carries a proposal id exactly for an accepted propose_action', () => {
    const decision = { type: 'propose_action', capabilityId: 'x.y', arguments: {} };
    const base = { stepId: id(), runId: id(), taskId: id(), iteration: 1, leaseGeneration: 1, invocationId: null, observationId: null, contextSnapshotId: null, usage: { inputTokens: 0, outputTokens: 0 }, correlationId: 'c', createdAt: T0 };
    expect(runStepSchema.safeParse({ ...base, decision, outcome: 'pending', error: null, proposalId: id(), completedAt: null }).success).toBe(true);
    expect(runStepSchema.safeParse({ ...base, decision, outcome: 'pending', error: null, proposalId: null, completedAt: null }).success).toBe(false);
    expect(runStepSchema.safeParse({ ...base, decision, outcome: 'refused', error: { code: 'budget_exhausted', message: '' }, proposalId: id(), completedAt: T0 }).success).toBe(false);
    expect(runStepSchema.safeParse({ ...base, decision, outcome: 'refused', error: { code: 'budget_exhausted', message: '' }, proposalId: null, completedAt: T0 }).success).toBe(true);
  });
});

describe('termination and capability metadata', () => {
  it('suspension reasons are structured, with their own failure class', () => {
    expect(runTerminationSchema.safeParse({ reason: 'approval_required', failureClass: null, code: 'risk_class_requires_approval', message: '', details: null }).success).toBe(true);
    expect(runTerminationSchema.safeParse({ reason: 'write_outcome_uncertain', failureClass: 'action', code: 'write_reconciliation_failure', message: '', details: null }).success).toBe(true);
    expect(runTerminationSchema.safeParse({ reason: 'write_outcome_uncertain', failureClass: 'platform', code: 'x', message: '', details: null }).success).toBe(false);
  });

  it('write recovery is declared only by key-required writes', () => {
    const base = {
      capabilityId: 'x.y', version: 1, description: 'd', owner: 'o', riskClass: 'REVERSIBLE_WRITE', requiredScopes: ['s'], identityRequirement: 'none', confirmationPolicy: 'none', approvalPolicy: 'none',
      idempotency: 'key_required', retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 }, timeoutMs: 1, freshnessTtlMs: null, auditLevel: 'full', inputSchema: {}, outputSchema: {},
    };
    expect(capabilityDefinitionSchema.safeParse({ ...base, writeRecovery: 'idempotent_replay' }).success).toBe(true);
    expect(capabilityDefinitionSchema.safeParse({ ...base, idempotency: 'unsupported', writeRecovery: 'idempotent_replay' }).success).toBe(false);
    expect(capabilityDefinitionSchema.safeParse({ ...base, riskClass: 'READ', idempotency: 'inherent', writeRecovery: 'idempotent_replay' }).success).toBe(false);
  });

  it('identity assurance comes from the resolved principal only; nothing is verified yet', () => {
    expect(identityAssuranceOf({ kind: 'unauthenticated', ref: 'anonymous' })).toBe('none');
    for (const kind of ['user', 'service', 'agent', 'system'] as const) expect(identityAssuranceOf({ kind, ref: 'x' })).toBe('provisional');
  });
});
