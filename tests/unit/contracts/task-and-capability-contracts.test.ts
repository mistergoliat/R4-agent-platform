import { describe, expect, it } from 'vitest';
import {
  capabilityDefinitionSchema,
  createTaskRequestSchema,
  observationSchema,
  type CapabilityDefinition,
} from '@r4/contracts';

describe('CreateTaskRequest contract', () => {
  const valid = { taskType: 'probe.echo', agentId: 'platform-probe', goal: { description: 'do it' } };

  it('applies defaults', () => {
    const parsed = createTaskRequestSchema.parse(valid);
    expect(parsed).toMatchObject({ input: {}, constraints: {}, budget: {}, goal: { successCriteria: [] } });
  });

  it.each([
    ['missing goal', { taskType: 'probe.echo', agentId: 'platform-probe' }],
    ['blank goal', { ...valid, goal: { description: '   ' } }],
    ['unknown field', { ...valid, status: 'completed' }],
    ['client-asserted requester', { ...valid, requestedBy: { kind: 'system', ref: 'root' } }],
    ['bad task type', { ...valid, taskType: 'NoNamespace' }],
    ['non-object input', { ...valid, input: ['a'] }],
    ['negative budget', { ...valid, budget: { maxModelCalls: -1 } }],
    ['unknown budget key', { ...valid, budget: { maxDollars: 5 } }],
    ['bad parent id', { ...valid, parentTaskId: 'not-a-uuid' }],
    ['bad deadline', { ...valid, deadlineAt: 'tomorrow' }],
  ])('rejects %s', (_label, body) => {
    expect(createTaskRequestSchema.safeParse(body).success).toBe(false);
  });

  it('bounds the size of extensible JSON input', () => {
    const big = { ...valid, input: { blob: 'x'.repeat(70 * 1024) } };
    expect(createTaskRequestSchema.safeParse(big).success).toBe(false);
  });
});

describe('CapabilityDefinition contract', () => {
  const base: CapabilityDefinition = {
    capabilityId: 'pack.do_thing',
    version: 1,
    description: 'test',
    owner: 'pack',
    riskClass: 'READ',
    requiredScopes: ['pack.read'],
    identityRequirement: 'none',
    confirmationPolicy: 'none',
    approvalPolicy: 'none',
    idempotency: 'inherent',
    retryPolicy: { maxAttempts: 3, initialBackoffMs: 100 },
    timeoutMs: 1000,
    freshnessTtlMs: null,
    auditLevel: 'standard',
    inputSchema: {},
    outputSchema: {},
  };

  it('accepts a retried READ', () => {
    expect(capabilityDefinitionSchema.safeParse(base).success).toBe(true);
  });

  it('forbids blind retries of writes', () => {
    const blind = { ...base, riskClass: 'REVERSIBLE_WRITE', idempotency: 'inherent' };
    expect(capabilityDefinitionSchema.safeParse(blind).success).toBe(false);
    const keyed = { ...blind, idempotency: 'key_required' };
    expect(capabilityDefinitionSchema.safeParse(keyed).success).toBe(true);
    const single = { ...blind, retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 } };
    expect(capabilityDefinitionSchema.safeParse(single).success).toBe(true);
  });

  it('requires READ capabilities to be safely repeatable', () => {
    expect(capabilityDefinitionSchema.safeParse({ ...base, idempotency: 'unsupported' }).success).toBe(false);
  });

  it('requires at least one scope and a known risk class', () => {
    expect(capabilityDefinitionSchema.safeParse({ ...base, requiredScopes: [] }).success).toBe(false);
    expect(capabilityDefinitionSchema.safeParse({ ...base, riskClass: 'MEGA' }).success).toBe(false);
  });
});

describe('Observation contract', () => {
  const ok = {
    observationId: '0190a0a0-0000-7000-8000-000000000001',
    taskId: '0190a0a0-0000-7000-8000-000000000002',
    runId: null,
    agentId: 'platform-probe',
    source: { kind: 'capability', capabilityId: 'x.y', capabilityVersion: 1, invocationId: '0190a0a0-0000-7000-8000-000000000003' },
    outcome: 'succeeded',
    payload: { a: 1 },
    error: null,
    observedAt: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    provenance: {},
    correlationId: 'c-1',
  };

  it('requires an error exactly when the outcome is not a success', () => {
    expect(observationSchema.safeParse(ok).success).toBe(true);
    expect(observationSchema.safeParse({ ...ok, outcome: 'rejected' }).success).toBe(false);
    expect(
      observationSchema.safeParse({ ...ok, outcome: 'rejected', payload: null, error: { code: 'scope_denied', message: 'no', details: null } }).success,
    ).toBe(true);
  });
});
