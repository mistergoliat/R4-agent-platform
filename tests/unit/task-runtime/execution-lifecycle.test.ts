import { describe, expect, it } from 'vitest';
import { uuidv7, type PlatformError, type TaskLease } from '@r4/contracts';
import {
  assertLeaseHeld,
  assertLeaseTiming,
  isLeaseLost,
  leaseState,
  resolveTermination,
  taskStatusForTermination,
  workerPrincipal,
} from '@r4/task-runtime';

const taskId = uuidv7();
const lease: TaskLease = {
  taskId,
  owner: 'worker-a',
  generation: 3,
  acquiredAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:00:30.000Z',
  lastHeartbeatAt: '2026-01-01T00:00:10.000Z',
};
const token = { taskId, owner: 'worker-a', generation: 3 };
const at = (iso: string) => new Date(iso);

describe('lease helpers', () => {
  it('is held by the matching owner and generation before expiry', () => {
    expect(leaseState(lease, token, at('2026-01-01T00:00:29.999Z'))).toBe('held');
    expect(assertLeaseHeld(lease, token, at('2026-01-01T00:00:29.999Z'))).toBe(lease);
  });

  it('is expired at the expiry instant, even if nobody took over', () => {
    expect(leaseState(lease, token, at('2026-01-01T00:00:30.000Z'))).toBe('expired');
  });

  it('is superseded by a newer generation (fencing) or another owner', () => {
    expect(leaseState({ ...lease, generation: 4 }, token, at('2026-01-01T00:00:01.000Z'))).toBe('superseded');
    expect(leaseState({ ...lease, owner: 'worker-b' }, token, at('2026-01-01T00:00:01.000Z'))).toBe('superseded');
    // Same owner re-claiming bumps the generation: its old token is fenced too.
    expect(leaseState({ ...lease, generation: 4 }, { ...token, generation: 3 }, at('2026-01-01T00:00:01.000Z'))).toBe('superseded');
  });

  it('is released when nobody owns the task', () => {
    expect(leaseState(null, token, at('2026-01-01T00:00:01.000Z'))).toBe('released');
  });

  it.each(['expired', 'superseded', 'released'])('rejects writes when %s with lease_lost', (state) => {
    const current = state === 'released' ? null : state === 'superseded' ? { ...lease, generation: 9 } : lease;
    const now = at(state === 'expired' ? '2026-01-01T00:01:00.000Z' : '2026-01-01T00:00:01.000Z');
    try {
      assertLeaseHeld(current, token, now);
      expect.unreachable();
    } catch (error) {
      expect(isLeaseLost(error)).toBe(true);
      expect((error as PlatformError).details).toMatchObject({ state });
    }
  });

  it('requires the heartbeat to fit twice into the lease', () => {
    expect(() => assertLeaseTiming({ leaseDurationMs: 30_000, heartbeatIntervalMs: 10_000 })).not.toThrow();
    expect(() => assertLeaseTiming({ leaseDurationMs: 30_000, heartbeatIntervalMs: 15_000 })).not.toThrow();
    expect(() => assertLeaseTiming({ leaseDurationMs: 30_000, heartbeatIntervalMs: 15_001 })).toThrow(/at most half/);
    expect(() => assertLeaseTiming({ leaseDurationMs: 0, heartbeatIntervalMs: 1 })).toThrow();
  });
});

describe('termination mapping', () => {
  it('maps every termination reason to a terminal task status', () => {
    expect(taskStatusForTermination('completed')).toBe('completed');
    expect(taskStatusForTermination('cancelled')).toBe('cancelled');
    for (const reason of ['model_failure', 'invalid_decision', 'capability_failure', 'budget_exhausted', 'lease_lost', 'internal_failure'] as const) {
      expect(taskStatusForTermination(reason)).toBe('failed');
    }
  });

  it('derives a default termination from the run status (R4-B callers)', () => {
    expect(resolveTermination('completed', null, undefined)).toEqual({ reason: 'completed', failureClass: null, code: 'completed', message: '', details: null });
    expect(resolveTermination('failed', { code: 'model.timeout', message: 'slow' }, undefined)).toEqual({ reason: 'internal_failure', failureClass: 'platform', code: 'model.timeout', message: 'slow', details: null });
    expect(resolveTermination('abandoned', null, undefined).reason).toBe('lease_lost');
  });

  it('refuses a reason inconsistent with the status', () => {
    expect(() => resolveTermination('completed', null, { reason: 'budget_exhausted' })).toThrow(/inconsistent/);
    expect(() => resolveTermination('failed', { code: 'x', message: '' }, { reason: 'completed' })).toThrow(/inconsistent/);
  });

  it('identifies workers as system principals', () => {
    expect(workerPrincipal('host:1:ab')).toEqual({ kind: 'system', ref: 'worker:host:1:ab' });
  });
});
