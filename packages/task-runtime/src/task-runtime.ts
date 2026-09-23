import type { z } from 'zod';
import {
  EMPTY_RUN_USAGE,
  PlatformError,
  createTaskRequestSchema,
  fingerprint,
  goalSpecSchema,
  idempotencyKeySchema,
  statusReasonSchema,
  type AgentRun,
  type AgentTask,
  type Clock,
  type CreateTaskRequestInput,
  type Goal,
  type GoalOrigin,
  type GoalSpec,
  type IdGenerator,
  type JsonObject,
  type Principal,
  type RunFailure,
  type RunUsage,
  type TaskStatus,
  type TaskView,
} from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import { resolveEffectiveBudget } from './budget.js';
import { assertGoalTransition, isTerminalTaskStatus } from './lifecycle.js';
import {
  finishRunWithin,
  parseOrThrow,
  transitionTaskWithin,
  updateTaskOrThrow,
  versionConflict,
  type PendingEvent,
  type TerminationInput,
} from './mutations.js';
import type { AgentDefinitionResolver, TaskRuntimeStore, TaskUnitOfWork } from './ports.js';

export interface TaskRuntimeOptions {
  store: TaskRuntimeStore;
  agents: AgentDefinitionResolver;
  ids: IdGenerator;
  clock: Clock;
  logger: StructuredLogger;
}

export interface CreateTaskCommand {
  /** Untrusted request body; validated here as well as at the transport. */
  readonly request: CreateTaskRequestInput;
  /** Resolved by the platform from the authenticated caller. */
  readonly requestedBy: Principal;
  readonly correlationId: string;
  readonly idempotencyKey?: string | undefined;
}

export interface CreateTaskResult {
  readonly view: TaskView;
  /** True when an identical earlier request with the same idempotency key is returned. */
  readonly replayed: boolean;
}

export interface TransitionTaskCommand {
  readonly taskId: string;
  readonly to: TaskStatus;
  readonly reason?: string | null;
  readonly actor: Principal;
  readonly correlationId: string;
  readonly expectedVersion?: number;
}

export interface StartRunCommand {
  readonly taskId: string;
  readonly actor: Principal;
  readonly correlationId: string;
  readonly contextSnapshotRef?: string | null;
}

export interface FinishRunCommand {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly usage?: RunUsage;
  readonly result?: JsonObject | null;
  readonly failure?: RunFailure | null;
  /** Structured termination; derived from `status` when omitted (failed → internal_failure). */
  readonly termination?: TerminationInput;
  readonly correlationId: string;
  readonly expectedVersion?: number;
}

export interface AddSubgoalCommand {
  readonly taskId: string;
  readonly parentGoalId: string;
  readonly goal: z.input<typeof goalSpecSchema>;
  readonly origin?: GoalOrigin;
  readonly makeCurrent?: boolean;
  readonly correlationId: string;
}

export interface SetCurrentGoalCommand {
  readonly taskId: string;
  readonly goalId: string;
  readonly correlationId: string;
  readonly expectedVersion?: number;
}

export interface CloseGoalCommand {
  readonly taskId: string;
  readonly goalId: string;
  readonly status: 'achieved' | 'abandoned' | 'superseded';
  readonly correlationId: string;
  readonly expectedVersion?: number;
}

/** Task statuses from which `startRun` may begin a run. */
const RUNNABLE_STATUSES: readonly TaskStatus[] = ['pending', 'running', 'waiting'];

/**
 * Task Runtime: platform authority over AgentTask, AgentRun and Goal state.
 *
 * It enforces the lifecycle, optimistic concurrency, idempotent creation and
 * the "at most one active run per task" invariant. It does not decide *what*
 * an agent should do next — that is cognition (Agent Kernel, R4-C).
 */
export class TaskRuntime {
  readonly #store: TaskRuntimeStore;
  readonly #agents: AgentDefinitionResolver;
  readonly #ids: IdGenerator;
  readonly #clock: Clock;
  readonly #logger: StructuredLogger;

  constructor(options: TaskRuntimeOptions) {
    this.#store = options.store;
    this.#agents = options.agents;
    this.#ids = options.ids;
    this.#clock = options.clock;
    this.#logger = options.logger;
  }

