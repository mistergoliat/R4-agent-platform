import { describe, expect, it } from 'vitest';
import {
  FAILURE_CLASSES,
  TERMINATION_REASONS,
  agentDecisionSchema,
  agentRunSchema,
  failureClassOf,
  runStatusForTermination,
  runStepSchema,
  runTerminationSchema,
  taskLeaseSchema,
  uuidv7,
} from '@r4/contracts';

const obs = uuidv7();

describe('AgentDecision schema', () => {
  it.each([
    [{ type: 'read_capability', capabilityId: 'platform_test.get_test_fact', arguments: { factKey: 'alpha' } }],
    [{ type: 'respond', content: 'working on it' }],
    [{ type: 'complete', result: { summary: 'done', evidence: [obs] } }],
    [{ type: 'complete', result: { summary: 'done', evidence: [], data: { value: 'R4' } } }],
  ])('accepts %j', (decision) => {
    expect(agentDecisionSchema.safeParse(decision).success).toBe(true);
  });

  it.each([
    ['unknown type', { type: 'delegate', to: 'x' }],
    ['missing type', { capabilityId: 'a.b', arguments: {} }],
    ['extra key (e.g. free-form reasoning)', { type: 'respond', content: 'x', reasoning: 'because' }],
    ['non-object arguments', { type: 'read_capability', capabilityId: 'a.b', arguments: 'x' }],
    ['array arguments', { type: 'read_capability', capabilityId: 'a.b', arguments: [1] }],
    ['empty respond', { type: 'respond', content: '   ' }],
    ['complete without evidence array', { type: 'complete', result: { summary: 'done' } }],
    ['complete with non-uuid evidence', { type: 'complete', result: { summary: 'done', evidence: ['obs-1'] } }],
    ['complete with duplicate evidence', { type: 'complete', result: { summary: 'done', evidence: [obs, obs] } }],
    ['complete smuggling an effect field', { type: 'complete', result: { summary: 'done', evidence: [], effects: ['sent'] } }],
  ])('rejects %s', (_name, decision) => {
    expect(agentDecisionSchema.safeParse(decision).success).toBe(false);
  });
});

describe('run termination contract', () => {
  it('derives exactly one failure class per non-success reason', () => {
    expect(TERMINATION_REASONS.map((r) => [r, failureClassOf(r)])).toEqual([
      ['completed', null],
      ['model_failure', 'model'],
      ['invalid_decision', 'protocol'],
      ['capability_failure', 'capability'],
      ['budget_exhausted', 'budget'],
      ['lease_lost', 'lease'],
      ['cancelled', null],
      ['internal_failure', 'platform'],
      // R4-D
      ['approval_required', null],
      ['write_outcome_uncertain', 'action'],
    ]);
    // Every class is reachable.
    expect(new Set(TERMINATION_REASONS.map(failureClassOf).filter(Boolean))).toEqual(new Set(FAILURE_CLASSES));
  });

  it('maps reasons to run statuses (never collapsing everything into failed)', () => {
    expect(runStatusForTermination('completed')).toBe('completed');
    expect(runStatusForTermination('cancelled')).toBe('cancelled');
    expect(runStatusForTermination('lease_lost')).toBe('abandoned');
    for (const reason of ['model_failure', 'invalid_decision', 'capability_failure', 'budget_exhausted', 'internal_failure'] as const) {
      expect(runStatusForTermination(reason)).toBe('failed');
    }
  });

  it('rejects a failure class that disagrees with the reason', () => {
    expect(runTerminationSchema.safeParse({ reason: 'budget_exhausted', failureClass: 'budget', code: 'max_model_calls', message: '', details: null }).success).toBe(true);
    expect(runTerminationSchema.safeParse({ reason: 'budget_exhausted', failureClass: 'model', code: 'max_model_calls', message: '', details: null }).success).toBe(false);
    expect(runTerminationSchema.safeParse({ reason: 'completed', failureClass: 'platform', code: 'completed', message: '', details: null }).success).toBe(false);
  });

  it('allows the abandoned run status', () => {
    expect(agentRunSchema.shape.status.safeParse('abandoned').success).toBe(true);
  });
});

describe('run step contract', () => {
  const base = {
    stepId: uuidv7(),
    runId: uuidv7(),
    taskId: uuidv7(),
    iteration: 1,
    leaseGeneration: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    correlationId: 'c',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const read = { type: 'read_capability', capabilityId: 'a.b', arguments: {} };

  it('accepts consistent steps', () => {
    for (const step of [
      { ...base, decision: read, outcome: 'pending', error: null, invocationId: uuidv7(), observationId: null, completedAt: null },
      { ...base, decision: read, outcome: 'observed', error: null, invocationId: uuidv7(), observationId: uuidv7(), completedAt: base.createdAt },
      { ...base, decision: { type: 'respond', content: 'x' }, outcome: 'recorded', error: null, invocationId: null, observationId: null, completedAt: base.createdAt },
      { ...base, decision: read, outcome: 'refused', error: { code: 'budget_exhausted', message: '' }, invocationId: null, observationId: null, completedAt: base.createdAt },
      { ...base, decision: null, outcome: 'invalid', error: { code: 'unknown_capability', message: '' }, invocationId: null, observationId: null, completedAt: base.createdAt },
      { ...base, decision: null, outcome: 'model_failed', error: { code: 'timeout', message: '' }, invocationId: null, observationId: null, completedAt: base.createdAt },
    ]) {
      expect(runStepSchema.safeParse(step).success, JSON.stringify(step.outcome)).toBe(true);
    }
  });

  it.each([
    ['pending READ without invocation id', { decision: read, outcome: 'pending', error: null, invocationId: null, observationId: null, completedAt: null }],
    ['observed without observation', { decision: read, outcome: 'observed', error: null, invocationId: uuidv7(), observationId: null, completedAt: '2026-01-01T00:00:00.000Z' }],
    ['respond with an invocation id', { decision: { type: 'respond', content: 'x' }, outcome: 'recorded', error: null, invocationId: uuidv7(), observationId: null, completedAt: '2026-01-01T00:00:00.000Z' }],
    ['invalid step carrying a decision', { decision: read, outcome: 'invalid', error: { code: 'x', message: '' }, invocationId: null, observationId: null, completedAt: '2026-01-01T00:00:00.000Z' }],
    ['refused READ with an invocation id', { decision: read, outcome: 'refused', error: { code: 'budget_exhausted', message: '' }, invocationId: uuidv7(), observationId: null, completedAt: '2026-01-01T00:00:00.000Z' }],
    ['completed pending step', { decision: read, outcome: 'pending', error: null, invocationId: uuidv7(), observationId: null, completedAt: '2026-01-01T00:00:00.000Z' }],
  ])('rejects %s', (_name, partial) => {
    expect(runStepSchema.safeParse({ ...base, ...partial }).success).toBe(false);
  });
});

describe('task lease contract', () => {
  it('requires a positive generation and a log-safe owner', () => {
    const lease = { taskId: uuidv7(), owner: 'host:123:abc', generation: 1, acquiredAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:30.000Z', lastHeartbeatAt: '2026-01-01T00:00:00.000Z' };
    expect(taskLeaseSchema.safeParse(lease).success).toBe(true);
    expect(taskLeaseSchema.safeParse({ ...lease, generation: 0 }).success).toBe(false);
    expect(taskLeaseSchema.safeParse({ ...lease, owner: 'bad owner\n' }).success).toBe(false);
  });
});
