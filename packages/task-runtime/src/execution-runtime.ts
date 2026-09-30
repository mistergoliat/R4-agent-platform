import {
  EMPTY_RUN_USAGE,
  NON_RETRYABLE_MODEL_FAILURE,
  PlatformError,
  RUN_FAILURE_RECOVERY_EXHAUSTED,
  RUN_FAILURE_RECOVERY_KEY,
  actionProposalSchema,
  contextSnapshotSchema,
  memoryEntrySchema,
  runFailureDisposition,
  runFailureRecoveryOf,
  runStatusForTermination,
  RESPONSE_AUTHORITY_ERROR_PREFIX,
  runStepSchema,
  type RunStepOrigin,
  type JsonValue,
  type RunFailureRecovery,
  type AgentDecision,
  type AgentRun,
  type AgentTask,
  type Clock,
  type CompiledContext,
  type ContextBudgetPolicy,
  type ContextItemDecision,
  type ContextSnapshot,
  type DerivedSummaryContent,
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
import type { InteractionRecords } from './temporal-ports.js';

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
  /**
   * (ADR-028) New runs the platform may start after consecutive recoverable
   * run failures (`invalid_decision`, retryable `model_failure`) before it
   * hands the task to a human. Finite; 0 hands over at the first failure.
   * Defaults to DEFAULT_MAX_RUN_FAILURE_RECOVERIES.
   */
  maxRunFailureRecoveries?: number;
}

/** ADR-028 default: one recovery run after a recoverable run failure. */
export const DEFAULT_MAX_RUN_FAILURE_RECOVERIES = 1;

/** Why the platform hands a task to a human after a run failure (ADR-028). */
export interface RunFailureHandoffCause {
  /** Task status reason and handoff reason: RUN_FAILURE_RECOVERY_EXHAUSTED or NON_RETRYABLE_MODEL_FAILURE. */
  readonly reason: string;
  readonly terminationReason: TerminationReason;
  readonly code: string;
  /** Consecutive recoverable failed runs (this one included); null when nothing was retried. */
  readonly consecutiveFailures: number | null;
  readonly actor: Principal;
}

/**
 * (ADR-028) The human fallback of a run failure. Human ownership is the
 * Temporal Runtime's (R4-E): it attaches itself when constructed. Called
 * inside the transaction that ended the run, with the task row locked;
 * returns the task as it is afterwards (blocked on a platform handoff).
 */
export interface RunFailureHandoff {
  handOffAfterRunFailureWithin(uow: ExecutionUnitOfWork, task: AgentTask, run: AgentRun, cause: RunFailureHandoffCause, events: PendingEvent[]): Promise<AgentTask>;
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
  /** (R4-E) Every goal of the task: root, current focus, incidental and closed ones. */
  readonly goals?: readonly Goal[];
  /** (R4-E) Durable interaction records across runs (cross-run conversation projection). */
  readonly interactions?: InteractionRecords;
  readonly steps: readonly RunStep[];
  readonly observations: readonly Observation[];
  /** (R4-D) Action commands created for the task so far — the write budget's usage. Task-scoped: a later run does not reset it. */
  readonly writeActions: number;
}

export interface RecordStepCommand {
  readonly runId: string;
  /** The iteration the caller is executing; must be the next one in the durable log. */
  readonly iteration: number;
  readonly decision: AgentDecision | null;
  readonly outcome: Exclude<RunStepOutcome, 'observed'>;
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** R4-C2: the snapshot of (run, iteration) the model call was made with. */
  readonly contextSnapshotId?: string | null;
  /** ADR-031: `platform` for a token-free READ the kernel issued to revalidate a response (default `model`). */
  readonly origin?: RunStepOrigin;
}

/**
 * R4-C2: the compiled context of the model call about to be made for
 * `iteration`. Summaries produced by the compilation are persisted in the same
 * transaction, so a snapshot never references a summary that does not exist.
 */
export interface RecordContextSnapshotCommand {
  readonly runId: string;
  readonly iteration: number;
  readonly compilerVersion: string;
  readonly policyVersion: string;
  readonly compiledContext: CompiledContext;
  readonly contentHash: string;
  readonly inputFingerprint: string;
  readonly estimatedTokens: number;
  readonly budget: ContextBudgetPolicy;
  readonly decisions: readonly ContextItemDecision[];
  readonly newSummaries: readonly {
    readonly occurredAt: string;
    readonly sensitivity: 'NORMAL' | 'SENSITIVE';
    readonly content: DerivedSummaryContent;
  }[];
}

