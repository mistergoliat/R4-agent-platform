import { describe, expect, it } from 'vitest';
import {
  NON_RETRYABLE_MODEL_FAILURE,
  RUN_ABANDONED,
  RUN_BUDGET_EXHAUSTED,
  RUN_CAPABILITY_FAILURE,
  RUN_FAILURE_HANDOFF_REASONS,
  RUN_FAILURE_RECOVERY_EXHAUSTED,
  RUN_INTERNAL_FAILURE,
  RUN_OUTPUT_FILTERED,
  TERMINATION_REASONS,
  humanRequestSchema,
  runFailureDisposition,
  runFailureHandoffReason,
  runFailureRecoveryOf,
  type TerminationReason,
} from '@r4/contracts';
import { ExecutionOutcomeEvaluator } from '@r4/evaluation';
import { FakeModelProvider, type ModelRequest } from '@r4/model-gateway';
import { ShadowRecordingModelProvider } from '@r4/shadow';
import { DEFAULT_MAX_RUN_FAILURE_RECOVERIES, ExecutionRuntime } from '@r4/task-runtime';
import { loadWorkerConfig } from '@r4/worker';
import { createSilentLogger } from '@r4/observability';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import { SalesFixture } from '@r4-sales/agent/evaluations';

/** ADR-028 (GAP-H-001): the pieces of run-level recovery that need no database. */
describe('runFailureDisposition (contracts)', () => {
  it('recoverable: invalid_decision and retryable model_failure; human: everything else that fails (R4-J4-R7-1: no failure is terminal)', () => {
    const of = (reason: TerminationReason, details: unknown = null) => runFailureDisposition({ reason, details });
    expect(of('invalid_decision')).toBe('recoverable');
    // KC-2: the finish reason travels in the details; a truncated output is still recoverable, a filtered one is not.
    expect(of('invalid_decision', { finishReason: 'length' })).toBe('recoverable');
    expect(of('invalid_decision', { finishReason: 'stop' })).toBe('recoverable');
    expect(of('invalid_decision', { finishReason: 'content_filter' })).toBe('human');
    expect(of('model_failure', { retryable: true, latencyMs: 10 })).toBe('recoverable');
    expect(of('model_failure', { retryable: false })).toBe('human');
    // Fail closed toward a human: a missing or non-boolean classification is not retryable.
    expect(of('model_failure')).toBe('human');
    expect(of('model_failure', { retryable: 'yes' })).toBe('human');
    // ADR-028 amendment (R4-J4-R7-1): the platform contingencies hand the task to a human instead of failing it.
    for (const reason of ['capability_failure', 'budget_exhausted', 'internal_failure', 'lease_lost'] as const) expect(of(reason)).toBe('human');
    // Not failures at all: completion, cancellation and every suspension.
    for (const reason of ['completed', 'cancelled', 'approval_required', 'write_outcome_uncertain', 'waiting', 'human_handoff'] as const) expect(of(reason)).toBeNull();
    expect(TERMINATION_REASONS).toHaveLength(12); // a new reason must be classified here on purpose
  });

  it('(R4-J4-R7-1) every directly handed-off failure has its own handoff reason, and every reason is announced (ADR-041)', () => {
    expect(runFailureHandoffReason('model_failure')).toBe(NON_RETRYABLE_MODEL_FAILURE);
    expect(runFailureHandoffReason('invalid_decision')).toBe(RUN_OUTPUT_FILTERED);
    expect(runFailureHandoffReason('budget_exhausted')).toBe(RUN_BUDGET_EXHAUSTED);
    expect(runFailureHandoffReason('capability_failure')).toBe(RUN_CAPABILITY_FAILURE);
    expect(runFailureHandoffReason('internal_failure')).toBe(RUN_INTERNAL_FAILURE);
    expect(runFailureHandoffReason('lease_lost')).toBe(RUN_ABANDONED);
    expect([...RUN_FAILURE_HANDOFF_REASONS].sort()).toEqual([RUN_FAILURE_RECOVERY_EXHAUSTED, NON_RETRYABLE_MODEL_FAILURE, RUN_OUTPUT_FILTERED, RUN_BUDGET_EXHAUSTED, RUN_CAPABILITY_FAILURE, RUN_INTERNAL_FAILURE, RUN_ABANDONED].sort());
    // Each one is a valid status reason and a valid platform handoff reason.
    for (const reason of RUN_FAILURE_HANDOFF_REASONS) {
      expect(humanRequestSchema.safeParse({
        requestId: '00000000-0000-4000-8000-000000000001', taskId: '00000000-0000-4000-8000-000000000002', runId: null, kind: 'handoff', status: 'requested', humanRef: null,
        createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', expiresAt: null, correlationId: 'c', payload: { summary: 's', contextRefs: [], initiatedBy: 'platform', reason },
      }).success).toBe(true);
    }
  });

  it('reads the recorded disposition from termination details, strictly', () => {
    expect(runFailureRecoveryOf({ details: { retryable: true, runFailureRecovery: { outcome: 'continued', consecutiveFailures: 1, maxRunFailureRecoveries: 1 } } })).toEqual({ outcome: 'continued', consecutiveFailures: 1, maxRunFailureRecoveries: 1 });
    expect(runFailureRecoveryOf({ details: null })).toBeNull();
    expect(runFailureRecoveryOf(null)).toBeNull();
    expect(runFailureRecoveryOf({ details: { runFailureRecovery: { outcome: 'retry_forever', consecutiveFailures: 1, maxRunFailureRecoveries: 1 } } })).toBeNull();
    expect(runFailureRecoveryOf({ details: { runFailureRecovery: { outcome: 'continued', consecutiveFailures: 0, maxRunFailureRecoveries: 1 } } })).toBeNull();
  });
});