  async createTask(command: CreateTaskCommand): Promise<CreateTaskResult> {
    const request = parseOrThrow(createTaskRequestSchema, command.request);
    const idempotencyKey = command.idempotencyKey === undefined ? undefined : parseOrThrow(idempotencyKeySchema, command.idempotencyKey);
    const requestHash = fingerprint(request);
    const principal = command.requestedBy;
    const now = this.#clock.now();

    const agent = await this.#agents.resolve(request.agentId, request.agentVersion);
    if (!agent) {
      throw new PlatformError('precondition', 'agent_not_found', `agent "${request.agentId}"${request.agentVersion ? ` version ${request.agentVersion}` : ''} is not registered`);
    }
    if (!agent.taskTypes.includes(request.taskType)) {
      throw new PlatformError('precondition', 'task_type_not_supported', `agent "${agent.agentId}" v${agent.version} does not accept task type "${request.taskType}"`, { supported: agent.taskTypes });
    }
    const budget = resolveEffectiveBudget(request.budget, agent.budgets);
    if (request.deadlineAt !== undefined && new Date(request.deadlineAt).getTime() <= now.getTime()) {
      throw new PlatformError('validation', 'deadline_in_past', 'deadlineAt must be in the future');
    }

    const events: PendingEvent[] = [];
    const result = await this.#store.transaction(async (uow) => {
      if (idempotencyKey !== undefined) {
        const replay = await this.#replay(uow, principal.ref, idempotencyKey, requestHash);
        if (replay) return replay;
      }

      if (request.parentTaskId !== undefined) {
        const parent = await uow.lockTask(request.parentTaskId);
        if (!parent) throw new PlatformError('precondition', 'parent_task_not_found', 'parentTaskId does not reference an existing task');
        if (isTerminalTaskStatus(parent.status)) {
          throw new PlatformError('precondition', 'parent_task_terminal', `parent task is ${parent.status}`);
        }
      }

      const timestamp = now.toISOString();
      const taskId = this.#ids.next();
      const rootGoalId = this.#ids.next();
      const task: AgentTask = {
        taskId,
        taskType: request.taskType,
        agentId: agent.agentId,
        agentVersion: agent.version,
        status: 'pending',
        statusReason: null,
        parentTaskId: request.parentTaskId ?? null,
        rootGoalId,
        currentGoalId: rootGoalId,
        requestedBy: principal,
        input: request.input,
        constraints: request.constraints,
        budget,
        result: null,
        deadlineAt: request.deadlineAt === undefined ? null : new Date(request.deadlineAt).toISOString(),
        idempotencyKey: idempotencyKey ?? null,
        correlationId: command.correlationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const rootGoal = this.#newGoal(taskId, null, request.goal, 'requester', command.correlationId, timestamp, rootGoalId);

      const inserted = await uow.insertTask(task, idempotencyKey === undefined ? null : { key: idempotencyKey, requestHash });
      if (inserted === 'duplicate_idempotency_key') {
        // A concurrent request with the same key committed first.
        const replay = await this.#replay(uow, principal.ref, idempotencyKey!, requestHash);
        if (replay) return replay;
        throw new PlatformError('internal', 'idempotency_race_unresolved', 'duplicate idempotency key but no task found');
      }
      await uow.insertGoal(rootGoal);
      await uow.insertTransition({
        transitionId: this.#ids.next(),
        taskId,
        fromStatus: null,
        toStatus: 'pending',
        reason: 'created',
        actor: principal,
        taskVersion: 1,
        correlationId: command.correlationId,
        occurredAt: timestamp,
      });
      events.push(['task.created', { taskId, agentId: agent.agentId, agentVersion: agent.version, taskType: task.taskType, idempotent: idempotencyKey !== undefined }]);
      events.push(['goal.created', { taskId, goalId: rootGoalId, parentGoalId: null, origin: 'requester' }]);
      return { taskId, replayed: false };
    });