/** Principal recorded on memory the platform derives itself (summaries). */
export const CONTEXT_COMPILER_PRINCIPAL: Principal = { kind: 'system', ref: 'context-compiler' };

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

/**
 * The task status a run termination leads to. Only `completed` succeeds the
 * task. (R4-D) A suspended run leaves its task waiting, never terminal:
 * `requires_approval` for a human decision, `blocked` for an action whose
 * outcome is unknown. (ADR-028) `finishExecution` applies the run-failure
 * disposition first: a recoverable or non-retryable failure never reaches
 * this mapping's `failed`.
 */
export function taskStatusForTermination(reason: TerminationReason): Extract<TaskStatus, 'completed' | 'failed' | 'cancelled' | 'requires_approval' | 'blocked' | 'waiting'> {
  switch (reason) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'approval_required':
      return 'requires_approval';
    case 'write_outcome_uncertain':
    case 'human_handoff':
      return 'blocked';
    case 'waiting':
      return 'waiting';
    default:
      return 'failed';
  }
}

/** The run's termination details with the platform's ADR-028 disposition added (existing details are kept). */
function withRunFailureRecovery(details: JsonValue | null | undefined, recovery: RunFailureRecovery): JsonObject {
  const kept: JsonObject = details == null ? {} : typeof details === 'object' && !Array.isArray(details) ? details : { value: details };
  return { ...kept, [RUN_FAILURE_RECOVERY_KEY]: recovery };
}

export function workerPrincipal(workerId: string): Principal {
  return { kind: 'system', ref: `worker:${workerId}` };
}

export interface OwnedExecution {
  readonly task: AgentTask;
  readonly lease: TaskLease;
  readonly run: AgentRun;
}

/**
 * The fencing rule, shared by every owner-only write (execution and, since
 * R4-D, governed actions): row-lock the task, verify the caller's lease on
 * the database clock, require the task to be running with an active run.
 */