describe('platform-initiated handoff (contracts)', () => {
  const T = '2026-09-24T00:00:00.000Z';
  const ID = '01a0d434-3dd8-77b4-9540-73cb942a0845';
  const handoff = (payload: Record<string, unknown>) => ({ requestId: ID, taskId: ID, runId: ID, kind: 'handoff', status: 'requested', humanRef: null, createdAt: T, updatedAt: T, expiresAt: null, correlationId: 'c', payload: { summary: 's', contextRefs: [], ...payload } });

  it('`platform` carries a reason code; agent and operator handoffs never do', () => {
    expect(humanRequestSchema.safeParse(handoff({ initiatedBy: 'platform', reason: RUN_FAILURE_RECOVERY_EXHAUSTED })).success).toBe(true);
    expect(humanRequestSchema.safeParse(handoff({ initiatedBy: 'platform', reason: NON_RETRYABLE_MODEL_FAILURE })).success).toBe(true);
    expect(humanRequestSchema.safeParse(handoff({ initiatedBy: 'platform' })).success).toBe(false);
    expect(humanRequestSchema.safeParse(handoff({ initiatedBy: 'agent', reason: RUN_FAILURE_RECOVERY_EXHAUSTED })).success).toBe(false);
    expect(humanRequestSchema.safeParse(handoff({ initiatedBy: 'operator' })).success).toBe(true);
    expect(humanRequestSchema.safeParse(handoff({ initiatedBy: 'platform', reason: 'Not A Code' })).success).toBe(false);
  });
});

