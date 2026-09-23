import {
  EMPTY_RUN_USAGE,
  PlatformError,
  runStatusForTermination,
  runStepSchema,
  type AgentDecision,
  type AgentRun,
  type AgentTask,
  type Clock,
  type Goal,
  type IdGenerator,
  type JsonObject,
  type LeaseToken,
  type Observation,
  type Principal,
  type RunStep,
  type RunStepOutcome,
  type TaskLease,
  type TaskStatus,
  type TerminationReason,
} from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import { assertLeaseHeld, leaseState, type LeaseState } from './lease.js';
import {
  finishRunWithin,
  parseOrThrow,
  transitionTaskWithin,
  truncate,
  versionConflict,
  type PendingEvent,
  type TerminationInput,
} from './mutations.js';
import type { ExecutionStore, ExecutionUnitOfWork } from './ports.js';

export interface ExecutionRuntimeOptions {
  store: ExecutionStore;
  ids: IdGenerator;
  clock: Clock;
  logger: StructuredLogger;
  /**
   * Takeovers of one orphaned run allowed before the platform abandons it.
   * Guards against a run that kills every worker that executes it.
   */
  maxRunRecoveries: number;
}

export interface ClaimCommand {
  readonly workerId: string;
  readonly leaseDurationMs: number;
}

export type ClaimOutcome =
  /** A new run was created (task was pending, or running without an active run). */
  | { readonly kind: 'started'; readonly lease: TaskLease; readonly task: AgentTask; readonly run: AgentRun }
  /** The task's active run continues under this owner. `takeover` = previous owner's lease expired. */
  | {
      readonly kind: 'resumed';
      readonly lease: TaskLease;
      readonly task: AgentTask;
      readonly run: AgentRun;
      readonly takeover: boolean;
      readonly previousOwner: string | null;
    }
  /** Recovery limit reached: run abandoned (lease_lost), task failed, lease released. Nothing to execute. */
  | { readonly kind: 'abandoned'; readonly task: AgentTask; readonly run: AgentRun; readonly previousOwner: string | null };

/** Everything the loop needs, read under a verified lease. */
export interface DurableExecution {
  readonly lease: TaskLease;
  readonly task: AgentTask;
  readonly run: AgentRun;
  readonly goal: Goal;
  readonly steps: readonly RunStep[];
  readonly observations: readonly Observation[];
}

