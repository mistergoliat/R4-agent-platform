import { describe, expect, it } from 'vitest';
import type { HumanRequest } from '@r4/contracts';
import type { TemporalRuntime } from '@r4/task-runtime';
import { AutonomyControls, PRODUCTION_CONTROL_ACTOR, ProductionAdministration, type AutonomyControlChange, type AutonomyControlRecord, type ProductionStore } from '@r4/live-ops';
import { createSilentLogger } from '@r4/observability';

const T = (n: number) => `00000000-0000-7000-8000-00000000000${n}`;
const at = '2026-09-28T12:00:00.000Z';

function request(n: number, kind: HumanRequest['kind'], status: string, payload: Record<string, unknown>): HumanRequest {
  return { requestId: T(n).replace(/0$/, 'a'), taskId: T(n), runId: null, kind, status, humanRef: status === 'active' ? 'operator-1' : null, payload, createdAt: at, updatedAt: at, expiresAt: null, correlationId: 'c' } as unknown as HumanRequest;
}

const REQUESTS: HumanRequest[] = [
  request(1, 'handoff', 'requested', { summary: 's', contextRefs: [], initiatedBy: 'platform', reason: 'autonomy_disabled' }),
  request(2, 'handoff', 'requested', { summary: 's', contextRefs: [], initiatedBy: 'agent' }),
  request(3, 'handoff', 'active', { summary: 's', contextRefs: [], initiatedBy: 'operator' }),
  request(4, 'handoff', 'requested', { summary: 's', contextRefs: [], initiatedBy: 'platform', reason: 'rollout_excluded' }),
  request(5, 'handoff', 'active', { summary: 's', contextRefs: [], initiatedBy: 'platform', reason: 'autonomy_disabled' }),
  request(6, 'handoff', 'requested', { summary: 's', contextRefs: [], initiatedBy: 'platform', reason: 'run_failure_recovery_exhausted' }),
  request(7, 'approval', 'requested', { proposalId: T(7), capabilityId: 'x', summary: 's' }),
  request(8, 'consultation', 'requested', { question: 'q', contextRefs: [] }),
];

function bed(options: { globalEnabled?: boolean; channels?: Record<string, boolean>; cancelled?: { status: string; statusReason: string; alreadyTerminal: boolean } } = {}) {
  const changes: AutonomyControlChange[] = [];
  const releases: unknown[] = [];
  const cancellations: unknown[] = [];
  const cancelled = options.cancelled ?? { status: 'cancelled', statusReason: 'cancelled', alreadyTerminal: false };
  const record = (c: AutonomyControlChange): AutonomyControlRecord => ({ scope: c.scope, autonomyEnabled: c.autonomyEnabled, reason: c.reason, changedBy: c.changedBy, changedAt: at, version: 2 });
  const store = {
    readControls: () => Promise.resolve({ state: { globalEnabled: options.globalEnabled ?? true, channels: options.channels ?? {}, version: '1' }, records: [] }),
    setControl: (c: AutonomyControlChange) => {
      changes.push(c);
      return Promise.resolve(record(c));
    },
    bindingByTask: () => Promise.resolve({ bindingId: 'b-1', channel: 'chat', status: 'open', autonomy: 'excluded', eligibilityReason: 'not_in_cohort' }),
    taskState: () => Promise.resolve({ status: 'blocked', terminalIntent: false, humanOwned: true }),
  } as unknown as ProductionStore;
  const temporal = {
    attention: () => Promise.resolve({ requests: REQUESTS, uncertainExecutions: [], exhaustedReconciliations: [] }),
    releasePlatformHold: (taskId: string, release: unknown) => {
      releases.push({ taskId, release });
      return Promise.resolve({ ...REQUESTS[0]!, status: 'cancelled' });
    },
    cancelTaskByPlatform: (taskId: string, cancellation: unknown) => {
      cancellations.push({ taskId, cancellation });
      return Promise.resolve({ task: { taskId, status: cancelled.status, statusReason: cancelled.statusReason }, alreadyTerminal: cancelled.alreadyTerminal });
    },
  } as unknown as TemporalRuntime;
  const admin = new ProductionAdministration({ store, temporal, controls: new AutonomyControls({ store, logger: createSilentLogger() }), correlationId: 'production-control:test' });
  return { admin, changes, releases, cancellations };
}