describe('maxRunFailureRecoveries (configuration)', () => {
  const env = { R4_DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

  it('defaults to 1, is configurable, and must be a finite non-negative integer', () => {
    expect(DEFAULT_MAX_RUN_FAILURE_RECOVERIES).toBe(1);
    expect(loadWorkerConfig(env).maxRunFailureRecoveries).toBe(1);
    expect(loadWorkerConfig({ ...env, R4_EXEC_MAX_RUN_FAILURE_RECOVERIES: '0' }).maxRunFailureRecoveries).toBe(0);
    expect(loadWorkerConfig({ ...env, R4_EXEC_MAX_RUN_FAILURE_RECOVERIES: '3' }).maxRunFailureRecoveries).toBe(3);
    expect(() => loadWorkerConfig({ ...env, R4_EXEC_MAX_RUN_FAILURE_RECOVERIES: '-1' })).toThrow();
    expect(() => loadWorkerConfig({ ...env, R4_EXEC_MAX_RUN_FAILURE_RECOVERIES: 'Infinity' })).toThrow();
    const base = { store: {} as never, ids: uuidV7Generator(), clock: systemClock, logger: createSilentLogger(), maxRunRecoveries: 3 };
    expect(() => new ExecutionRuntime({ ...base, maxRunFailureRecoveries: 1.5 })).toThrow(/maxRunFailureRecoveries/);
    expect(() => new ExecutionRuntime({ ...base, maxRunFailureRecoveries: -1 })).toThrow(/maxRunFailureRecoveries/);
    expect(() => new ExecutionRuntime(base)).not.toThrow();
  });
});

describe('Quality measures recovery (R4-G, ExecutionOutcomeEvaluator v2) and only measures it', () => {
  const metricsOf = (f: SalesFixture) => new ExecutionOutcomeEvaluator().evaluate(f.build()).metrics;
  const continued = (n: number) => ({ outcome: 'continued' as const, consecutiveFailures: n, maxRunFailureRecoveries: 1 });

  it('a recovered failure: one recoverable failed run, one recovery, one attempt', () => {
    const f = new SalesFixture({ id: 'recovered' });
    f.turn('Hola').invalid('invalid_structured_output', null, continued(1)).recoveryRun().respond('Hola, ¿en qué te ayudo?').wait();
    expect(metricsOf(f)).toMatchObject({
      recoverableRunFailures: { value: 1 },
      recoveredRunFailures: { value: 1 },
      exhaustedRecoveries: { value: 0 },
      nonRetryableHandoffs: { value: 0 },
      attemptsToRecovery: { value: 1, unit: 'count' },
    });
  });

  it('exhausted and non-retryable are counted apart; a legacy failed task has no recovery at all', () => {
    const exhausted = new SalesFixture({ id: 'exhausted' });
    exhausted.turn('Hola').invalid('invalid_structured_output', null, continued(1)).recoveryRun().invalid('unknown_evidence', null, { outcome: 'exhausted', consecutiveFailures: 2, maxRunFailureRecoveries: 1 });
    expect(metricsOf(exhausted)).toMatchObject({ recoverableRunFailures: { value: 2 }, recoveredRunFailures: { value: 0 }, exhaustedRecoveries: { value: 1 }, attemptsToRecovery: { value: null } });

    const handed = new SalesFixture({ id: 'handed-off' });
    handed.turn('Hola').modelFailure('provider_error', { outcome: 'handed_off', consecutiveFailures: null, maxRunFailureRecoveries: 1 });
    expect(metricsOf(handed)).toMatchObject({ recoverableRunFailures: { value: 0 }, nonRetryableHandoffs: { value: 1 } });

    const legacy = new SalesFixture({ id: 'legacy' });
    legacy.turn('Hola').invalid('invalid_structured_output');
    expect(metricsOf(legacy)).toMatchObject({ recoverableRunFailures: { value: 1 }, recoveredRunFailures: { value: 0 }, exhaustedRecoveries: { value: 0 } });
    expect(legacy.build().task.status).toBe('failed');
  });

  it('evaluation is pure: evaluating never changes the subject it reads', () => {
    const f = new SalesFixture({ id: 'pure' });
    f.turn('Hola').invalid('invalid_structured_output', null, continued(1));
    const subject = f.build();
    const before = JSON.stringify(subject);
    new ExecutionOutcomeEvaluator().evaluate(Object.freeze(subject));
    expect(JSON.stringify(subject)).toBe(before);
  });
});

describe('shadow model fault directives (R4-H recorder)', () => {
  const request = { correlation: { correlationId: 'c' }, requirements: {}, messages: [], outputContract: { kind: 'text' }, limits: { timeoutMs: 1000 } } as unknown as ModelRequest;

  it('queue in order, one per call; `pass` lets a call through so a later one can be targeted', async () => {
    const inner = new FakeModelProvider([{ type: 'structured', data: { type: 'respond', content: 'a' } }, { type: 'structured', data: { type: 'respond', content: 'b' } }]);
    const recorder = new ShadowRecordingModelProvider(inner);
    recorder.injectNext('pass');
    recorder.injectNext('trailing_prose');
    recorder.injectNext('trailing_prose');
    expect(recorder.pendingFault).toBe('pass');
    await recorder.invoke(request, new AbortController().signal);
    await recorder.invoke(request, new AbortController().signal);
    await recorder.invoke(request, new AbortController().signal);
    await recorder.invoke(request, new AbortController().signal);
    expect(recorder.calls.map((c) => [c.outcome, c.injected])).toEqual([
      ['decision', false],
      ['unparsed', true],
      ['unparsed', true],
      ['decision', false],
    ]);
    expect(inner.callCount).toBe(2);
    expect(recorder.pendingFault).toBeNull();
  });
});
