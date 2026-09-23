import type { ActionExecutor } from '@r4/capability-runtime';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import type { ActionRuntime } from '@r4/task-runtime';

export type ReconcileCycle =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reconciled'; readonly taskId: string; readonly executionId: string; readonly outcome: 'resolved' | 'rescheduled' | 'exhausted' };

/**
 * Reconciliation driver of a worker (R4-E). Pure sequencing, like the kernel
 * session: the scheduler decided the work is due, the Action Runtime grants
 * one fenced `reconcile` attempt of the same command (same execution key),
 * the ActionExecutor performs the capability's reconcile call, and the Action
 * Runtime records what it established. It never calls a model, never
 * executes a write and never decides an outcome.
 */
export class Reconciler {
  readonly #options: { actions: ActionRuntime; executor: ActionExecutor; workerId: string; leaseDurationMs: number; logger: StructuredLogger };

  constructor(options: { actions: ActionRuntime; executor: ActionExecutor; workerId: string; leaseDurationMs: number; logger: StructuredLogger }) {
    this.#options = options;
  }

  async runOnce(): Promise<ReconcileCycle> {
    const { actions, executor, workerId, leaseDurationMs, logger } = this.#options;
    const grant = await actions.claimReconciliation({ workerId, leaseDurationMs });
    if (!grant) return { kind: 'idle' };
    emitTelemetry(logger, 'reconciliation.claimed', { taskId: grant.token.taskId, executionId: grant.command.executionId, workerId, generation: grant.token.generation, attempt: grant.attempt.attemptNumber });
    const report = await executor.attempt({ command: grant.command, decision: grant.decision }, { attemptNumber: grant.attempt.attemptNumber, kind: 'reconcile', workerId });
    const outcome = await actions.recordReconciliation(grant.token, grant.attempt.attemptId, report);
    return { kind: 'reconciled', taskId: grant.token.taskId, executionId: grant.command.executionId, outcome };
  }
}
