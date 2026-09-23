import type { StructuredLogger } from './logger.js';

/**
 * Canonical telemetry event names. Emitted as structured log lines with an
 * `event` field. These are observability signals, not a durable event outbox
 * (the durable outbox and public event contract are deferred; see ADR-003).
 *
 * Telemetry records metadata only: identifiers, statuses, counts, latencies,
 * error codes. It never records prompts, model output text or chain-of-thought.
 */
export const TELEMETRY_EVENTS = [
  'agent_definitions.synced',
  'task.created',
  'task.idempotent_replay',
  'task.transitioned',
  'goal.created',
  'goal.updated',
  'run.started',
  'run.finished',
  'model.call.completed',
  'model.call.failed',
  'capability.registered',
  'capability.invocation.completed',
  // R4-C1 execution kernel
  'worker.started',
  'worker.stopped',
  'worker.recovery',
  'task.claimed',
  'task.lease.renewed',
  'task.lease.expired',
  'task.lease.released',
  'lease.lost',
  'run.resumed',
  'run.step.recorded',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.abandoned',
  'run.suspended',
  'agent.decision',
  'capability.invoked',
  'observation.persisted',
  'budget.exhausted',
  // R4-C2 context compiler (metadata only: ids, kinds, counts, tokens — never item content)
  'context.compile.started',
  'context.source.loaded',
  'context.item.included',
  'context.item.excluded',
  'context.compacted',
  'context.conflict.detected',
  'context.budget.exhausted',
  'context.snapshot.persisted',
  'context.snapshot.reused',
  'context.compile.completed',
  // R4-D governed execution (metadata only: ids, classes, codes, attempts — never arguments or results)
  'action.proposed',
  'policy.evaluated',
  'action.command.created',
  'action.execution.started',
  'action.execution.replayed',
  'action.attempt.recorded',
  'action.reconciliation.started',
  'action.reconciliation.completed',
  'action.receipt.persisted',
  'action.observation.persisted',
  'action.denied',
  'action.approval_required',
  'action.failed',
  'action.outcome_uncertain',
] as const;
export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];

export function emitTelemetry(
  logger: StructuredLogger,
  event: TelemetryEventName,
  fields: Record<string, unknown> = {},
): void {
  logger.info({ event, ...fields }, event);
}