describe('production administration (D-5/D-6)', () => {
  it('lists only requested platform holds caused by disabled autonomy (never agent/operator handoffs, approvals, consultations, other causes or accepted holds)', async () => {
    const holds = await bed().admin.holds();
    expect(holds.map((h) => h.taskId)).toEqual([T(1)]);
    expect(holds[0]).toMatchObject({ reason: 'autonomy_disabled', channel: 'chat', taskStatus: 'blocked', autonomyEnabled: true });
  });

  it('attributes control changes to production control, never to a human, and requires a reason', async () => {
    const { admin, changes } = bed();
    await admin.setAutonomy(false, '  incident 7  ');
    expect(changes).toEqual([{ scope: 'global', autonomyEnabled: false, reason: 'incident 7', changedBy: PRODUCTION_CONTROL_ACTOR, correlationId: 'production-control:test' }]);
    for (const reason of [undefined, '', '   ']) await expect(admin.setAutonomy(true, reason)).rejects.toMatchObject({ code: 'reason_required' });
    expect(changes).toHaveLength(1);
  });

  it('refuses a release while autonomy is disabled globally or for the task channel, without touching the runtime', async () => {
    for (const options of [{ globalEnabled: false }, { channels: { chat: false } }]) {
      const { admin, releases } = bed(options);
      await expect(admin.releaseHold(T(1), 'resume')).rejects.toMatchObject({ code: 'autonomy_disabled' });
      expect(releases).toEqual([]);
    }
  });

  it('releases through the runtime primitive, restricted to autonomy_disabled platform holds, with the administrator reason', async () => {
    const { admin, releases } = bed();
    await admin.releaseHold(T(1), ' resume after incident ');
    expect(releases).toEqual([{ taskId: T(1), release: { reason: 'autonomy_disabled', note: 'resume after incident', actorRef: PRODUCTION_CONTROL_ACTOR, correlationId: 'production-control:test' } }]);
    await expect(admin.releaseHold(T(1), ' ')).rejects.toMatchObject({ code: 'reason_required' });
    await expect(admin.releaseHold('*', 'x')).rejects.toMatchObject({ code: 'invalid_task_id' });
    expect(releases).toHaveLength(1);
  });

  it('cancels one task through the runtime primitive, attributed to production control with the administrator reason; the binding is only reported', async () => {
    const { admin, cancellations, changes, releases } = bed();
    expect(await admin.cancelTask(T(1), ' retire pre-rollout conversation ')).toEqual({
      taskId: T(1), outcome: 'cancelled', taskStatus: 'cancelled', statusReason: 'cancelled',
      conversation: { bindingId: 'b-1', channel: 'chat', status: 'open', autonomy: 'excluded', eligibilityReason: 'not_in_cohort' },
    });
    expect(cancellations).toEqual([{ taskId: T(1), cancellation: { note: 'retire pre-rollout conversation', actorRef: PRODUCTION_CONTROL_ACTOR, correlationId: 'production-control:test' } }]);
    // No autonomy change, no hold release.
    expect([changes, releases]).toEqual([[], []]);
  });

  it('reports what the runtime did: already terminal, or deferred by an uncertain effect', async () => {
    expect(await bed({ cancelled: { status: 'completed', statusReason: 'done', alreadyTerminal: true } }).admin.cancelTask(T(1), 'retire')).toMatchObject({ outcome: 'already_terminal', taskStatus: 'completed' });
    expect(await bed({ cancelled: { status: 'blocked', statusReason: 'awaiting_reconciliation', alreadyTerminal: false } }).admin.cancelTask(T(1), 'retire')).toMatchObject({ outcome: 'cancellation_deferred', taskStatus: 'blocked' });
  });

  it('refuses a cancellation without a reason or with a malformed task id, without touching the runtime', async () => {
    const { admin, cancellations } = bed();
    for (const reason of [undefined, '', '   ']) await expect(admin.cancelTask(T(1), reason)).rejects.toMatchObject({ code: 'reason_required' });
    for (const id of ['*', 'not-a-task', '', `${T(1)} `]) await expect(admin.cancelTask(id, 'retire')).rejects.toMatchObject({ code: 'invalid_task_id' });
    expect(cancellations).toEqual([]);
  });
});
