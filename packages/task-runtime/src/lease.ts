import { PlatformError, type LeaseToken, type TaskLease } from '@r4/contracts';

/**
 * Lease helpers. Pure: the database clock (`now`) is passed in by the caller
 * that read it under the task row lock.
 */

export type LeaseState =
  /** Owner and generation match and the lease has not expired. */
  | 'held'
  /** Owner/generation match but the expiry passed: no longer valid, even if nobody took over yet. */
  | 'expired'
  /** Another claim happened since (higher generation or different owner). */
  | 'superseded'
  /** Nobody owns the task (never leased, or released). */
  | 'released';

export function leaseState(current: TaskLease | null, token: LeaseToken, now: Date): LeaseState {
  if (current === null) return 'released';
  if (current.owner !== token.owner || current.generation !== token.generation) return 'superseded';
  return Date.parse(current.expiresAt) > now.getTime() ? 'held' : 'expired';
}

/**
 * Fencing check for owner-only writes. Anything but `held` means the caller is
 * not the owner anymore and must stop without writing.
 */
export function assertLeaseHeld(current: TaskLease | null, token: LeaseToken, now: Date): TaskLease {
  const state = leaseState(current, token, now);
  if (state !== 'held' || current === null) {
    throw leaseLostError(token, state);
  }
  return current;
}

export function leaseLostError(token: LeaseToken, state: LeaseState | 'not_renewed'): PlatformError {
  return new PlatformError('conflict', 'lease_lost', `worker ${token.owner} no longer owns task ${token.taskId} (lease ${state})`, {
    taskId: token.taskId,
    owner: token.owner,
    generation: token.generation,
    state,
  });
}

export function isLeaseLost(error: unknown): boolean {
  return error instanceof PlatformError && error.code === 'lease_lost';
}

export interface LeaseTiming {
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
}

/**
 * A healthy owner must be able to miss one heartbeat without losing its
 * lease: the interval must fit at least twice into the lease duration.
 */
export function assertLeaseTiming(timing: LeaseTiming): void {
  if (!Number.isInteger(timing.leaseDurationMs) || timing.leaseDurationMs <= 0) {
    throw new PlatformError('validation', 'invalid_lease_timing', 'leaseDurationMs must be a positive integer');
  }
  if (!Number.isInteger(timing.heartbeatIntervalMs) || timing.heartbeatIntervalMs <= 0) {
    throw new PlatformError('validation', 'invalid_lease_timing', 'heartbeatIntervalMs must be a positive integer');
  }
  if (timing.heartbeatIntervalMs * 2 > timing.leaseDurationMs) {
    throw new PlatformError('validation', 'invalid_lease_timing', `heartbeatIntervalMs (${timing.heartbeatIntervalMs}) must be at most half of leaseDurationMs (${timing.leaseDurationMs})`);
  }
}
