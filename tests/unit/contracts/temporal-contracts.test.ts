import { describe, expect, it } from 'vitest';
import { humanRequestSchema, inputSubmissionSchema, observationSchema, reconciliationPolicySchema, scheduleSchema, taskWaitSchema, trustedHumanContextSchema } from '@r4/contracts';

const ID = '0190e7a0-0000-7000-8000-000000000001';
const T = '2026-09-23T10:00:00.000Z';

describe('R4-E contracts', () => {
  it('a trusted human has a reference and closed-set scopes only', () => {
    expect(trustedHumanContextSchema.safeParse({ humanRef: 'op-1', scopes: ['approval.decide'], correlationId: 'c' }).success).toBe(true);
    expect(trustedHumanContextSchema.safeParse({ humanRef: 'op-1', scopes: ['admin'], correlationId: 'c' }).success).toBe(false);
    expect(trustedHumanContextSchema.safeParse({ humanRef: 'op 1', scopes: [], correlationId: 'c' }).success).toBe(false);
    expect(trustedHumanContextSchema.safeParse({ humanRef: 'op-1', scopes: [], correlationId: 'c', role: 'root' }).success).toBe(false);
  });

  it('canonical input is channel-neutral and strict', () => {
    expect(inputSubmissionSchema.safeParse({ externalKey: 'e1', content: 'hi', sourceRef: 'any-channel', occurredAt: T }).success).toBe(true);
    expect(inputSubmissionSchema.safeParse({ externalKey: 'e1', content: '   ', sourceRef: 's', occurredAt: T }).success).toBe(false);
    expect(inputSubmissionSchema.safeParse({ externalKey: 'e1', content: 'hi', sourceRef: 's', occurredAt: T, actor: 'forged' }).success).toBe(false);
  });

  it('reconciliation policy is explicit and coherent', () => {
    expect(reconciliationPolicySchema.safeParse({ maxAttempts: 3, initialBackoffMs: 100, maxBackoffMs: 1000, deadlineMs: 60_000 }).success).toBe(true);
    expect(reconciliationPolicySchema.safeParse({ maxAttempts: 3, initialBackoffMs: 1000, maxBackoffMs: 100, deadlineMs: 60_000 }).success).toBe(false);
    expect(reconciliationPolicySchema.safeParse({ maxAttempts: 0, initialBackoffMs: 0, maxBackoffMs: 0, deadlineMs: 60_000 }).success).toBe(false);
  });

  it('waits, schedules and human requests are typed records with a closed lifecycle vocabulary', () => {
    const wait = { waitId: ID, taskId: ID, runId: null, kind: 'WAIT_FOR_HUMAN', status: 'completed', resolution: 'human', referenceId: ID, dueAt: null, createdAt: T, completedAt: T, correlationId: 'c' };
    expect(taskWaitSchema.safeParse(wait).success).toBe(true);
    expect(taskWaitSchema.safeParse({ ...wait, resolution: 'guessed' }).success).toBe(false);
    const schedule = { scheduleId: ID, taskId: ID, kind: 'reconciliation', referenceId: ID, status: 'dispatched', dueAt: T, deadlineAt: T, policy: { maxAttempts: 1, initialBackoffMs: 0, maxBackoffMs: 0, deadlineMs: 1 }, attempts: 0, owner: null, generation: 1, leaseExpiresAt: null, createdAt: T, updatedAt: T, correlationId: 'c' };
    expect(scheduleSchema.safeParse(schedule).success).toBe(true);
    expect(scheduleSchema.safeParse({ ...schedule, status: 'maybe' }).success).toBe(false);
    const handoff = { requestId: ID, taskId: ID, runId: null, kind: 'handoff', status: 'active', humanRef: 'op', createdAt: T, updatedAt: T, expiresAt: null, correlationId: 'c', payload: { summary: 's', contextRefs: [], initiatedBy: 'operator' } };
    expect(humanRequestSchema.safeParse(handoff).success).toBe(true);
    expect(humanRequestSchema.safeParse({ ...handoff, payload: { summary: 's', contextRefs: [], initiatedBy: 'model' } }).success).toBe(false);
  });

  it('an approval outcome observation is linked to its request and never receipt-backed', () => {
    const base = {
      observationId: ID, taskId: ID, runId: ID, agentId: 'probe', outcome: 'rejected', payload: null, observedAt: T, validUntil: null, provenance: {}, correlationId: 'c',
      error: { code: 'approval_rejected', message: 'rejected', details: null },
      source: { kind: 'action', capabilityId: 'x.y', capabilityVersion: 1, proposalId: ID, policyDecisionId: ID, executionId: null, receiptId: null, approvalRequestId: ID },
    };
    expect(observationSchema.safeParse(base).success).toBe(true);
    expect(observationSchema.safeParse({ ...base, source: { ...base.source, executionId: ID, receiptId: ID } }).success).toBe(false);
  });
});