    if (result.replayed) {
      events.push(['task.idempotent_replay', { taskId: result.taskId }]);
    }
    this.#emit(events);
    return { view: await this.getTask(result.taskId), replayed: result.replayed };
  }

  async getTask(taskId: string): Promise<TaskView> {
    const view = await this.#store.getTaskView(taskId);
    if (!view) throw new PlatformError('not_found', 'task_not_found', `task ${taskId} not found`);
    return view;
  }

  async getRun(runId: string): Promise<AgentRun> {
    const run = await this.#store.getRun(runId);
    if (!run) throw new PlatformError('not_found', 'run_not_found', `run ${runId} not found`);
    return run;
  }

  async transitionTask(command: TransitionTaskCommand): Promise<AgentTask> {
    const reason = command.reason == null ? null : parseOrThrow(statusReasonSchema, command.reason);
    const events: PendingEvent[] = [];
    const task = await this.#store.transaction(async (uow) => {
      const current = await this.#lockTask(uow, command.taskId, command.expectedVersion);
      const timestamp = this.#clock.now().toISOString();
      if (current.status === 'running' && command.to !== 'running') {
        const active = await uow.findActiveRun(current.taskId);
        if (active && command.to === 'cancelled') {
          // Cancellation is platform authority: the active run ends with the task.
          await finishRunWithin(uow, active, { status: 'cancelled', correlationId: command.correlationId }, timestamp, events);
        } else if (active) {
          throw new PlatformError('precondition', 'active_run_in_progress', `run ${active.runId} must finish before the task leaves "running"`);
        }
      }
      return transitionTaskWithin(uow, this.#ids, current, command.to, reason, command.actor, command.correlationId, timestamp, events);
    });
    this.#emit(events);
    return task;
  }

  /**
   * Begins a bounded cognitive execution. Moves the task to `running` when
   * needed, atomically with creating the run. `requires_approval` and
   * `blocked` tasks cannot be started here: they need their blocker resolved.
   */
  async startRun(command: StartRunCommand): Promise<{ run: AgentRun; task: AgentTask }> {
    const contextSnapshotRef = command.contextSnapshotRef ?? null;
    if (contextSnapshotRef !== null && (contextSnapshotRef.length === 0 || contextSnapshotRef.length > 512)) {
      throw new PlatformError('validation', 'validation_failed', 'contextSnapshotRef must be 1-512 characters');
    }
    const events: PendingEvent[] = [];
    const result = await this.#store.transaction(async (uow) => {
      let task = await this.#lockTask(uow, command.taskId);
      if (!RUNNABLE_STATUSES.includes(task.status)) {
        throw new PlatformError('precondition', 'task_not_runnable', `task in status "${task.status}" cannot start a run`, { status: task.status });
      }
      const active = await uow.findActiveRun(task.taskId);
      if (active) {
        throw new PlatformError('conflict', 'run_already_active', `task already has active run ${active.runId}`);
      }
      const timestamp = this.#clock.now().toISOString();
      if (task.status !== 'running') {
        task = await transitionTaskWithin(uow, this.#ids, task, 'running', 'run_started', command.actor, command.correlationId, timestamp, events);
      }
      const run: AgentRun = {
        runId: this.#ids.next(),
        taskId: task.taskId,
        sequence: await uow.nextRunSequence(task.taskId),
        agentId: task.agentId,
        agentVersion: task.agentVersion,
        status: 'running',
        contextSnapshotRef,
        usage: { ...EMPTY_RUN_USAGE },
        result: null,
        failure: null,
        termination: null,
        recoveries: 0,
        correlationId: command.correlationId,
        version: 1,
        startedAt: timestamp,
        finishedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await uow.insertRun(run);
      events.push(['run.started', { taskId: task.taskId, runId: run.runId, agentId: run.agentId, sequence: run.sequence }]);
      return { run, task };
    });
    this.#emit(events);
    return result;
  }

  async finishRun(command: FinishRunCommand): Promise<AgentRun> {
    const events: PendingEvent[] = [];
    const run = await this.#store.transaction(async (uow) => {
      const current = await uow.lockRun(command.runId);
      if (!current) throw new PlatformError('not_found', 'run_not_found', `run ${command.runId} not found`);
      if (command.expectedVersion !== undefined && command.expectedVersion !== current.version) {
        throw versionConflict('run', current.version, command.expectedVersion);
      }
      return finishRunWithin(uow, current, command, this.#clock.now().toISOString(), events);
    });
    this.#emit(events);
    return run;
  }

  async addSubgoal(command: AddSubgoalCommand): Promise<Goal> {
    const spec = parseOrThrow(goalSpecSchema, command.goal);
    const events: PendingEvent[] = [];
    const goal = await this.#store.transaction(async (uow) => {
      const task = await this.#lockTask(uow, command.taskId);
      assertTaskOpen(task);
      const parent = await this.#lockGoalOfTask(uow, task.taskId, command.parentGoalId);
      if (parent.status !== 'active') {
        throw new PlatformError('precondition', 'parent_goal_not_active', `parent goal is ${parent.status}`);
      }
      const timestamp = this.#clock.now().toISOString();
      const goal = this.#newGoal(task.taskId, parent.goalId, spec, command.origin ?? 'agent', command.correlationId, timestamp);
      await uow.insertGoal(goal);
      events.push(['goal.created', { taskId: task.taskId, goalId: goal.goalId, parentGoalId: parent.goalId, origin: goal.origin }]);
      if (command.makeCurrent) {
        await updateTaskOrThrow(uow, { ...task, currentGoalId: goal.goalId, version: task.version + 1, updatedAt: timestamp }, task.version);
      }
      return goal;
    });
    this.#emit(events);
    return goal;
  }

  /**
   * Moves the task's focus. The pointer is set explicitly by the caller (the
   * agent, via the kernel); the platform only checks it is an active goal of
   * the same task. Closing a goal never moves the pointer implicitly.
   */
  async setCurrentGoal(command: SetCurrentGoalCommand): Promise<AgentTask> {
    const events: PendingEvent[] = [];
    const task = await this.#store.transaction(async (uow) => {
      const task = await this.#lockTask(uow, command.taskId, command.expectedVersion);
      assertTaskOpen(task);
      const goal = await this.#lockGoalOfTask(uow, task.taskId, command.goalId);
      if (goal.status !== 'active') {
        throw new PlatformError('precondition', 'goal_not_active', `goal is ${goal.status}`);
      }
      if (task.currentGoalId === goal.goalId) return task;
      const updated = { ...task, currentGoalId: goal.goalId, version: task.version + 1, updatedAt: this.#clock.now().toISOString() };
      await updateTaskOrThrow(uow, updated, task.version);
      events.push(['goal.updated', { taskId: task.taskId, goalId: goal.goalId, change: 'made_current' }]);
      return updated;
    });
    this.#emit(events);
    return task;
  }

  async closeGoal(command: CloseGoalCommand): Promise<Goal> {
    const events: PendingEvent[] = [];
    const goal = await this.#store.transaction(async (uow) => {
      await this.#lockTask(uow, command.taskId);
      const goal = await this.#lockGoalOfTask(uow, command.taskId, command.goalId);
      if (command.expectedVersion !== undefined && command.expectedVersion !== goal.version) {
        throw versionConflict('goal', goal.version, command.expectedVersion);
      }
      assertGoalTransition(goal.status, command.status);
      const updated: Goal = { ...goal, status: command.status, version: goal.version + 1, updatedAt: this.#clock.now().toISOString() };
      if (!(await uow.updateGoal(updated, goal.version))) throw versionConflict('goal', goal.version, goal.version);
      events.push(['goal.updated', { taskId: goal.taskId, goalId: goal.goalId, change: command.status }]);
      return updated;
    });
    this.#emit(events);
    return goal;
  }

  async #replay(uow: TaskUnitOfWork, principalRef: string, key: string, requestHash: string): Promise<{ taskId: string; replayed: true } | null> {
    const existing = await uow.findTaskByIdempotencyKey(principalRef, key);
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw new PlatformError('conflict', 'idempotency_key_reused', 'Idempotency-Key was already used with a different request');
    }
    return { taskId: existing.task.taskId, replayed: true };
  }

  async #lockTask(uow: TaskUnitOfWork, taskId: string, expectedVersion?: number): Promise<AgentTask> {
    const task = await uow.lockTask(taskId);
    if (!task) throw new PlatformError('not_found', 'task_not_found', `task ${taskId} not found`);
    if (expectedVersion !== undefined && expectedVersion !== task.version) {
      throw versionConflict('task', task.version, expectedVersion);
    }
    return task;
  }

  async #lockGoalOfTask(uow: TaskUnitOfWork, taskId: string, goalId: string): Promise<Goal> {
    const goal = await uow.lockGoal(goalId);
    if (!goal || goal.taskId !== taskId) {
      throw new PlatformError('not_found', 'goal_not_found', `goal ${goalId} not found in task ${taskId}`);
    }
    return goal;
  }

  #newGoal(taskId: string, parentGoalId: string | null, spec: GoalSpec, origin: GoalOrigin, correlationId: string, timestamp: string, goalId: string = this.#ids.next()): Goal {
    return {
      goalId,
      taskId,
      parentGoalId,
      description: spec.description,
      successCriteria: spec.successCriteria,
      status: 'active',
      origin,
      correlationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  #emit(events: PendingEvent[]): void {
    for (const [name, fields] of events) emitTelemetry(this.#logger, name, fields);
  }
}

function assertTaskOpen(task: AgentTask): void {
  if (isTerminalTaskStatus(task.status)) {
    throw new PlatformError('precondition', 'task_terminal', `task is ${task.status}`);
  }
}
