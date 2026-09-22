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
] as const;
export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];

export function emitTelemetry(
  logger: StructuredLogger,
  event: TelemetryEventName,
  fields: Record<string, unknown> = {},
): void {
  logger.info({ event, ...fields }, event);
}
