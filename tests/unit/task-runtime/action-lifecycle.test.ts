import { describe, expect, it } from 'vitest';
import { runStatusForTermination, uuidv7, type ActionAttempt, type ActionExecution, type WriteRecoveryStrategy } from '@r4/contracts';
import { assertExecutionTransition, executionKeyFor, nextActionStep, receiptStatusFor, taskStatusForTermination } from '@r4/task-runtime';

const T0 = '2026-01-01T00:00:00.000Z';

function execution(recovery: WriteRecoveryStrategy, options: { reconcileSupported?: boolean; maxAttempts?: number; status?: ActionExecution['status'] } = {}): ActionExecution {
  const executionId = uuidv7();
  return {
    executionId,
    proposalId: uuidv7(),
    policyDecisionId: uuidv7(),
    taskId: uuidv7(),
    runId: uuidv7(),
    capabilityId: 'test.set_thing',
    capabilityVersion: 1,
    riskClass: 'REVERSIBLE_WRITE',
    executionKey: executionKeyFor(executionId),
    semantics: { recovery, reconcileSupported: options.reconcileSupported ?? true, maxAttempts: options.maxAttempts ?? 2, initialBackoffMs: 0 },
    validatedArguments: {},
    trustedContext: { taskId: uuidv7(), runId: uuidv7(), agentId: 'probe', agentVersion: 1, correlationId: 'c', grantedScopes: [], actor: { kind: 'service', ref: 's' }, identityAssurance: 'provisional' },
    correlationId: 'c',
    createdAt: T0,
    status: options.status ?? 'executing',
    version: 1,
    updatedAt: T0,
  };
}

function attempt(n: number, kind: ActionAttempt['kind'], outcome: ActionAttempt['outcome'], errorCode: string | null = null): ActionAttempt {
  return { attemptId: uuidv7(), executionId: uuidv7(), attemptNumber: n, kind, workerId: 'w', leaseGeneration: 1, startedAt: T0, finishedAt: outcome === null ? null : T0, outcome, errorCode, detail: null };
}