export interface RecordStepCommand {
  readonly runId: string;
  /** The iteration the caller is executing; must be the next one in the durable log. */
  readonly iteration: number;
  readonly decision: AgentDecision | null;
  readonly outcome: Exclude<RunStepOutcome, 'observed'>;
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface FinishExecutionCommand {
  readonly termination: TerminationInput;
  /** Stored on the run, and on the task when completed. */
  readonly result?: JsonObject | null;
  /**
   * The iteration that caused the termination (complete, invalid decision,
   * model failure, refused READ), written in the same transaction so a crash
   * can never leave a decided-but-unapplied ending.
   */
  readonly finalStep?: RecordStepCommand;
}

/** The task status a run termination leads to. Only `completed` succeeds the task. */
export function taskStatusForTermination(reason: TerminationReason): Extract<TaskStatus, 'completed' | 'failed' | 'cancelled'> {
  switch (reason) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

export function workerPrincipal(workerId: string): Principal {
  return { kind: 'system', ref: `worker:${workerId}` };
}

/**
 * Execution Runtime: platform authority over WHO may execute a task and over
 * the run lifecycle while it executes (R4-C1). Workers call it; it never calls
 * a model and never decides what the agent does next.
 *
 * Every owner-only write runs in one transaction that first row-locks the task
 * and verifies the caller's lease (owner, generation, unexpired on the database
 * clock). A worker that lost its lease is therefore rejected with `lease_lost`
 * before anything is written, however late it comes back.
 */
export class ExecutionRuntime {
  readonly #store: ExecutionStore;
  readonly #ids: IdGenerator;
  readonly #clock: Clock;
  readonly #logger: StructuredLogger;
  readonly #maxRunRecoveries: number;

  constructor(options: ExecutionRuntimeOptions) {
    if (!Number.isInteger(options.maxRunRecoveries) || options.maxRunRecoveries < 0) {
      throw new PlatformError('validation', 'invalid_execution_policy', 'maxRunRecoveries must be a non-negative integer');
    }
    this.#store = options.store;
    this.#ids = options.ids;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#maxRunRecoveries = options.maxRunRecoveries;
  }

  /**
   * Claims the oldest runnable task and, in the same transaction, creates or
   * resumes its run — a leased task is never without a run.
   *
   * - pending task                          → task running + new run
   * - running task, no active run           → new run (sequence n+1)
   * - running task, active run, lease was released → same run resumed
   * - running task, active run, lease expired      → takeover: same run resumed,
   *   `recoveries` + 1; past `maxRunRecoveries` the run is abandoned instead.
   */
  async claimNext(command: ClaimCommand): Promise<ClaimOutcome | null> {
    const events: PendingEvent[] = [];
    const outcome = await this.#store.transaction(async (uow): Promise<ClaimOutcome | null> => {
      const claimed = await uow.claimRunnableTask(command.workerId, command.leaseDurationMs);
      if (!claimed) return null;
      const { lease, previousOwner } = claimed;
      let task = claimed.task;
      const actor = workerPrincipal(command.workerId);
      const timestamp = this.#clock.now().toISOString();
      const base = { taskId: task.taskId, agentId: task.agentId, workerId: command.workerId, correlationId: task.correlationId };
      events.push(['task.claimed', { ...base, generation: lease.generation, fromStatus: task.status, previousOwner, expiresAt: lease.expiresAt }]);
      if (previousOwner !== null) {
        events.push(['task.lease.expired', { ...base, previousOwner, previousGeneration: lease.generation - 1 }]);
      }

      if (task.status === 'pending') {
        task = await transitionTaskWithin(uow, this.#ids, task, 'running', 'run_started', actor, task.correlationId, timestamp, events);
        const run = await this.#newRun(uow, task, timestamp);
        events.push(['run.started', { ...base, runId: run.runId, sequence: run.sequence, generation: lease.generation }]);
        return { kind: 'started', lease, task, run };
      }

      const active = await uow.findActiveRun(task.taskId);
      if (!active) {
        const run = await this.#newRun(uow, task, timestamp);
        events.push(['run.started', { ...base, runId: run.runId, sequence: run.sequence, generation: lease.generation }]);
        return { kind: 'started', lease, task, run };
      }

      if (previousOwner === null) {
        events.push(['run.resumed', { ...base, runId: active.runId, generation: lease.generation, takeover: false, recoveries: active.recoveries }]);
        return { kind: 'resumed', lease, task, run: active, takeover: false, previousOwner };
      }

      if (active.recoveries >= this.#maxRunRecoveries) {
        const run = await finishRunWithin(
          uow,
          active,
          {
            status: 'abandoned',
            termination: {
              reason: 'lease_lost',
              code: 'max_run_recoveries_exceeded',
              message: `run lost its lease ${active.recoveries + 1} times; limit is ${this.#maxRunRecoveries} recoveries`,
              details: { recoveries: active.recoveries, maxRunRecoveries: this.#maxRunRecoveries, previousOwner },
            },
            correlationId: task.correlationId,
          },
          timestamp,
          events,
        );
        task = await transitionTaskWithin(uow, this.#ids, task, 'failed', 'lease_lost', actor, task.correlationId, timestamp, events);
        await uow.releaseLease(lease);
        events.push(['run.abandoned', { ...base, runId: run.runId, recoveries: active.recoveries, terminationReason: 'lease_lost' }]);
        return { kind: 'abandoned', task, run, previousOwner };
      }

      const run: AgentRun = { ...active, recoveries: active.recoveries + 1, version: active.version + 1, updatedAt: timestamp };
      if (!(await uow.updateRun(run, active.version))) throw versionConflict('run', active.version, active.version);
      events.push(['run.resumed', { ...base, runId: run.runId, generation: lease.generation, takeover: true, recoveries: run.recoveries }]);
      events.push(['worker.recovery', { ...base, runId: run.runId, previousOwner, generation: lease.generation, recoveries: run.recoveries }]);
      return { kind: 'resumed', lease, task, run, takeover: true, previousOwner };
    });
    this.#emit(events);
    return outcome;
  }

  /** Heartbeat. Returns the extended lease, or null when ownership is gone. */
  async renewLease(token: LeaseToken, leaseDurationMs: number): Promise<TaskLease | null> {
    const renewed = await this.#store.renewLease(token, leaseDurationMs);
    if (renewed) {
      emitTelemetry(this.#logger, 'task.lease.renewed', { taskId: token.taskId, workerId: token.owner, generation: token.generation, expiresAt: renewed.expiresAt });
    }
    return renewed;
  }

  /**
   * Why a lease is (not) usable — used after a refused renewal to tell a lost
   * lease from a task that left `running` (e.g. cancelled). Read-only.
   */
  async ownershipOf(token: LeaseToken): Promise<LeaseState | 'task_not_running'> {
    return this.#store.transaction(async (uow) => {
      const locked = await uow.lockTaskLease(token.taskId);
      if (!locked) return 'released';
      const state = leaseState(locked.lease, token, locked.dbNow);
      return state === 'held' && locked.task.status !== 'running' ? 'task_not_running' : state;
    });
  }

  /** Gives up ownership without finishing the run, so another worker can resume at once. */
  async releaseLease(token: LeaseToken): Promise<boolean> {
    const released = await this.#store.transaction((uow) => uow.releaseLease(token));
    if (released) emitTelemetry(this.#logger, 'task.lease.released', { taskId: token.taskId, workerId: token.owner, generation: token.generation });
    return released;
  }

  /** Loads the durable execution state, verifying ownership first. */
  async loadExecution(token: LeaseToken): Promise<DurableExecution> {
    return this.#store.transaction(async (uow) => {
      const { task, lease, run } = await this.#owned(uow, token);
      const goal = await uow.lockGoal(task.currentGoalId);
      if (!goal) throw new PlatformError('internal', 'current_goal_missing', `task ${task.taskId} has no current goal row`);
      const steps = await uow.listRunSteps(run.runId);
      const observations = await uow.listObservations(task.taskId);
      return { lease, task, run, goal, steps, observations };
    });
  }

  /**
   * Appends the next iteration to the run's step log and charges its model
   * usage. A READ decision gets its invocation id here — from the platform,
   * before execution — so a crash between decision and execution can never
   * produce a second, different invocation for the same decision.
   */
  async recordStep(token: LeaseToken, command: RecordStepCommand): Promise<RunStep> {
    if (command.outcome !== 'pending' && command.outcome !== 'recorded') {
      throw new PlatformError('validation', 'terminal_step_requires_finish', `a "${command.outcome}" step ends the run: record it with finishExecution`);
    }
    if (command.decision?.type === 'complete') {
      throw new PlatformError('validation', 'terminal_step_requires_finish', 'a complete decision ends the run: record it with finishExecution');
    }
    const events: PendingEvent[] = [];
    const step = await this.#store.transaction(async (uow) => {
      const owned = await this.#owned(uow, token);
      return this.#appendStep(uow, owned, token, command, this.#clock.now().toISOString(), events);
    });
    this.#emit(events);
    return step;
  }

  /**
   * Persists the observation of a pending READ and links it to its step, in
   * one fenced transaction. Idempotent on the invocation id: replaying an
   * already-observed invocation returns the stored observation unchanged.
   */
  async recordObservation(token: LeaseToken, observation: Observation): Promise<Observation> {
    const events: PendingEvent[] = [];
    const stored = await this.#store.transaction(async (uow) => {
      const { run, task } = await this.#owned(uow, token);
      const invocationId = observation.source.invocationId;
      const step = await uow.findStepByInvocationId(invocationId);
      if (!step || step.runId !== run.runId || observation.runId !== run.runId || observation.taskId !== task.taskId) {
        throw new PlatformError('conflict', 'unknown_invocation', `invocation ${invocationId} is not a READ of the active run`);
      }
      const recorded = await uow.insertObservation(observation);
      if (step.outcome === 'observed') return recorded;

      const timestamp = this.#clock.now().toISOString();
      const observed: RunStep = { ...step, outcome: 'observed', observationId: recorded.observationId, completedAt: timestamp };
      if (!(await uow.completePendingStep(observed))) {
        throw new PlatformError('conflict', 'step_not_pending', `step ${step.stepId} is no longer pending`);
      }
      const updated: AgentRun = { ...run, usage: { ...run.usage, capabilityCalls: run.usage.capabilityCalls + 1 }, version: run.version + 1, updatedAt: timestamp };
      if (!(await uow.updateRun(updated, run.version))) throw versionConflict('run', run.version, run.version);
      events.push(['observation.persisted', { taskId: task.taskId, runId: run.runId, agentId: task.agentId, workerId: token.owner, iteration: step.iteration, invocationId, observationId: recorded.observationId, outcome: recorded.outcome, errorCode: recorded.error?.code ?? null }]);
      return recorded;
    });
    this.#emit(events);
    return stored;
  }

  /**
   * Ends the run with a structured termination and moves the task to the
   * matching terminal status, then releases the lease — all atomically.
   */
  async finishExecution(token: LeaseToken, command: FinishExecutionCommand): Promise<{ task: AgentTask; run: AgentRun }> {
    const events: PendingEvent[] = [];
    const finished = await this.#store.transaction(async (uow) => {
      const owned = await this.#owned(uow, token);
      const reason = command.termination.reason;
      const status = runStatusForTermination(reason);
      const timestamp = this.#clock.now().toISOString();
      const result = command.result ?? null;
      let current = owned.run;
      if (command.finalStep) {
        if (command.finalStep.outcome === 'pending') {
          throw new PlatformError('validation', 'validation_failed', 'a pending READ cannot end a run');
        }
        await this.#appendStep(uow, owned, token, command.finalStep, timestamp, events);
        current = (await uow.findActiveRun(owned.task.taskId)) ?? current;
      }
      const run = await finishRunWithin(
        uow,
        current,
        {
          status,
          result,
          failure: status === 'failed' ? { code: command.termination.code ?? reason, message: truncate(command.termination.message ?? '') } : null,
          termination: command.termination,
          correlationId: owned.task.correlationId,
        },
        timestamp,
        events,
      );
      const task = await transitionTaskWithin(
        uow,
        this.#ids,
        owned.task,
        taskStatusForTermination(reason),
        reason === 'completed' ? 'run_completed' : reason,
        workerPrincipal(token.owner),
        owned.task.correlationId,
        timestamp,
        events,
        reason === 'completed' ? { result } : {},
      );
      await uow.releaseLease(token);
      const event = run.status === 'completed' ? 'run.completed' : run.status === 'abandoned' ? 'run.abandoned' : run.status === 'cancelled' ? 'run.cancelled' : 'run.failed';
      events.push([event, { taskId: task.taskId, runId: run.runId, agentId: task.agentId, workerId: token.owner, terminationReason: reason, failureClass: run.termination?.failureClass ?? null, code: run.termination?.code ?? null, ...run.usage }]);
      return { task, run };
    });
    this.#emit(events);
    return finished;
  }

  async #appendStep(
    uow: ExecutionUnitOfWork,
    owned: { task: AgentTask; run: AgentRun },
    token: LeaseToken,
    command: RecordStepCommand,
    timestamp: string,
    events: PendingEvent[],
  ): Promise<RunStep> {
    const { task, run } = owned;
    if (run.runId !== command.runId) {
      throw new PlatformError('conflict', 'run_mismatch', `run ${command.runId} is not the active run of task ${task.taskId}`);
    }
    const steps = await uow.listRunSteps(run.runId);
    if (steps.some((s) => s.outcome === 'pending')) {
      throw new PlatformError('conflict', 'pending_step_exists', 'the previous READ has not been observed yet');
    }
    if (command.iteration !== steps.length + 1) {
      throw new PlatformError('conflict', 'iteration_conflict', `expected iteration ${steps.length + 1}, got ${command.iteration}`);
    }
    const executesRead = command.decision?.type === 'read_capability' && command.outcome === 'pending';
    const step = parseOrThrow(runStepSchema, {
      stepId: this.#ids.next(),
      runId: run.runId,
      taskId: task.taskId,
      iteration: command.iteration,
      leaseGeneration: token.generation,
      decision: command.decision,
      outcome: command.outcome,
      error: command.error == null ? null : { code: command.error.code, message: truncate(command.error.message) },
      invocationId: executesRead ? this.#ids.next() : null,
      observationId: null,
      usage: { inputTokens: command.usage.inputTokens, outputTokens: command.usage.outputTokens },
      correlationId: task.correlationId,
      createdAt: timestamp,
      completedAt: command.outcome === 'pending' ? null : timestamp,
    });
    await uow.insertRunStep(step);
    // Every step is exactly one model call: charge it with the step.
    const updated: AgentRun = {
      ...run,
      usage: {
        ...run.usage,
        modelCalls: run.usage.modelCalls + 1,
        inputTokens: run.usage.inputTokens + step.usage.inputTokens,
        outputTokens: run.usage.outputTokens + step.usage.outputTokens,
      },
      version: run.version + 1,
      updatedAt: timestamp,
    };
    if (!(await uow.updateRun(updated, run.version))) throw versionConflict('run', run.version, run.version);
    events.push(['run.step.recorded', { taskId: task.taskId, runId: run.runId, agentId: task.agentId, workerId: token.owner, iteration: step.iteration, outcome: step.outcome, decisionType: step.decision?.type ?? null, errorCode: step.error?.code ?? null }]);
    return step;
  }

  async #owned(uow: ExecutionUnitOfWork, token: LeaseToken): Promise<{ task: AgentTask; lease: TaskLease; run: AgentRun }> {
    const locked = await uow.lockTaskLease(token.taskId);
    if (!locked) throw new PlatformError('not_found', 'task_not_found', `task ${token.taskId} not found`);
    const lease = assertLeaseHeld(locked.lease, token, locked.dbNow);
    if (locked.task.status !== 'running') {
      throw new PlatformError('precondition', 'task_not_runnable', `task is ${locked.task.status}`, { status: locked.task.status });
    }
    const run = await uow.findActiveRun(locked.task.taskId);
    if (!run) throw new PlatformError('precondition', 'task_not_runnable', 'task has no active run');
    return { task: locked.task, lease, run };
  }

  async #newRun(uow: ExecutionUnitOfWork, task: AgentTask, timestamp: string): Promise<AgentRun> {
    const run: AgentRun = {
      runId: this.#ids.next(),
      taskId: task.taskId,
      sequence: await uow.nextRunSequence(task.taskId),
      agentId: task.agentId,
      agentVersion: task.agentVersion,
      status: 'running',
      contextSnapshotRef: null,
      usage: { ...EMPTY_RUN_USAGE },
      result: null,
      failure: null,
      termination: null,
      recoveries: 0,
      correlationId: task.correlationId,
      version: 1,
      startedAt: timestamp,
      finishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await uow.insertRun(run);
    return run;
  }

  #emit(events: PendingEvent[]): void {
    for (const [name, fields] of events) emitTelemetry(this.#logger, name, fields);
  }
}
