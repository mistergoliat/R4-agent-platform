import { systemClock, uuidV7Generator, type Clock, type ReconciliationPolicy, type Schedule, type TrustedHumanContext } from '@r4/contracts';
import type { FakeModelStep } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { PostgresExecutionStore, type Pool } from '@r4/persistence-postgres';
import { Scheduler } from '@r4/scheduler';
import { ExecutionRuntime, TemporalRuntime } from '@r4/task-runtime';

/** A trusted operator as an authentication adapter would build it (tests only; no IAM exists yet). */
export const HUMAN: TrustedHumanContext = {
  humanRef: 'operator-one',
  scopes: ['consultation.answer', 'approval.decide', 'handoff.manage', 'task.cancel', 'reconciliation.manage'],
  correlationId: 'temporal-test',
};
export const OTHER_HUMAN: TrustedHumanContext = { ...HUMAN, humanRef: 'operator-two' };

/** Small test values; production values are explicit operator configuration. */
export const RECONCILIATION_POLICY: ReconciliationPolicy = { maxAttempts: 3, initialBackoffMs: 0, maxBackoffMs: 0, deadlineMs: 86_400_000 };

export const decide = (data: unknown): FakeModelStep => ({ type: 'structured', data });
export const waitInput = (reason?: string) => decide({ type: 'wait', condition: { kind: 'WAIT_FOR_INPUT' }, ...(reason ? { reason } : {}) });
export const waitUntil = (until: string, reason?: string) => decide({ type: 'wait', condition: { kind: 'WAIT_UNTIL', until }, ...(reason ? { reason } : {}) });
export const consult = (question: string, contextRefs: string[] = []) => decide({ type: 'request_consultation', question, contextRefs });
export const handoff = (summary: string) => decide({ type: 'request_handoff', summary, contextRefs: [] });
export const manageGoal = (change: Record<string, unknown>) => decide({ type: 'manage_goal', change });

export const input = (externalKey: string, content = 'The missing dimension is 10.', sourceRef = 'test-channel', occurredAt = new Date().toISOString()) => ({ externalKey, content, sourceRef, occurredAt });
export const PARTICIPANT = { kind: 'user' as const, ref: 'requester-one' };

/**
 * A scheduler composition (its own Temporal Runtime with the test policy)
 * over a shared pool — the in-process equivalent of a scheduler process.
 */
export function testScheduler(pool: Pool, options: { owner?: string; policy?: ReconciliationPolicy; leaseMs?: number } = {}) {
  const logger = createSilentLogger();
  const ids = uuidV7Generator(systemClock);
  const store = new PostgresExecutionStore(pool);
  const execution = new ExecutionRuntime({ store, clock: systemClock, ids, logger, maxRunRecoveries: 0 });
  const temporal = new TemporalRuntime({ store, execution, ids, logger, reconciliationPolicy: options.policy ?? RECONCILIATION_POLICY });
  const scheduler = new Scheduler({ temporal, owner: options.owner ?? 'scheduler-test', leaseMs: options.leaseMs ?? 60_000, pollMs: 10, logger });
  return { temporal, scheduler };
}

/** Fires every due schedule once (the scheduler loop without its timer). */
export async function drain(scheduler: Scheduler): Promise<number> {
  let fired = 0;
  while ((await scheduler.runOnce()).kind === 'fired') fired += 1;
  return fired;
}

export const tokenOf = (s: Schedule) => ({ scheduleId: s.scheduleId, taskId: s.taskId, owner: s.owner!, generation: s.generation });

/**
 * Deterministic temporal time for a disposable test database: redefines
 * `r4_now()` as the database clock plus `offsetMs`. Only temporal state (due
 * times, schedule leases, waits, human records) moves; C1 leases do not.
 */
export async function setTemporalOffset(pool: Pool, offsetMs: number): Promise<void> {
  await pool.query(`create or replace function r4_now() returns timestamptz language sql volatile as $$ select clock_timestamp() + interval '${Math.trunc(offsetMs)} milliseconds' $$`);
}

/** A process clock shifted by a mutable offset (paired with `setTemporalOffset` for C2 freshness). */
export function shiftedClock(): Clock & { offsetMs: number } {
  const clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs) };
  return clock;
}

export async function waitRows(pool: Pool, taskId: string) {
  const r = await pool.query<{ kind: string; status: string; resolution: string | null }>('select kind, status, resolution from task_waits where task_id = $1 order by created_at', [taskId]);
  return r.rows;
}