export async function lockOwnedExecution(uow: ExecutionUnitOfWork, token: LeaseToken): Promise<OwnedExecution> {
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
  readonly #maxRunFailureRecoveries: number;
  #runFailureHandoff: RunFailureHandoff | null = null;

  constructor(options: ExecutionRuntimeOptions) {
    if (!Number.isInteger(options.maxRunRecoveries) || options.maxRunRecoveries < 0) {
      throw new PlatformError('validation', 'invalid_execution_policy', 'maxRunRecoveries must be a non-negative integer');
    }
    const maxRunFailureRecoveries = options.maxRunFailureRecoveries ?? DEFAULT_MAX_RUN_FAILURE_RECOVERIES;
    if (!Number.isInteger(maxRunFailureRecoveries) || maxRunFailureRecoveries < 0) {
      throw new PlatformError('validation', 'invalid_execution_policy', 'maxRunFailureRecoveries must be a non-negative integer');
    }
    this.#store = options.store;
    this.#ids = options.ids;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#maxRunRecoveries = options.maxRunRecoveries;
    this.#maxRunFailureRecoveries = maxRunFailureRecoveries;
  }

  /**
   * (ADR-028) Wires the human fallback (the Temporal Runtime does it on
   * construction: it depends on this runtime, not the other way round).
   * Without one, a run failure that needs a human cannot be recorded and the
   * ending is refused (the kernel then records `internal_failure`).
   */
  attachRunFailureHandoff(handoff: RunFailureHandoff): void {
    this.#runFailureHandoff = handoff;
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
        // ADR-028: a run after a recoverable failure is the recovery — an ordinary run, fresh context.
        const previous = (await uow.listRuns(task.taskId)).at(-1);
        const recovering = previous ? runFailureRecoveryOf(previous.termination) : null;
        const run = await this.#newRun(uow, task, timestamp);
        events.push(['run.started', { ...base, runId: run.runId, sequence: run.sequence, generation: lease.generation }]);
        if (previous && recovering?.outcome === 'continued') {
          events.push(['task.run_failure.recovery_started', { ...base, runId: run.runId, failedRunId: previous.runId, attempt: recovering.consecutiveFailures, maxRunFailureRecoveries: recovering.maxRunFailureRecoveries }]);
        }
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
      const writeActions = await uow.countActionExecutions(task.taskId);
      const goals = await uow.temporal?.listGoals(task.taskId);
      const interactions = await uow.temporal?.interactionRecords(task.taskId);
      return { lease, task, run, goal, steps, observations, writeActions, ...(goals ? { goals } : {}), ...(interactions ? { interactions } : {}) };
    });
  }

  /**
   * Appends the next iteration to the run's step log and charges its model
   * usage. A READ decision gets its invocation id here — from the platform,
   * before execution — so a crash between decision and execution can never
   * produce a second, different invocation for the same decision.
   *
   * (R4-D) A `propose_action` decision becomes a durable ActionProposal in the
   * same transaction, with a platform proposal id, before anything is
   * authorized or executed. Its evidence references must be observations of
   * this task.
   */
  async recordStep(token: LeaseToken, command: RecordStepCommand): Promise<RunStep> {
    // ADR-031: a response the authority validator rejected is recorded refused and the run continues.
    const authorityRefusal = command.outcome === 'refused' && command.decision?.type === 'respond' && (command.error?.code ?? '').startsWith(RESPONSE_AUTHORITY_ERROR_PREFIX);
    if (command.outcome !== 'pending' && command.outcome !== 'recorded' && !authorityRefusal) {
      throw new PlatformError('validation', 'terminal_step_requires_finish', `a "${command.outcome}" step ends the run: record it with finishExecution`);
    }
    if (command.decision?.type === 'complete') {
      throw new PlatformError('validation', 'terminal_step_requires_finish', 'a complete decision ends the run: record it with finishExecution');
    }
    const events: PendingEvent[] = [];
    const step = await this.#store.transaction(async (uow) => {
      const owned = await this.#owned(uow, token);
      return this.appendStepWithin(uow, owned, token, command, this.#clock.now().toISOString(), events);
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
      if (observation.source.kind !== 'capability') {
        throw new PlatformError('validation', 'not_a_read_observation', 'action outcomes are recorded only by the governed action path');
      }
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
   * R4-C2: the latest ContextSnapshot recorded for the iteration the run is
   * about to execute (recovery reuses it when its inputs are unchanged).
   * Verifies ownership like every execution call.
   */
  async latestContextSnapshot(token: LeaseToken, iteration: number): Promise<ContextSnapshot | null> {
    return this.#store.transaction(async (uow) => {
      const { run } = await this.#owned(uow, token);
      return uow.findLatestContextSnapshot(run.runId, iteration);
    });
  }

  /**
   * R4-C2: makes the context of the next model call durable BEFORE the call,
   * in one fenced transaction together with any summary the compilation
   * produced. The snapshot is immutable; a later snapshot of the same
   * iteration is a new attempt that supersedes it (never an update). The run's
   * `contextSnapshotRef` points at the latest snapshot.
   */
  async recordContextSnapshot(token: LeaseToken, command: RecordContextSnapshotCommand): Promise<ContextSnapshot> {
    const events: PendingEvent[] = [];
    const snapshot = await this.#store.transaction(async (uow) => {
      const { task, run } = await this.#owned(uow, token);
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
      const { scope } = command.compiledContext;
      if (scope.taskId !== task.taskId || scope.runId !== run.runId || scope.iteration !== command.iteration || scope.agentId !== run.agentId || scope.agentVersion !== run.agentVersion) {
        throw new PlatformError('validation', 'context_scope_mismatch', 'the compiled context was built for another run, iteration or agent');
      }
      const timestamp = this.#clock.now().toISOString();
      for (const summary of command.newSummaries) {
        await uow.insertMemoryEntry(
          parseOrThrow(memoryEntrySchema, {
            entryId: this.#ids.next(),
            taskId: task.taskId,
            memoryType: 'DERIVED_SUMMARY',
            occurredAt: summary.occurredAt,
            recordedAt: timestamp,
            sensitivity: summary.sensitivity,
            recordedBy: CONTEXT_COMPILER_PRINCIPAL,
            correlationId: task.correlationId,
            content: summary.content,
          }),
        );
      }
      const previous = await uow.findLatestContextSnapshot(run.runId, command.iteration);
      const stored = parseOrThrow(contextSnapshotSchema, {
        snapshotId: this.#ids.next(),
        runId: run.runId,
        taskId: task.taskId,
        iteration: command.iteration,
        attempt: (previous?.attempt ?? 0) + 1,
        agentId: run.agentId,
        agentVersion: run.agentVersion,
        compilerVersion: command.compilerVersion,
        policyVersion: command.policyVersion,
        compiledContext: command.compiledContext,
        contentHash: command.contentHash,
        inputFingerprint: command.inputFingerprint,
        estimatedTokens: command.estimatedTokens,
        budget: command.budget,
        decisions: command.decisions,
        supersedesSnapshotId: previous?.snapshotId ?? null,
        correlationId: task.correlationId,
        createdAt: timestamp,
      });
      await uow.insertContextSnapshot(stored);
      const updated: AgentRun = { ...run, contextSnapshotRef: stored.snapshotId, version: run.version + 1, updatedAt: timestamp };
      if (!(await uow.updateRun(updated, run.version))) throw versionConflict('run', run.version, run.version);
      events.push([
        'context.snapshot.persisted',
        {
          taskId: task.taskId,
          runId: run.runId,
          agentId: task.agentId,
          workerId: token.owner,
          iteration: stored.iteration,
          attempt: stored.attempt,
          snapshotId: stored.snapshotId,
          supersedesSnapshotId: stored.supersedesSnapshotId,
          contentHash: stored.contentHash,
          estimatedTokens: stored.estimatedTokens,
          budgetMode: stored.budget.mode,
          maxEstimatedTokens: stored.budget.mode === 'fixed' ? stored.budget.maxEstimatedTokens : null,
          newSummaries: command.newSummaries.length,
        },
      ]);
      return stored;
    });
    this.#emit(events);
    return snapshot;
  }

  /**
   * Ends the run with a structured termination and moves the task to the
   * status the termination establishes, then releases the lease — all
   * atomically.
   *
   * (ADR-028) A failed run does not terminate durable work unless the
   * failure establishes that the work is terminal. For a recoverable failure
   * (`runFailureDisposition`) the run still fails exactly as before, but the
   * task stays `running` with no active run — the next ordinary claim starts
   * a new run that compiles a fresh context — while consecutive recoverable
   * failures stay within `maxRunFailureRecoveries`. Past it, or for a
   * non-retryable model failure, the task is handed to a human (`blocked` +
   * platform handoff), never failed. The disposition is stamped on the run's
   * termination (`details.runFailureRecovery`). Every other failure is
   * unchanged.
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
        await this.appendStepWithin(uow, owned, token, command.finalStep, timestamp, events);
        current = (await uow.findActiveRun(owned.task.taskId)) ?? current;
      }
      const recovery = await this.#runFailureRecovery(uow, current, command.termination);
      const termination: TerminationInput = recovery === null ? command.termination : { ...command.termination, details: withRunFailureRecovery(command.termination.details, recovery) };
      const run = await finishRunWithin(
        uow,
        current,
        {
          status,
          result,
          failure: status === 'failed' ? { code: command.termination.code ?? reason, message: truncate(command.termination.message ?? '') } : null,
          termination,
          correlationId: owned.task.correlationId,
        },
        timestamp,
        events,
      );
      const actor = workerPrincipal(token.owner);
      const base = { taskId: owned.task.taskId, runId: run.runId, agentId: owned.task.agentId, workerId: token.owner, terminationReason: reason, failureClass: run.termination?.failureClass ?? null, code: run.termination?.code ?? null };
      let task: AgentTask;
      if (recovery?.outcome === 'continued') {
        // Same durable task, still running, no active run: the next claim is the recovery.
        task = owned.task;
        events.push(['task.run_failure.recoverable', { ...base, attempt: recovery.consecutiveFailures, maxRunFailureRecoveries: recovery.maxRunFailureRecoveries }]);
      } else if (recovery !== null) {
        if (!this.#runFailureHandoff) {
          throw new PlatformError('internal', 'run_failure_handoff_unavailable', 'a run failure that needs a human cannot be handed over without the temporal runtime');
        }
        const exhausted = recovery.outcome === 'exhausted';
        events.push([exhausted ? 'task.run_failure.recovery_exhausted' : 'task.run_failure.non_retryable', { ...base, consecutiveFailures: recovery.consecutiveFailures, maxRunFailureRecoveries: recovery.maxRunFailureRecoveries }]);
        task = await this.#runFailureHandoff.handOffAfterRunFailureWithin(uow, owned.task, run, {
          reason: exhausted ? RUN_FAILURE_RECOVERY_EXHAUSTED : NON_RETRYABLE_MODEL_FAILURE,
          terminationReason: reason,
          code: run.termination?.code ?? reason,
          consecutiveFailures: recovery.consecutiveFailures,
          actor,
        }, events);
      } else {
        task = await transitionTaskWithin(
          uow,
          this.#ids,
          owned.task,
          taskStatusForTermination(reason),
          reason === 'completed' ? 'run_completed' : reason,
          actor,
          owned.task.correlationId,
          timestamp,
          events,
          reason === 'completed' ? { result } : {},
        );
      }
      await uow.releaseLease(token);
      const event = run.status === 'completed' ? 'run.completed' : run.status === 'abandoned' ? 'run.abandoned' : run.status === 'cancelled' ? 'run.cancelled' : run.status === 'suspended' ? 'run.suspended' : 'run.failed';
      events.push([event, { taskId: task.taskId, runId: run.runId, agentId: task.agentId, workerId: token.owner, terminationReason: reason, failureClass: run.termination?.failureClass ?? null, code: run.termination?.code ?? null, ...run.usage }]);
      return { task, run };
    });
    this.#emit(events);
    return finished;
  }

  /** Internal composition seam: caller must hold the verified task lease in this transaction. */
  async appendStepWithin(
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
    const proposal = command.decision?.type === 'propose_action' && command.outcome === 'pending' ? command.decision : null;
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
      contextSnapshotId: command.contextSnapshotId ?? null,
      proposalId: proposal ? this.#ids.next() : null,
      origin: command.origin ?? 'model',
      usage: { inputTokens: command.usage.inputTokens, outputTokens: command.usage.outputTokens },
      correlationId: task.correlationId,
      createdAt: timestamp,
      completedAt: command.outcome === 'pending' ? null : timestamp,
    });
    await uow.insertRunStep(step);
    if (proposal) {
      const evidenceRefs = proposal.evidenceRefs ?? [];
      if (evidenceRefs.length > 0) {
        const known = new Set((await uow.listObservations(task.taskId)).map((o) => o.observationId));
        const unknown = evidenceRefs.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          throw new PlatformError('validation', 'unknown_evidence', `evidence must reference observations of this task (${unknown.length} unknown)`);
        }
      }
      const stored = parseOrThrow(actionProposalSchema, {
        proposalId: step.proposalId,
        taskId: task.taskId,
        runId: run.runId,
        stepId: step.stepId,
        iteration: step.iteration,
        agentId: run.agentId,
        agentVersion: run.agentVersion,
        capabilityId: proposal.capabilityId,
        arguments: proposal.arguments,
        evidenceRefs,
        contextSnapshotId: step.contextSnapshotId,
        leaseGeneration: token.generation,
        correlationId: task.correlationId,
        createdAt: timestamp,
      });
      await uow.insertActionProposal(stored);
      events.push(['action.proposed', { taskId: task.taskId, runId: run.runId, agentId: task.agentId, workerId: token.owner, iteration: step.iteration, proposalId: stored.proposalId, capabilityId: truncate(stored.capabilityId).slice(0, 128), evidenceRefs: evidenceRefs.length }]);
    }
    // Every model step is exactly one model call: charge it with the step (platform steps call no model).
    const updated: AgentRun = {
      ...run,
      usage: {
        ...run.usage,
        modelCalls: run.usage.modelCalls + (step.origin === 'model' ? 1 : 0),
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

  #owned(uow: ExecutionUnitOfWork, token: LeaseToken): Promise<OwnedExecution> {
    return lockOwnedExecution(uow, token);
  }

  /**
   * (ADR-028) How the platform disposes of the run ending `termination`, or
   * null when it is not a recoverable/human failure (unchanged path).
   *
   * The consecutive count is derived from `agent_runs`, never stored: this
   * run plus the trailing runs of the task that failed recoverably and were
   * `continued`. Any other run ends the sequence — including an `exhausted`
   * or `handed_off` one, after which a new run exists only because a human
   * released (or cancelled) the platform handoff: that is the reset. History
   * is never rewritten; every failed run keeps its record.
   */
  async #runFailureRecovery(uow: ExecutionUnitOfWork, run: AgentRun, termination: TerminationInput): Promise<RunFailureRecovery | null> {
    const disposition = runFailureDisposition({ reason: termination.reason, details: termination.details ?? null });
    const maxRunFailureRecoveries = this.#maxRunFailureRecoveries;
    if (disposition === 'human') return { outcome: 'handed_off', consecutiveFailures: null, maxRunFailureRecoveries };
    if (disposition !== 'recoverable') return null;
    let consecutiveFailures = 1;
    for (const earlier of (await uow.listRuns(run.taskId)).filter((r) => r.sequence < run.sequence).reverse()) {
      if (runFailureRecoveryOf(earlier.termination)?.outcome !== 'continued') break;
      consecutiveFailures += 1;
    }
    return { outcome: consecutiveFailures > maxRunFailureRecoveries ? 'exhausted' : 'continued', consecutiveFailures, maxRunFailureRecoveries };
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
