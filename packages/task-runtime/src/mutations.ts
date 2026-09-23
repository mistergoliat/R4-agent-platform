import { z } from 'zod';
import {
  PlatformError,
  failureClassOf,
  jsonObjectSchema,
  jsonValueSchema,
  reasonCodeSchema,
  runFailureSchema,
  runStatusForTermination,
  runUsageSchema,
  terminationReasonSchema,
  type AgentRun,
  type AgentTask,
  type IdGenerator,
  type JsonObject,
  type JsonValue,
  type Principal,
  type RunFailure,
  type RunStatus,
  type RunTermination,
  type RunUsage,
  type TaskStatus,
  type TerminationReason,
} from '@r4/contracts';
import type { TelemetryEventName } from '@r4/observability';
import { assertTaskTransition } from './lifecycle.js';
import type { TaskUnitOfWork } from './ports.js';

/**
 * State mutations shared by TaskRuntime and ExecutionRuntime. Both services
 * go through these so a task transition or a run finish obeys one rule set,
 * whoever triggers it (an API caller or a worker).
 */

export type PendingEvent = [TelemetryEventName, Record<string, unknown>];

export interface TerminationInput {
  readonly reason: TerminationReason;
  readonly code?: string;
  readonly message?: string;
  readonly details?: JsonValue | null;
}

export interface FinishRunInput {
  readonly status: Exclude<RunStatus, 'running'>;
  readonly usage?: RunUsage;
  readonly result?: JsonObject | null;
  readonly failure?: RunFailure | null;
  /** Defaults from status (failed → internal_failure) when omitted. */
  readonly termination?: TerminationInput;
  readonly correlationId: string;
}

export async function transitionTaskWithin(
  uow: TaskUnitOfWork,
  ids: IdGenerator,
  task: AgentTask,
  to: TaskStatus,
  reason: string | null,
  actor: Principal,
  correlationId: string,
  timestamp: string,
  events: PendingEvent[],
  changes: Partial<Pick<AgentTask, 'result'>> = {},
): Promise<AgentTask> {
  assertTaskTransition(task.status, to);
  const updated: AgentTask = { ...task, ...changes, status: to, statusReason: reason, version: task.version + 1, updatedAt: timestamp };
  await updateTaskOrThrow(uow, updated, task.version);
  await uow.insertTransition({
    transitionId: ids.next(),
    taskId: task.taskId,
    fromStatus: task.status,
    toStatus: to,
    reason,
    actor,
    taskVersion: updated.version,
    correlationId,
    occurredAt: timestamp,
  });
  events.push(['task.transitioned', { taskId: task.taskId, from: task.status, to, reason, version: updated.version }]);
  return updated;
}

export async function finishRunWithin(
  uow: TaskUnitOfWork,
  run: AgentRun,
  command: FinishRunInput,
  timestamp: string,
  events: PendingEvent[],
): Promise<AgentRun> {
  if (run.status !== 'running') {
    throw new PlatformError('conflict', 'run_not_active', `run is already ${run.status}`);
  }
  const failure = command.failure == null ? null : parseOrThrow(runFailureSchema, command.failure);
  if ((command.status === 'failed') !== (failure !== null)) {
    throw new PlatformError('validation', 'validation_failed', 'failure is required exactly when status is "failed"');
  }
  const termination = resolveTermination(command.status, failure, command.termination);
  const updated: AgentRun = {
    ...run,
    status: command.status,
    usage: command.usage === undefined ? run.usage : parseOrThrow(runUsageSchema, command.usage),
    result: command.result == null ? null : parseOrThrow(jsonObjectSchema, command.result),
    failure,
    termination,
    version: run.version + 1,
    finishedAt: timestamp,
    updatedAt: timestamp,
  };
  if (!(await uow.updateRun(updated, run.version))) throw versionConflict('run', run.version, run.version);
  // R4-D: an effect whose outcome is unknown stays marked as such, whatever ended the run.
  const unresolved = await uow.flagUnresolvedActionExecutions(run.runId, timestamp);
  if (unresolved > 0) {
    events.push(['action.outcome_uncertain', { taskId: run.taskId, runId: run.runId, agentId: run.agentId, executions: unresolved, cause: 'run_ended', terminationReason: termination.reason }]);
  }
  events.push(['run.finished', { taskId: run.taskId, runId: run.runId, status: updated.status, terminationReason: termination.reason, failureCode: failure?.code ?? null, ...updated.usage }]);
  return updated;
}

/** Every finished run carries a structured termination consistent with its status. */
export function resolveTermination(
  status: Exclude<RunStatus, 'running'>,
  failure: RunFailure | null,
  input: TerminationInput | undefined,
): RunTermination {
  const reason = input === undefined ? defaultReason(status) : parseOrThrow(terminationReasonSchema, input.reason);
  if (runStatusForTermination(reason) !== status) {
    throw new PlatformError('validation', 'validation_failed', `termination reason "${reason}" is inconsistent with run status "${status}"`);
  }
  const code = input?.code ?? failure?.code ?? reason;
  return {
    reason,
    failureClass: failureClassOf(reason),
    code: parseOrThrow(reasonCodeSchema, code),
    message: truncate(input?.message ?? failure?.message ?? ''),
    details: input?.details == null ? null : parseOrThrow(jsonValueSchema, input.details),
  };
}

function defaultReason(status: Exclude<RunStatus, 'running'>): TerminationReason {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'abandoned':
      return 'lease_lost';
    case 'failed':
      return 'internal_failure';
    case 'suspended':
      // Why a run was suspended (approval vs unknown outcome) is never implied.
      throw new PlatformError('validation', 'validation_failed', 'a suspended run requires an explicit termination reason');
  }
}

export async function updateTaskOrThrow(uow: TaskUnitOfWork, task: AgentTask, expectedVersion: number): Promise<void> {
  if (!(await uow.updateTask(task, expectedVersion))) throw versionConflict('task', expectedVersion, expectedVersion);
}

export function versionConflict(entity: string, actual: number, expected: number): PlatformError {
  return new PlatformError('conflict', 'version_conflict', `${entity} version mismatch (expected ${expected}, current ${actual})`, { expected, actual });
}

export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new PlatformError('validation', 'validation_failed', z.prettifyError(parsed.error), {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

const MAX_MESSAGE = 2000;

export function truncate(message: string): string {
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message;
}