describe('nextActionStep: the only rule deciding the next external call', () => {
  it('first call is the execution', () => {
    expect(nextActionStep(execution('idempotent_replay', { status: 'prepared' }), [])).toEqual({ kind: 'attempt', attemptKind: 'execute', attemptNumber: 1 });
  });

  it('idempotent_replay: an unknown or unreported attempt is replayed with the same command, bounded by maxAttempts, then reconciled if possible', () => {
    const e = execution('idempotent_replay', { maxAttempts: 2 });
    expect(nextActionStep(e, [attempt(1, 'execute', null)])).toEqual({ kind: 'attempt', attemptKind: 'replay', attemptNumber: 2 });
    expect(nextActionStep(e, [attempt(1, 'execute', 'unknown', 'timeout')])).toEqual({ kind: 'attempt', attemptKind: 'replay', attemptNumber: 2 });
    expect(nextActionStep(e, [attempt(1, 'execute', 'unknown'), attempt(2, 'replay', 'unknown')])).toEqual({ kind: 'attempt', attemptKind: 'reconcile', attemptNumber: 3 });
    const noReconcile = execution('idempotent_replay', { maxAttempts: 2, reconcileSupported: false });
    expect(nextActionStep(noReconcile, [attempt(1, 'execute', 'unknown'), attempt(2, 'replay', null)])).toEqual({ kind: 'uncertain', code: 'write_outcome_uncertain' });
  });

  it('reconcile_before_retry: never executes again before reconciling', () => {
    const e = execution('reconcile_before_retry');
    expect(nextActionStep(e, [attempt(1, 'execute', null)])).toEqual({ kind: 'attempt', attemptKind: 'reconcile', attemptNumber: 2 });
    expect(nextActionStep(e, [attempt(1, 'execute', 'unknown')])).toMatchObject({ attemptKind: 'reconcile' });
    // Only a reconciliation establishing "not applied" permits another execution (same key).
    expect(nextActionStep(e, [attempt(1, 'execute', 'unknown'), attempt(2, 'reconcile', 'not_applied')])).toEqual({ kind: 'attempt', attemptKind: 'replay', attemptNumber: 3 });
  });

  it('reconciliation that cannot tell is retried within its bound, then reported as uncertain — distinguishing a failing reconciler', () => {
    const e = execution('reconcile_before_retry', { maxAttempts: 1 });
    expect(nextActionStep(e, [attempt(1, 'execute', 'unknown'), attempt(2, 'reconcile', 'unknown', 'domain_unknown')])).toEqual({ kind: 'uncertain', code: 'write_outcome_uncertain' });
    expect(nextActionStep(e, [attempt(1, 'execute', 'unknown'), attempt(2, 'reconcile', 'unknown', 'reconciliation_error')])).toEqual({ kind: 'uncertain', code: 'write_reconciliation_failure' });
    expect(nextActionStep(e, [attempt(1, 'execute', 'unknown'), attempt(2, 'reconcile', null)])).toEqual({ kind: 'uncertain', code: 'write_outcome_uncertain' });
  });

  it('not applied with no execution attempts left is a definitive, receipt-worthy outcome (not a guess)', () => {
    const e = execution('reconcile_before_retry', { maxAttempts: 1 });
    const reconciled = attempt(2, 'reconcile', 'not_applied');
    expect(nextActionStep(e, [attempt(1, 'execute', 'unknown'), reconciled])).toEqual({ kind: 'not_applied', attempt: reconciled });
  });

  it('never plans past a resolved or flagged command; a definitive attempt without receipt is corruption', () => {
    expect(nextActionStep(execution('idempotent_replay', { status: 'succeeded' }), [attempt(1, 'execute', 'applied')])).toEqual({ kind: 'resolved' });
    expect(nextActionStep(execution('idempotent_replay', { status: 'needs_reconciliation' }), [attempt(1, 'execute', null)])).toEqual({ kind: 'uncertain', code: 'write_outcome_uncertain' });
    expect(() => nextActionStep(execution('idempotent_replay'), [attempt(1, 'execute', 'applied')])).toThrow(/no receipt/);
  });

  it('is exhaustive over every attempt log up to the bound: never "execute" after attempt 1, never a new key', () => {
    const kinds: ActionAttempt['kind'][] = ['replay', 'reconcile'];
    const outcomes: ActionAttempt['outcome'][] = [null, 'unknown', 'not_applied'];
    for (const recovery of ['idempotent_replay', 'reconcile_before_retry'] as const) {
      for (const k of kinds) {
        for (const o of outcomes) {
          if (o === 'not_applied' && k !== 'reconcile') continue;
          const e = execution(recovery, { maxAttempts: 3 });
          const step = nextActionStep(e, [attempt(1, 'execute', 'unknown'), attempt(2, k, o)]);
          if (step.kind === 'attempt') {
            expect(step.attemptKind).not.toBe('execute');
            if (recovery === 'reconcile_before_retry' && step.attemptKind === 'replay') expect(o).toBe('not_applied');
          }
        }
      }
    }
  });
});

describe('execution and termination mappings', () => {
  it('receipt status of each established outcome', () => {
    expect(receiptStatusFor('applied')).toBe('succeeded');
    expect(receiptStatusFor('rejected')).toBe('rejected');
    expect(receiptStatusFor('failed')).toBe('failed');
    expect(receiptStatusFor('not_applied')).toBe('failed');
  });

  it('execution status transitions: resolved statuses are final', () => {
    expect(() => assertExecutionTransition('prepared', 'executing')).not.toThrow();
    expect(() => assertExecutionTransition('executing', 'succeeded')).not.toThrow();
    expect(() => assertExecutionTransition('executing', 'needs_reconciliation')).not.toThrow();
    expect(() => assertExecutionTransition('prepared', 'succeeded')).toThrow(/cannot go/);
    for (const final of ['succeeded', 'rejected', 'failed'] as const) {
      for (const to of ['prepared', 'executing', 'succeeded', 'rejected', 'failed', 'needs_reconciliation'] as const) {
        expect(() => assertExecutionTransition(final, to)).toThrow();
      }
    }
  });

  it('suspension reasons end the run as suspended and leave the task waiting (never terminal, never "failed")', () => {
    expect(runStatusForTermination('approval_required')).toBe('suspended');
    expect(runStatusForTermination('write_outcome_uncertain')).toBe('suspended');
    expect(taskStatusForTermination('approval_required')).toBe('requires_approval');
    expect(taskStatusForTermination('write_outcome_uncertain')).toBe('blocked');
  });

  it('the execution key is platform-generated from the durable command id and stable', () => {
    const id = uuidv7();
    expect(executionKeyFor(id)).toBe(executionKeyFor(id));
    expect(executionKeyFor(id)).toMatch(/^r4x_[0-9a-f]{32}$/);
    expect(executionKeyFor(uuidv7())).not.toBe(executionKeyFor(id));
  });
});
