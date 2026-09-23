import {
  PlatformError,
  RESOLVED_ACTION_EXECUTION_STATUSES,
  type ActionAttempt,
  type ActionAttemptKind,
  type ActionExecution,
  type ActionExecutionStatus,
  type ReceiptStatus,
} from '@r4/contracts';

/**
 * Governed-execution lifecycle rules (R4-D). Pure: derived only from the
 * durable command and its append-only attempt log, so every worker — the
 * original one, or the one that takes over after a crash — reaches the same
 * decision about what may happen next. There is no path that executes a
 * write whose previous outcome is unknown except the one the command's
 * declared semantics make safe (same key), and none that invents a new key.
 */

export type ActionNextStep =
  /** Perform this external call next (always with the command's execution key). */
  | { readonly kind: 'attempt'; readonly attemptKind: ActionAttemptKind; readonly attemptNumber: number }
  /** Reconciliation established that nothing was applied and no execution may be attempted anymore. */
  | { readonly kind: 'not_applied'; readonly attempt: ActionAttempt }
  /** The outcome cannot be established safely: nothing more may be attempted by this run. */
  | { readonly kind: 'uncertain'; readonly code: UncertainOutcomeCode }
  /** A receipt exists. */
  | { readonly kind: 'resolved' };

export type UncertainOutcomeCode = 'write_outcome_uncertain' | 'write_reconciliation_failure';

/** Error codes of an unknown reconcile attempt that mean the reconciler itself failed. */
const RECONCILER_FAILURES = new Set(['reconciliation_error', 'timeout', 'invalid_capability_output', 'reconcile_unsupported', 'capability_unavailable', 'capability_changed', 'command_not_authorized']);

export function isResolvedExecution(status: ActionExecutionStatus): boolean {
  return (RESOLVED_ACTION_EXECUTION_STATUSES as readonly ActionExecutionStatus[]).includes(status);
}

/**
 * The next step of a command, from its durable state:
 *
 * - no attempt yet                         → execute (attempt 1)
 * - last attempt unknown or never reported:
 *     reconcile_before_retry               → reconcile
 *     idempotent_replay                    → replay (same key); when replays are
 *                                            exhausted, reconcile if supported
 * - reconciliation says not applied        → replay (same key) while execute
 *                                            attempts remain; else a definitive
 *                                            "not applied"
 * - reconciliation unknown/never reported  → reconcile again while allowed
 * - anything exhausted                     → uncertain (never guessed)
 *
 * Execute attempts (execute + replay) and reconcile attempts are each bounded
 * by the command's `maxAttempts` (the capability's declared retry policy).
 */
export function nextActionStep(execution: ActionExecution, attempts: readonly ActionAttempt[]): ActionNextStep {
  if (isResolvedExecution(execution.status)) return { kind: 'resolved' };
  if (execution.status === 'needs_reconciliation') return { kind: 'uncertain', code: 'write_outcome_uncertain' };

  const { recovery, reconcileSupported, maxAttempts } = execution.semantics;
  const executes = attempts.filter((a) => a.kind !== 'reconcile').length;
  const reconciles = attempts.length - executes;
  const next = (attemptKind: ActionAttemptKind): ActionNextStep => ({ kind: 'attempt', attemptKind, attemptNumber: attempts.length + 1 });
  const last = attempts.at(-1);

  if (!last) return next('execute');
  if (last.outcome === 'applied' || last.outcome === 'rejected' || last.outcome === 'failed') {
    // Recorded in the same transaction as the receipt: a definitive attempt without one is corruption.
    throw new PlatformError('internal', 'unreceipted_outcome', `attempt ${last.attemptId} has a definitive outcome but execution ${execution.executionId} has no receipt`);
  }
  if (last.outcome === 'not_applied') {
    return executes < maxAttempts ? next('replay') : { kind: 'not_applied', attempt: last };
  }

  // The last attempt's outcome is unknown (reported unknown, or never reported).
  if (last.kind === 'reconcile') {
    if (reconciles < maxAttempts) return next('reconcile');
    const reconcilerFailed = last.outcome === 'unknown' && last.errorCode !== null && RECONCILER_FAILURES.has(last.errorCode);
    return { kind: 'uncertain', code: reconcilerFailed ? 'write_reconciliation_failure' : 'write_outcome_uncertain' };
  }
  if (recovery === 'reconcile_before_retry') {
    return reconciles < maxAttempts ? next('reconcile') : { kind: 'uncertain', code: 'write_outcome_uncertain' };
  }
  if (executes < maxAttempts) return next('replay');
  if (reconcileSupported && reconciles < maxAttempts) return next('reconcile');
  return { kind: 'uncertain', code: 'write_outcome_uncertain' };
}

/** The receipt status an established outcome proves. */
export function receiptStatusFor(outcome: 'applied' | 'rejected' | 'failed' | 'not_applied'): ReceiptStatus {
  switch (outcome) {
    case 'applied':
      return 'succeeded';
    case 'rejected':
      return 'rejected';
    case 'failed':
    case 'not_applied':
      return 'failed';
  }
}

/**
 * Legal execution status changes. Resolved statuses are final;
 * `needs_reconciliation` may later be resolved by a reconciler (R4-E+).
 */
const EXECUTION_TRANSITIONS: Readonly<Record<ActionExecutionStatus, readonly ActionExecutionStatus[]>> = {
  prepared: ['executing'],
  executing: ['succeeded', 'rejected', 'failed', 'needs_reconciliation'],
  needs_reconciliation: ['executing', 'succeeded', 'rejected', 'failed'],
  succeeded: [],
  rejected: [],
  failed: [],
};

export function assertExecutionTransition(from: ActionExecutionStatus, to: ActionExecutionStatus): void {
  if (!EXECUTION_TRANSITIONS[from].includes(to)) {
    throw new PlatformError('conflict', 'invalid_execution_transition', `action execution cannot go from "${from}" to "${to}"`, { from, to });
  }
}
