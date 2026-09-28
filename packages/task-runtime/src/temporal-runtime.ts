import {
  PlatformError,
  agentDecisionSchema,
  fingerprint,
  goalSchema,
  handoffTakeoverSchema,
  humanRequestSchema,
  humanResponseSchema,
  inputSubmissionSchema,
  memoryEntrySchema,
  principalSchema,
  reconciliationPolicySchema,
  statusReasonSchema,
  trustedHumanContextSchema,
  type AgentRun,
  type AgentTask,
  type GoalRejectionCode,
  type HandoffTakeover,
  type HumanRequest,
  type HumanResponse,
  type HumanScope,
  type IdGenerator,
  type InputSubmission,
  type LeaseToken,
  type ManageGoalDecision,
  type Principal,
  type ReconciliationPolicy,
  type RunTermination,
  type Schedule,
  type ScheduleToken,
  type TaskOwnership,
  type TaskWait,
  type TemporalDecision,
  type TrustedHumanContext,
  type WaitResolution,
} from '@r4/contracts';
import { emitTelemetry, type StructuredLogger, type TelemetryEventName } from '@r4/observability';
import { lockOwnedExecution, workerPrincipal, type ExecutionRuntime, type RecordStepCommand, type RunFailureHandoff, type RunFailureHandoffCause } from './execution-runtime.js';
import { isTerminalTaskStatus } from './lifecycle.js';
import { finishRunWithin, parseOrThrow, transitionTaskWithin, updateTaskOrThrow, type PendingEvent } from './mutations.js';
import type { ExecutionStore, ExecutionUnitOfWork } from './ports.js';
import type { CreateTaskCommand, TaskRuntime } from './task-runtime.js';
import type { TemporalPersistence } from './temporal-ports.js';

export function temporalOf(uow: ExecutionUnitOfWork): TemporalPersistence {
  if (!uow.temporal) throw new PlatformError('internal', 'temporal_unavailable', 'temporal persistence is required');
  return uow.temporal;
}

export interface TemporalRuntimeOptions {
  store: ExecutionStore;
  execution: ExecutionRuntime;
  ids: IdGenerator;
  logger: StructuredLogger;
  /**
   * Scheduler composition only: the reconciliation policy stamped on
   * reconciliation work the first time it is claimed. There is no default —
   * attempts, backoff and deadline are explicit operator configuration.
   */
  reconciliationPolicy?: ReconciliationPolicy;
}

export type TemporalDecisionOutcome = { kind: 'continued' } | { kind: 'suspended'; termination: RunTermination };

const PLATFORM_ACTOR = 'temporal-runtime';

/**
 * (R4-I) Why the platform hands a task to humans on its own initiative:
 * `reason` is a status reason code (also the handoff's reason), `summary`
 * a platform-authored explanation for operators (never model output, never
 * shown to the model).
 */
export interface PlatformHold {
  readonly reason: string;
  readonly summary: string;
}

export interface SubmitInputOptions {
  /** (R4-I) Hold the task for humans before the input is recorded (no autonomous wake). */
  readonly hold?: PlatformHold;
}

export interface InputSubmissionResult {
  readonly inputId: string;
  readonly replayed: boolean;
  /** (R4-I) True when this submission placed a new platform hold on the task. */
  readonly held: boolean;
}

/**
 * (R4-I) Release of a platform hold by a trusted platform administration
 * caller — deployment tooling, never a model, never a request body, never a
 * human identity. `reason` is the hold reason code the caller may release
 * (any other open handoff is refused); `note` is the administrator's
 * operational reason, kept as durable evidence.
 */
export interface PlatformHoldRelease {
  readonly reason: string;
  readonly note: string;
  readonly actorRef: string;
  readonly correlationId: string;
}

function parsePlatformHoldRelease(release: PlatformHoldRelease): PlatformHoldRelease {
  parseOrThrow(statusReasonSchema, release.reason);
  if (typeof release.note !== 'string' || release.note.trim().length === 0 || release.note.length > 2000) {
    throw new PlatformError('validation', 'validation_failed', 'releasing a platform hold needs a non-empty note (at most 2000 characters)');
  }
  if (typeof release.actorRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(release.actorRef)) {
    throw new PlatformError('validation', 'validation_failed', 'a platform hold release needs a valid actor reference');
  }
  if (typeof release.correlationId !== 'string' || release.correlationId.length === 0 || release.correlationId.length > 200) {
    throw new PlatformError('validation', 'validation_failed', 'a platform hold release needs a correlation id');
  }
  return { reason: release.reason, note: release.note.trim(), actorRef: release.actorRef, correlationId: release.correlationId };
}

function parsePlatformHold(hold: PlatformHold): PlatformHold {
  parseOrThrow(statusReasonSchema, hold.reason);
  if (typeof hold.summary !== 'string' || hold.summary.trim().length === 0 || hold.summary.length > 2000) {
    throw new PlatformError('validation', 'validation_failed', 'a platform hold needs a non-empty summary (at most 2000 characters)');
  }
  return { reason: hold.reason, summary: hold.summary };
}

/**
 * Temporal Runtime (R4-E): durable authority over time, waits, wake-ups,
 * human ownership and cognitive goal changes. It never calls a model and
 * never chooses what the agent does next: a wake only makes a task runnable
 * again, and the next run's kernel decides from a freshly compiled context.
 *
 * Every operation is one transaction that row-locks the task first, so waits,
 * inputs, human decisions, takeovers, cancellation and schedule firings of
 * one task are serialized. Time is `r4_now()` (the temporal clock). Human
 * operations require a TrustedHumanContext produced by an authentication
 * adapter — never by a model, never from a request body.
 */
export class TemporalRuntime implements RunFailureHandoff {
  readonly #options: TemporalRuntimeOptions;

  constructor(options: TemporalRuntimeOptions) {
    if (options.reconciliationPolicy) parseOrThrow(reconciliationPolicySchema, options.reconciliationPolicy);
    this.#options = options;
    // ADR-028: human ownership is this runtime's; the execution runtime hands failed-run tasks over through it.
    options.execution.attachRunFailureHandoff(this);
  }

  // -------------------------------------------------------------------------
  // Read side
  // -------------------------------------------------------------------------

  inspect(taskId: string) {
    return this.#options.store.transaction(async (uow) => {
      const task = await this.lockTask(uow, taskId);
      const p = temporalOf(uow);
      return {
        wait: await p.activeWait(taskId),
        waits: await p.listWaits(taskId),
        humans: await p.listHumans(taskId),
        schedules: await p.listSchedules(taskId),
        events: await p.events(taskId),
        ownership: await this.ownershipWithin(uow, task),
      };
    });
  }

  /** What needs a human: open requests, uncertain effects and reconciliation that ran out of attempts. */
  attention() {
    return this.#options.store.transaction(async (uow) => {
      const p = temporalOf(uow);
      const uncertain = await p.unresolved();
      const exhausted: Schedule[] = [];
      for (const execution of uncertain) {
        const schedule = await p.scheduleFor('reconciliation', execution.executionId);
        if (schedule?.status === 'exhausted') exhausted.push(schedule);
      }
      return {
        requests: (await p.listHumans()).filter((h) => h.status === 'requested' || h.status === 'active'),
        uncertainExecutions: uncertain,
        exhaustedReconciliations: exhausted,
      };
    });
  }

  /** Who may act as owner now. `blocked` alone is never enough: this says why. */
  async ownershipWithin(uow: ExecutionUnitOfWork, task: AgentTask): Promise<TaskOwnership> {
    const p = temporalOf(uow);
    const handoff = await p.activeHandoff(task.taskId);
    const wait = await p.activeWait(task.taskId);
    const intent = await p.terminalIntent(task.taskId);
    const uncertain = await uow.countUncertainActionExecutions(task.taskId);
    const blockedBy: TaskOwnership['blockedBy'][number][] = [];
    if (handoff) blockedBy.push('human_handoff');
    if (uncertain > 0 && task.status !== 'running') blockedBy.push('uncertain_action');
    if (wait?.kind === 'WAIT_FOR_APPROVAL') blockedBy.push('approval');
    else if (wait && !handoff && wait.kind !== 'WAIT_FOR_RECONCILIATION') blockedBy.push('wait');
    const owner: TaskOwnership['owner'] = isTerminalTaskStatus(task.status) ? 'none' : handoff?.status === 'active' ? 'human' : handoff ? 'none' : 'agent';
    return { owner, humanRef: handoff?.status === 'active' ? handoff.humanRef : null, blockedBy, terminalIntent: intent?.targetStatus ?? null };
  }

  // -------------------------------------------------------------------------
  // Agent decisions (under the worker's lease)
  // -------------------------------------------------------------------------

  /**
   * Applies a validated temporal decision atomically with its step. A goal
   * change continues the run (or is refused, recoverably); a wait, a
   * consultation or a handoff request suspends the run and releases the lease.
   */
  async decide(token: LeaseToken, command: RecordStepCommand, decision: TemporalDecision): Promise<TemporalDecisionOutcome> {
    parseOrThrow(agentDecisionSchema, decision);
    if (fingerprint(command.decision) !== fingerprint(decision) || command.outcome !== 'recorded') {
      throw new PlatformError('validation', 'temporal_decision_mismatch', 'the recorded step must contain the proposed temporal decision');
    }
    return this.write(async (uow, events) => {
      const owned = await lockOwnedExecution(uow, token);
      const p = temporalOf(uow);
      const now = await p.now();
      if (decision.type === 'manage_goal') {
        const rejection = await this.#goalRejection(uow, owned.task, decision);
        if (rejection) {
          // Cognitive state, not an effect: a stale or foreign reference is refused and shown back, never fatal.
          await this.#options.execution.appendStepWithin(uow, owned, token, { ...command, outcome: 'refused', error: rejection }, now, events);
          await this.event(uow, owned.task, owned.run.runId, 'goal.change.rejected', now, events, { operation: decision.change.operation, code: rejection.code });
          return { kind: 'continued' };
        }
        await this.#options.execution.appendStepWithin(uow, owned, token, command, now, events);
        await this.#applyGoalChange(uow, owned.task, decision, now, events);
        return { kind: 'continued' };
      }

      await this.#options.execution.appendStepWithin(uow, owned, token, command, now, events);
      let referenceId: string | null = null;
      let kind: TaskWait['kind'];
      let dueAt: string | null = null;
      if (decision.type === 'wait') {
        kind = decision.condition.kind;
        dueAt = decision.condition.kind === 'WAIT_UNTIL' ? decision.condition.until : null;
      } else {
        const known = new Set((await uow.listObservations(owned.task.taskId)).map((o) => o.observationId));
        if (decision.contextRefs.some((id) => !known.has(id))) throw new PlatformError('validation', 'unknown_evidence', 'human context references must be observations of this task');
        if (decision.type === 'request_consultation' && decision.expiresAt && Date.parse(decision.expiresAt) <= Date.parse(now)) {
          throw new PlatformError('validation', 'expiry_in_past', 'consultation expiry must be in the future');
        }
        referenceId = this.#options.ids.next();
        const base = { requestId: referenceId, taskId: owned.task.taskId, runId: owned.run.runId, status: 'requested' as const, humanRef: null, createdAt: now, updatedAt: now, correlationId: owned.task.correlationId };
        const request: HumanRequest =
          decision.type === 'request_consultation'
            ? { ...base, kind: 'consultation', expiresAt: decision.expiresAt ?? null, payload: { question: decision.question, contextRefs: decision.contextRefs } }
            : { ...base, kind: 'handoff', expiresAt: null, payload: { summary: decision.summary, contextRefs: decision.contextRefs, initiatedBy: 'agent' } };
        await p.insertHuman(request);
        await this.event(uow, owned.task, referenceId, request.kind === 'consultation' ? 'consultation.requested' : 'handoff.requested', now, events);
        if (request.expiresAt) await this.scheduleWithin(uow, owned.task, 'human_expiry', referenceId, request.expiresAt, now, events);
        kind = 'WAIT_FOR_HUMAN';
      }
      const reason = decision.type === 'request_handoff' ? 'human_handoff' : 'waiting';
      const active = (await uow.findActiveRun(owned.task.taskId))!;
      const run = await finishRunWithin(uow, active, { status: 'suspended', termination: { reason, code: reason, message: 'task suspended by a structured agent decision' }, correlationId: owned.task.correlationId }, now, events);
      const task = await transitionTaskWithin(uow, this.#options.ids, owned.task, reason === 'human_handoff' ? 'blocked' : 'waiting', reason, workerPrincipal(token.owner), owned.task.correlationId, now, events);
      await uow.releaseLease(token);
      const wait = await this.#openWait(uow, task, run.runId, kind, referenceId, dueAt, now, events);
      if (dueAt) await this.scheduleWithin(uow, task, 'wake', wait.waitId, dueAt, now, events);
      // Input that arrived while the model was deciding must not be stranded behind a stale wait.
      if ((kind === 'WAIT_FOR_INPUT' || kind === 'WAIT_UNTIL') && (await p.hasUnseenInput(task.taskId, command.contextSnapshotId ?? null))) {
        const woken = await this.wakeWithin(uow, task, wait, 'input', now, events);
        if (woken.status === 'running') await this.cancelSchedulesWithin(uow, woken, now, events, wait.waitId);
      }
      return { kind: 'suspended', termination: run.termination! };
    });
  }

  /** Recoverable refusals only; anything else (corruption, conflicts) still throws. */
  async #goalRejection(uow: ExecutionUnitOfWork, task: AgentTask, decision: ManageGoalDecision): Promise<{ code: GoalRejectionCode; message: string } | null> {
    const { change } = decision;
    const id = change.operation === 'create' ? change.parentGoalId : change.goalId;
    const target = await uow.lockGoal(id);
    if (!target) return { code: 'goal_not_found', message: `goal ${id} does not exist` };
    if (target.taskId !== task.taskId) return { code: 'goal_task_mismatch', message: `goal ${id} does not belong to this task` };
    if (target.status !== 'active') return { code: 'goal_not_active', message: `goal ${id} is ${target.status}: a closed goal cannot be changed, focused or extended` };
    return null;
  }

  async #applyGoalChange(uow: ExecutionUnitOfWork, task: AgentTask, decision: ManageGoalDecision, now: string, events: PendingEvent[]): Promise<void> {
    const { change } = decision;
    const target = (await uow.lockGoal(change.operation === 'create' ? change.parentGoalId : change.goalId))!;
    let goalId = target.goalId;
    if (change.operation === 'create') {
      // The parent exists, is active and belongs to this task; a fresh child cannot close a cycle.
      const goal = parseOrThrow(goalSchema, {
        goalId: this.#options.ids.next(), taskId: task.taskId, parentGoalId: target.goalId, description: change.description, successCriteria: change.successCriteria,
        status: 'active', origin: 'agent', version: 1, correlationId: task.correlationId, createdAt: now, updatedAt: now,
      });
      await uow.insertGoal(goal);
      goalId = goal.goalId;
      await this.event(uow, task, goal.goalId, 'goal.created', now, events, { parentGoalId: target.goalId });
    } else if (change.operation === 'complete' || change.operation === 'abandon') {
      const status = change.operation === 'complete' ? 'achieved' : 'abandoned';
      if (!(await uow.updateGoal({ ...target, status, version: target.version + 1, updatedAt: now }, target.version))) {
        throw new PlatformError('conflict', 'version_conflict', 'goal changed concurrently');
      }
      await this.event(uow, task, target.goalId, change.operation === 'complete' ? 'goal.completed' : 'goal.abandoned', now, events, { lifetimeMs: Date.parse(now) - Date.parse(target.createdAt) });
    }
    // Closing a goal never moves focus implicitly: the agent returns to the root explicitly.
    if (change.operation === 'focus' || (change.operation === 'create' && change.makeCurrent)) {
      await updateTaskOrThrow(uow, { ...task, currentGoalId: goalId, version: task.version + 1, updatedAt: now }, task.version);
      await this.event(uow, task, goalId, 'goal.focus.changed', now, events, { from: task.currentGoalId });
    }
  }

  // -------------------------------------------------------------------------
  // Inbound input
  // -------------------------------------------------------------------------

  /**
   * Canonical inbound input. Idempotent on (task, source, external key): the
   * same event re-delivered is one durable input and one effective wake. A
   * task waiting for input — or waiting until a time (interruptible) — wakes
   * now; its timer is cancelled so it can never wake the task again.
   */
  async submitInput(taskId: string, input: InputSubmission, actor: Principal, correlationId: string, options: SubmitInputOptions = {}): Promise<InputSubmissionResult> {
    const body = parseOrThrow(inputSubmissionSchema, input);
    const principal = parseOrThrow(principalSchema, actor);
    const hold = options.hold === undefined ? undefined : parsePlatformHold(options.hold);
    return this.write(async (uow, events) => {
      const task = await this.lockTask(uow, taskId);
      return this.#submitInputWithin(uow, events, task, body, principal, correlationId, hold);
    });
  }

  /**
   * (R4-I) Creates a task together with its first canonical input, in ONE
   * transaction: no worker can ever claim the task before the input that
   * motivated it exists (a task created first and fed later could run on an
   * empty conversation). With `hold`, the task is also born held for humans
   * (a platform-initiated handoff, visible in `attention()`), so it is never
   * claimable at all until a human releases it.
   *
   * Idempotent end to end: the task by its creation idempotency key, the
   * input by (task, source, external key). A replay (e.g. a re-delivered
   * inbound event, or a concurrent sibling event of the same new
   * conversation) submits the input to the already existing task.
   */
  async createTaskWithInput(tasks: TaskRuntime, command: CreateTaskCommand, input: InputSubmission, actor: Principal, options: SubmitInputOptions = {}): Promise<InputSubmissionResult & { taskId: string; taskReplayed: boolean }> {
    if (command.idempotencyKey === undefined) throw new PlatformError('validation', 'idempotency_key_required', 'a task created with its first input must carry an idempotency key');
    const body = parseOrThrow(inputSubmissionSchema, input);
    const principal = parseOrThrow(principalSchema, actor);
    const hold = options.hold === undefined ? undefined : parsePlatformHold(options.hold);
    const prepared = await tasks.prepareCreate(command);
    return this.write(async (uow, events) => {
      const created = await tasks.createWithin(uow, prepared, events);
      const task = await this.lockTask(uow, created.taskId);
      const submitted = await this.#submitInputWithin(uow, events, task, body, principal, command.correlationId, hold);
      return { ...submitted, taskId: created.taskId, taskReplayed: created.replayed };
    });
  }

  async #submitInputWithin(uow: ExecutionUnitOfWork, events: PendingEvent[], locked: AgentTask, body: InputSubmission, principal: Principal, correlationId: string, hold: PlatformHold | undefined): Promise<InputSubmissionResult> {
    let task = locked;
    const taskId = task.taskId;
    const p = temporalOf(uow);
    const now = await p.now();
    const hash = fingerprint({ body, principal });
    const existing = await p.input(taskId, body.sourceRef, body.externalKey);
    if (existing) {
      if (existing.requestHash !== hash) throw new PlatformError('conflict', 'idempotency_key_reused', 'input identity already has different content or actor');
      return { inputId: existing.inputId, replayed: true, held: false };
    }
    if (isTerminalTaskStatus(task.status) || (await p.terminalIntent(taskId))) {
      throw new PlatformError('conflict', 'task_not_accepting_input', 'the task is terminal or awaiting its terminal status');
    }
    // (R4-I) A hold is applied BEFORE the input exists, in the same transaction:
    // the input can then never wake the task into autonomous work.
    const held = hold !== undefined && (await this.holdForHumansWithin(uow, task, hold, now, events));
    if (held) task = await this.lockTask(uow, taskId);
    const inputId = this.#options.ids.next();
    const memoryEntryId = this.#options.ids.next();
    // The C2 ingestion seam: what was said is CONVERSATIONAL memory, recorded by the resolved principal.
    await uow.insertMemoryEntry(parseOrThrow(memoryEntrySchema, {
      entryId: memoryEntryId, taskId, memoryType: 'CONVERSATIONAL', occurredAt: body.occurredAt, recordedAt: now, recordedBy: principal, correlationId,
      content: { actor: { role: 'participant', ref: principal.ref }, text: body.content, interactionRef: inputId },
    }));
    await p.insertInput({ inputId, taskId, sourceRef: body.sourceRef, externalKey: body.externalKey, requestHash: hash, memoryEntryId, actorKind: principal.kind, actorRef: principal.ref, receivedAt: now, correlationId });
    await this.event(uow, task, inputId, 'task.input.received', now, events, { sourceRef: body.sourceRef });
    const wait = await p.activeWait(taskId);
    if (wait?.kind === 'WAIT_FOR_INPUT' || wait?.kind === 'WAIT_UNTIL') {
      const woken = await this.wakeWithin(uow, task, wait, 'input', now, events);
      if (woken.status === 'running') await this.cancelSchedulesWithin(uow, task, now, events, wait.waitId);
    }
    return { inputId, replayed: false, held };
  }

  /**
   * (R4-I) A platform-initiated hold: the task is handed to humans with a
   * platform reason code (e.g. autonomy disabled by an operator control, the
   * conversation outside an enabled cohort) — the same durable mechanism as
   * an agent- or operator-requested handoff (E), visible in `attention()`.
   * Any active run is suspended at once (its worker's next fenced write or
   * heartbeat fails), the open wait is superseded and no autonomous claim is
   * possible until a human releases it. A task that already has a requested
   * or active handoff is left as it is (humans already own it): returns false.
   * The summary is platform-authored and never shown to the model.
   */
  async holdForHumansWithin(uow: ExecutionUnitOfWork, locked: AgentTask, hold: PlatformHold, now: string, events: PendingEvent[]): Promise<boolean> {
    const p = temporalOf(uow);
    if (isTerminalTaskStatus(locked.status)) throw new PlatformError('conflict', 'task_terminal', 'a terminal task cannot be held');
    if (await p.activeHandoff(locked.taskId)) return false;
    const active = await uow.findActiveRun(locked.taskId);
    if (active) {
      await finishRunWithin(uow, active, { status: 'suspended', termination: { reason: 'human_handoff', code: 'platform_hold', message: 'the platform handed the task to humans' }, correlationId: locked.correlationId }, now, events);
    }
    const lease = await uow.lockTaskLease(locked.taskId);
    if (lease?.lease) await uow.releaseLease(lease.lease);
    let task = await this.lockTask(uow, locked.taskId);
    const request = parseOrThrow(humanRequestSchema, {
      requestId: this.#options.ids.next(), taskId: task.taskId, runId: active?.runId ?? null, kind: 'handoff', status: 'requested', humanRef: null,
      createdAt: now, updatedAt: now, expiresAt: null, correlationId: task.correlationId,
      payload: { summary: hold.summary, contextRefs: [], initiatedBy: 'platform', reason: hold.reason },
    });
    await p.insertHuman(request);
    await this.event(uow, task, request.requestId, 'handoff.requested', now, events, { initiatedBy: 'platform', reason: hold.reason });
    const wait = await p.activeWait(task.taskId);
    if (wait) {
      await p.finishWait(wait.waitId, 'cancelled', 'handoff', now);
      await this.event(uow, task, wait.waitId, 'task.wait.completed', now, events, { resolution: 'handoff', durationMs: Date.parse(now) - Date.parse(wait.createdAt) });
      await this.cancelSchedulesWithin(uow, task, now, events, wait.waitId);
    }
    if (task.status !== 'blocked') {
      task = await transitionTaskWithin(uow, this.#options.ids, task, 'blocked', hold.reason, { kind: 'system', ref: PLATFORM_ACTOR }, task.correlationId, now, events);
    }
    await this.#openWait(uow, task, active?.runId ?? null, 'WAIT_FOR_HUMAN', request.requestId, null, now, events);
    return true;
  }

  /**
   * (R4-I) The inverse of `holdForHumansWithin`, for a trusted platform
   * caller: the task's open handoff must be platform-initiated with exactly
   * `release.reason` and still `requested` (no human accepted it). It takes
   * the same transition as a human cancelling a requested handoff —
   * `requested → cancelled`, its timers cancelled, its WAIT_FOR_HUMAN woken
   * through `wakeWithin` (so terminal intent, uncertain effects and a newer
   * human owner still win). It never starts a run, never calls a model and
   * never touches delivery: the task only becomes claimable again. Agent-,
   * operator- or differently-caused handoffs are refused untouched.
   */
  async releasePlatformHold(taskId: string, release: PlatformHoldRelease): Promise<HumanRequest> {
    const body = parsePlatformHoldRelease(release);
    return this.write(async (uow, events) => {
      const task = await this.lockTask(uow, taskId);
      const p = temporalOf(uow);
      const now = await p.now();
      if (isTerminalTaskStatus(task.status)) throw new PlatformError('conflict', 'task_terminal', 'the task is already terminal');
      const handoff = await p.activeHandoff(taskId);
      if (!handoff) throw new PlatformError('conflict', 'platform_hold_not_open', 'the task has no open hold (already released or never held)');
      if (handoff.payload.initiatedBy !== 'platform' || handoff.payload.reason !== body.reason) {
        throw new PlatformError('precondition', 'platform_hold_mismatch', `the task's open handoff is not a platform hold for ${body.reason}; it needs a human`);
      }
      if (handoff.status !== 'requested') throw new PlatformError('precondition', 'handoff_owned_by_human', 'a human owns the task; only that human can release it');
      const updated: HumanRequest = { ...handoff, status: 'cancelled', updatedAt: now };
      await p.updateHuman(updated);
      await this.event(uow, task, handoff.requestId, 'handoff.cancelled', now, events, {
        kind: 'handoff', status: 'cancelled', outcome: 'platform_release', initiatedBy: 'platform', reason: body.reason, content: body.note, latencyMs: Date.parse(now) - Date.parse(handoff.createdAt),
      }, body.actorRef, null, body.correlationId);
      await this.cancelSchedulesWithin(uow, task, now, events, handoff.requestId);
      const wait = await p.activeWait(taskId);
      if (wait?.referenceId === handoff.requestId) await this.wakeWithin(uow, task, wait, 'human', now, events);
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Human collaboration
  // -------------------------------------------------------------------------

  /**
   * A human's answer, approval decision or handoff transition. Idempotent on
   * (request, responseKey); exactly one terminal decision per request (the
   * task lock serializes concurrent responses). The human's text is durable
   * evidence with human provenance — never canonical business state.
   */
  async respondHuman(requestId: string, response: HumanResponse, context: TrustedHumanContext): Promise<HumanRequest> {
    const human = parseOrThrow(trustedHumanContextSchema, context);
    const body = parseOrThrow(humanResponseSchema, response);
    return this.write(async (uow, events) => {
      const p = temporalOf(uow);
      const found = await p.human(requestId);
      if (!found) throw new PlatformError('not_found', 'human_request_not_found', 'human request not found');
      const task = await this.lockTask(uow, found.taskId);
      const request = (await p.human(requestId))!;
      const now = await p.now();
      requireScope(human, request.kind === 'consultation' ? 'consultation.answer' : request.kind === 'approval' ? 'approval.decide' : 'handoff.manage');
      const requestHash = fingerprint({ body, humanRef: human.humanRef });
      const previous = await p.response(requestId, body.responseKey);
      if (previous) {
        if (previous.data.requestHash !== requestHash) throw new PlatformError('conflict', 'idempotency_key_reused', 'human response identity already has different content');
        return request;
      }
      if (request.status === 'requested' && request.expiresAt && Date.parse(request.expiresAt) <= Date.parse(now)) {
        throw new PlatformError('conflict', 'human_request_expired', 'human request deadline has passed');
      }
      let status: HumanRequest['status'];
      let event: TelemetryEventName;
      if (body.outcome === 'release' && request.kind === 'handoff' && request.status === 'active') {
        if (request.humanRef !== human.humanRef) throw new PlatformError('precondition', 'human_owner_mismatch', 'only the current operator can release ownership');
        status = 'released';
        event = 'handoff.released';
      } else {
        if (request.status !== 'requested') throw new PlatformError('conflict', 'human_request_terminal', 'request already has an effective decision');
        if (body.outcome === 'cancel') [status, event] = ['cancelled', `${request.kind}.cancelled`];
        else if (request.kind === 'consultation' && body.outcome === 'answer') [status, event] = ['answered', 'consultation.answered'];
        else if (request.kind === 'approval' && body.outcome === 'approve') [status, event] = ['approved', 'approval.approved'];
        else if (request.kind === 'approval' && body.outcome === 'reject') [status, event] = ['rejected', 'approval.rejected'];
        else if (request.kind === 'handoff' && body.outcome === 'accept') [status, event] = ['active', 'handoff.activated'];
        else throw new PlatformError('validation', 'invalid_human_response', 'response does not match the request kind or state');
      }
      if (isTerminalTaskStatus(task.status)) throw new PlatformError('conflict', 'task_terminal', 'the task is already terminal');
      const updated: HumanRequest = { ...request, status, humanRef: human.humanRef, updatedAt: now };
      await p.updateHuman(updated);
      await this.event(uow, task, requestId, event, now, events, {
        requestHash, status, kind: request.kind, outcome: body.outcome, content: body.content, latencyMs: Date.parse(now) - Date.parse(request.createdAt),
      }, human.humanRef, body.responseKey, human.correlationId);
      if (status === 'active') {
        await this.#blockForHuman(uow, task, now, events, human);
        return updated;
      }
      await this.cancelSchedulesWithin(uow, task, now, events, requestId);
      const wait = await p.activeWait(task.taskId);
      if (wait?.referenceId === requestId) await this.wakeWithin(uow, task, wait, 'human', now, events);
      return updated;
    });
  }

  /**
   * Operator-initiated handoff: a trusted human takes operational ownership
   * without the agent asking. Any active run is suspended at once (its
   * worker's next fenced write or heartbeat fails), the open wait is
   * superseded, and no autonomous claim is possible until release.
   * Idempotent on `responseKey`.
   */
  async takeOver(taskId: string, takeover: HandoffTakeover, context: TrustedHumanContext): Promise<HumanRequest> {
    const human = parseOrThrow(trustedHumanContextSchema, context);
    const body = parseOrThrow(handoffTakeoverSchema, takeover);
    requireScope(human, 'handoff.manage');
    return this.write(async (uow, events) => {
      let task = await this.lockTask(uow, taskId);
      const p = temporalOf(uow);
      const now = await p.now();
      const requestHash = fingerprint({ body, humanRef: human.humanRef });
      const previous = await p.response(taskId, body.responseKey);
      if (previous) {
        if (previous.data.requestHash !== requestHash) throw new PlatformError('conflict', 'idempotency_key_reused', 'takeover identity already has different content');
        return (await p.human(previous.data.requestId as string))!;
      }
      if (isTerminalTaskStatus(task.status)) throw new PlatformError('conflict', 'task_terminal', 'a terminal task cannot be taken over');
      const existing = await p.activeHandoff(taskId);
      if (existing?.status === 'active') throw new PlatformError('conflict', 'handoff_already_active', 'a human already owns the task');

      const active = await uow.findActiveRun(taskId);
      if (active) {
        await finishRunWithin(uow, active, { status: 'suspended', termination: { reason: 'human_handoff', code: 'operator_takeover', message: 'a human operator took ownership of the task' }, correlationId: task.correlationId }, now, events);
      }
      const locked = await uow.lockTaskLease(taskId);
      if (locked?.lease) await uow.releaseLease(locked.lease);
      let request: HumanRequest;
      if (existing) {
        request = { ...existing, status: 'active', humanRef: human.humanRef, updatedAt: now };
        await p.updateHuman(request);
      } else {
        request = {
          requestId: this.#options.ids.next(), taskId, runId: active?.runId ?? null, kind: 'handoff', status: 'active', humanRef: human.humanRef,
          createdAt: now, updatedAt: now, expiresAt: null, correlationId: task.correlationId, payload: { summary: body.note, contextRefs: [], initiatedBy: 'operator' },
        };
        await p.insertHuman(request);
        await this.event(uow, task, request.requestId, 'handoff.requested', now, events, { initiatedBy: 'operator' }, human.humanRef);
      }
      await this.event(uow, task, taskId, 'handoff.activated', now, events, {
        requestHash, requestId: request.requestId, kind: 'handoff', outcome: 'accept', status: 'active', content: body.note, initiatedBy: existing ? existing.payload.initiatedBy : 'operator',
      }, human.humanRef, body.responseKey, human.correlationId);
      task = (await this.lockTask(uow, taskId));
      await this.#blockForHuman(uow, task, now, events, human, request.requestId);
      return request;
    });
  }

  /** The task is human-owned: supersede whatever it was waiting for and hold it on the handoff. */
  async #blockForHuman(uow: ExecutionUnitOfWork, task: AgentTask, now: string, events: PendingEvent[], human: TrustedHumanContext, handoffId?: string): Promise<void> {
    const p = temporalOf(uow);
    const handoff = handoffId ?? (await p.activeHandoff(task.taskId))?.requestId;
    const wait = await p.activeWait(task.taskId);
    if (wait && wait.referenceId === handoff) return;
    if (wait) {
      await p.finishWait(wait.waitId, 'cancelled', 'handoff', now);
      await this.event(uow, task, wait.waitId, 'task.wait.completed', now, events, { resolution: 'handoff', durationMs: Date.parse(now) - Date.parse(wait.createdAt) });
      await this.cancelSchedulesWithin(uow, task, now, events, wait.waitId);
    }
    let current = task;
    if (current.status !== 'blocked') {
      current = await transitionTaskWithin(uow, this.#options.ids, current, 'blocked', 'human_handoff', { kind: 'user', ref: human.humanRef }, human.correlationId, now, events);
    }
    await this.#openWait(uow, current, null, 'WAIT_FOR_HUMAN', handoff ?? null, null, now, events);
  }

  /**
   * Cancels the task durably: its run, wait, open human requests and timers.
   * An in-flight or uncertain external effect is never treated as not having
   * happened: the task stays `blocked` with a cancellation intent until
   * reconciliation establishes the outcome (then it becomes `cancelled`).
   */
  async cancelTask(taskId: string, context: TrustedHumanContext): Promise<AgentTask> {
    const human = parseOrThrow(trustedHumanContextSchema, context);
    requireScope(human, 'task.cancel');
    return this.write(async (uow, events) => {
      let task = await this.lockTask(uow, taskId);
      const p = temporalOf(uow);
      const now = await p.now();
      if (isTerminalTaskStatus(task.status)) return task;
      const active = await uow.findActiveRun(taskId);
      // Marks any attempt in flight `needs_reconciliation` (and its durable work) in this transaction.
      if (active) await finishRunWithin(uow, active, { status: 'cancelled', correlationId: human.correlationId }, now, events);
      const locked = await uow.lockTaskLease(taskId);
      if (locked?.lease) await uow.releaseLease(locked.lease);
      const wait = await p.activeWait(taskId);
      if (wait) await p.finishWait(wait.waitId, 'cancelled', 'cancelled', now);
      for (const h of await p.listHumans(taskId)) {
        if (h.status !== 'requested' && h.status !== 'active') continue;
        const status = h.status === 'active' ? 'released' : 'cancelled';
        await p.updateHuman({ ...h, status, updatedAt: now });
        await this.event(uow, task, h.requestId, status === 'released' ? 'handoff.released' : `${h.kind}.cancelled`, now, events, { cause: 'task_cancelled' }, human.humanRef);
      }
      await this.cancelSchedulesWithin(uow, task, now, events);
      task = await transitionTaskWithin(uow, this.#options.ids, task, 'cancelled', 'cancelled', { kind: 'user', ref: human.humanRef }, human.correlationId, now, events);
      await this.event(uow, task, taskId, task.status === 'cancelled' ? 'task.cancelled' : 'task.terminal.deferred', now, events, { targetStatus: 'cancelled' }, human.humanRef);
      return task;
    });
  }

  /**
   * Operator recovery seam for reconciliation that ran out of attempts or
   * time: grants a fresh attempt budget and deadline under the same durable
   * policy. The outcome stays unknown — no human can declare it.
   */
  async rescheduleReconciliation(executionId: string, request: { responseKey: string }, context: TrustedHumanContext): Promise<Schedule> {
    const human = parseOrThrow(trustedHumanContextSchema, context);
    requireScope(human, 'reconciliation.manage');
    return this.write(async (uow, events) => {
      const p = temporalOf(uow);
      const execution = await p.execution(executionId);
      if (!execution) throw new PlatformError('not_found', 'execution_not_found', 'action execution not found');
      const task = await this.lockTask(uow, execution.taskId);
      const schedule = await p.scheduleFor('reconciliation', executionId);
      if (!schedule) throw new PlatformError('internal', 'reconciliation_work_missing', 'uncertain execution has no reconciliation work');
      const now = await p.now();
      const previous = await p.response(schedule.scheduleId, request.responseKey);
      if (previous) return schedule;
      if (schedule.status !== 'exhausted' || !schedule.policy) throw new PlatformError('conflict', 'reconciliation_not_exhausted', `reconciliation is ${schedule.status}`);
      const rescheduled: Schedule = {
        ...schedule, status: 'pending', attempts: 0, dueAt: now, deadlineAt: new Date(Date.parse(now) + schedule.policy.deadlineMs).toISOString(), owner: null, leaseExpiresAt: null, updatedAt: now,
      };
      await p.updateSchedule(rescheduled);
      await this.event(uow, task, schedule.scheduleId, 'reconciliation.rescheduled', now, events, { executionId, previousAttempts: schedule.attempts }, human.humanRef, request.responseKey, human.correlationId);
      return rescheduled;
    });
  }

  // -------------------------------------------------------------------------
  // Scheduler side (claims time, never cognition or capabilities)
  // -------------------------------------------------------------------------

  async claimSchedule(owner: string, leaseMs: number): Promise<Schedule | null> {
    if (!Number.isInteger(leaseMs) || leaseMs <= 0 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner)) {
      throw new PlatformError('validation', 'invalid_scheduler_config', 'valid owner and positive lease duration required');
    }
    return this.write(async (uow, events) => {
      const p = temporalOf(uow);
      let schedule = await p.claimDueSchedule(owner, leaseMs);
      if (!schedule) return null;
      // Claim locks only the schedule row (no task lock afterwards: no inverse lock order).
      const now = await p.now();
      if (schedule.kind === 'reconciliation' && !schedule.policy) {
        const policy = this.#options.reconciliationPolicy;
        if (!policy) throw new PlatformError('precondition', 'reconciliation_policy_required', 'configure reconciliation attempts, backoff and deadline explicitly');
        schedule = { ...schedule, policy, deadlineAt: new Date(Date.parse(schedule.createdAt) + policy.deadlineMs).toISOString() };
        await p.updateSchedule(schedule);
      }
      await p.event({ eventId: this.#options.ids.next(), taskId: schedule.taskId, entityId: schedule.scheduleId, type: 'schedule.claimed', occurredAt: now, correlationId: schedule.correlationId, actorRef: owner, responseKey: null, data: { kind: schedule.kind, generation: schedule.generation, dueAt: schedule.dueAt } });
      events.push(['schedule.claimed', { taskId: schedule.taskId, scheduleId: schedule.scheduleId, kind: schedule.kind, generation: schedule.generation }]);
      return schedule;
    });
  }

  /**
   * Fires a claimed schedule: a timer wakes its wait, an expiry expires its
   * human request, a retry deadline releases its task for claiming, a due
   * reconciliation is dispatched to workers. Fenced by the schedule token:
   * a stale or duplicate firing is refused, so a wake is effective once.
   */
  async fireSchedule(token: ScheduleToken): Promise<void> {
    await this.write(async (uow, events) => {
      const task = await this.lockTask(uow, token.taskId);
      const p = temporalOf(uow);
      const s = await p.lockSchedule(token);
      const now = await p.now();
      const lagMs = Date.parse(now) - Date.parse(s.dueAt);
      if (s.kind === 'reconciliation') {
        if (s.status !== 'claimed') throw new PlatformError('conflict', 'schedule_lease_lost', 'reconciliation is not claimed by the scheduler');
        await p.updateSchedule({ ...s, status: 'dispatched', owner: null, leaseExpiresAt: null, updatedAt: now });
        await this.event(uow, task, s.scheduleId, 'schedule.fired', now, events, { kind: s.kind, generation: s.generation, lagMs, executionId: s.referenceId }, token.owner);
        return;
      }
      await p.updateSchedule({ ...s, status: 'fired', owner: null, leaseExpiresAt: null, updatedAt: now });
      await this.event(uow, task, s.scheduleId, 'schedule.fired', now, events, { kind: s.kind, generation: s.generation, lagMs }, token.owner);
      const wait = await p.activeWait(task.taskId);
      if (s.kind === 'human_expiry') {
        const human = await p.human(s.referenceId);
        if (human?.status === 'requested' && human.expiresAt && Date.parse(human.expiresAt) <= Date.parse(now)) {
          await p.updateHuman({ ...human, status: 'expired', updatedAt: now });
          await this.event(uow, task, human.requestId, human.kind === 'approval' ? 'approval.expired' : 'consultation.expired', now, events);
          if (wait?.referenceId === human.requestId) await this.wakeWithin(uow, task, wait, 'timer', now, events);
        }
      } else if (s.kind === 'wake' && wait?.waitId === s.referenceId) {
        await this.wakeWithin(uow, task, wait, 'timer', now, events);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Shared transitions (callers hold the task lock)
  // -------------------------------------------------------------------------

  /**
   * Satisfies `wait` and makes the task runnable again — unless something
   * still prevents autonomous work: a terminal status or intent, a human
   * owner, or an effect whose outcome is not established. A wake decides
   * nothing: the next run's kernel does, from a fresh context.
   */
  async wakeWithin(uow: ExecutionUnitOfWork, task: AgentTask, wait: TaskWait, resolution: WaitResolution, now: string, events: PendingEvent[]): Promise<AgentTask> {
    const p = temporalOf(uow);
    if (isTerminalTaskStatus(task.status) || (await p.terminalIntent(task.taskId))) return task;
    if (await p.activeHandoff(task.taskId)) return task;
    const uncertain = await p.unresolved(task.taskId);
    if (uncertain.length > 0) {
      // The wait is satisfied, but an effect of the task is still unknown: record what
      // satisfied it and hold the task on reconciliation instead (never autonomous work).
      if (wait.kind === 'WAIT_FOR_RECONCILIATION') return task;
      await p.finishWait(wait.waitId, 'completed', resolution, now);
      await this.event(uow, task, wait.waitId, 'task.wait.completed', now, events, { kind: wait.kind, resolution, durationMs: Date.parse(now) - Date.parse(wait.createdAt) });
      await this.#openWait(uow, task, uncertain[0]!.runId, 'WAIT_FOR_RECONCILIATION', uncertain[0]!.executionId, null, now, events);
      return task;
    }
    await p.finishWait(wait.waitId, 'completed', resolution, now);
    await this.event(uow, task, wait.waitId, 'task.wait.completed', now, events, { kind: wait.kind, resolution, durationMs: Date.parse(now) - Date.parse(wait.createdAt) });
    if (task.status === 'running' || task.status === 'pending') return task;
    const updated = await transitionTaskWithin(uow, this.#options.ids, task, 'running', 'temporal_wake', { kind: 'system', ref: PLATFORM_ACTOR }, task.correlationId, now, events);
    await this.event(uow, updated, wait.waitId, 'task.woken', now, events, { kind: wait.kind, resolution });
    return updated;
  }

  /**
   * After a reconciliation established an outcome: once no effect of the
   * task is uncertain, a deferred terminal status is applied, otherwise a
   * task blocked only by uncertainty becomes runnable (a human owner keeps it).
   */
  async settleAfterReconciliationWithin(uow: ExecutionUnitOfWork, task: AgentTask, now: string, events: PendingEvent[]): Promise<AgentTask> {
    const p = temporalOf(uow);
    if (isTerminalTaskStatus(task.status) || (await uow.countUncertainActionExecutions(task.taskId)) > 0) return task;
    const wait = await p.activeWait(task.taskId);
    const intent = await p.terminalIntent(task.taskId);
    if (intent) {
      if (wait) await p.finishWait(wait.waitId, 'cancelled', 'cancelled', now);
      const actor: Principal = { kind: 'system', ref: PLATFORM_ACTOR };
      const closed = await transitionTaskWithin(uow, this.#options.ids, task, intent.targetStatus, intent.reason, actor, task.correlationId, now, events);
      await this.event(uow, closed, task.taskId, intent.targetStatus === 'cancelled' ? 'task.cancelled' : 'task.terminal.applied', now, events, { targetStatus: intent.targetStatus, reason: intent.reason, deferredMs: Date.parse(now) - Date.parse(intent.requestedAt) });
      return closed;
    }
    if (task.status !== 'blocked' || (await p.activeHandoff(task.taskId))) return task;
    if (wait && wait.kind !== 'WAIT_FOR_RECONCILIATION') return task;
    if (wait) return this.wakeWithin(uow, task, wait, 'reconciliation', now, events);
    const updated = await transitionTaskWithin(uow, this.#options.ids, task, 'running', 'temporal_wake', { kind: 'system', ref: PLATFORM_ACTOR }, task.correlationId, now, events);
    await this.event(uow, updated, task.taskId, 'task.woken', now, events, { resolution: 'reconciliation' });
    return updated;
  }

  /** Opens the task's single wait (the database allows one) and records it. */
  async #openWait(uow: ExecutionUnitOfWork, task: AgentTask, runId: string | null, kind: TaskWait['kind'], referenceId: string | null, dueAt: string | null, now: string, events: PendingEvent[]): Promise<TaskWait> {
    const wait: TaskWait = { waitId: this.#options.ids.next(), taskId: task.taskId, runId, kind, status: 'waiting', resolution: null, referenceId, dueAt, createdAt: now, completedAt: null, correlationId: task.correlationId };
    await temporalOf(uow).insertWait(wait);
    await this.event(uow, task, wait.waitId, 'task.wait.started', now, events, { kind, referenceId, dueAt });
    return wait;
  }

  /**
   * (ADR-028) The human fallback of a run failure: recovery was exhausted,
   * or the model failure is not retryable. The task is not terminated: it
   * becomes `blocked` on a platform-initiated handoff — visible in
   * `attention()` — with a WAIT_FOR_HUMAN, exactly like a handoff the agent
   * asked for. An operator accepts and releases it (autonomy resumes: the
   * next claim starts a new run), cancels the request (same), or cancels the
   * task. The summary is platform-authored codes only (never model output)
   * and is never shown to the model.
   */
  async handOffAfterRunFailureWithin(uow: ExecutionUnitOfWork, task: AgentTask, run: AgentRun, cause: RunFailureHandoffCause, events: PendingEvent[]): Promise<AgentTask> {
    const p = temporalOf(uow);
    const now = await p.now();
    const summary =
      cause.consecutiveFailures === null
        ? `Run ${run.sequence} failed (${cause.terminationReason}: ${cause.code}); the failure is not retryable, so no automatic run was started. An operator must decide how the task continues.`
        : `Run ${run.sequence} failed (${cause.terminationReason}: ${cause.code}); ${cause.consecutiveFailures} consecutive recoverable run failure(s) exhausted automatic recovery. An operator must decide how the task continues.`;
    const request = parseOrThrow(humanRequestSchema, {
      requestId: this.#options.ids.next(), taskId: task.taskId, runId: run.runId, kind: 'handoff', status: 'requested', humanRef: null,
      createdAt: now, updatedAt: now, expiresAt: null, correlationId: task.correlationId,
      payload: { summary, contextRefs: [], initiatedBy: 'platform', reason: cause.reason },
    });
    await p.insertHuman(request);
    await this.event(uow, task, request.requestId, 'handoff.requested', now, events, {
      initiatedBy: 'platform', reason: cause.reason, runId: run.runId, terminationReason: cause.terminationReason, code: cause.code, consecutiveFailures: cause.consecutiveFailures,
    });
    const blocked = await transitionTaskWithin(uow, this.#options.ids, task, 'blocked', cause.reason, cause.actor, task.correlationId, now, events);
    await this.#openWait(uow, blocked, run.runId, 'WAIT_FOR_HUMAN', request.requestId, null, now, events);
    return blocked;
  }

  /** Records the wait of a task the action runtime just blocked on an uncertain effect. */
  async blockOnUncertainWithin(uow: ExecutionUnitOfWork, task: AgentTask, runId: string, executionId: string, now: string, events: PendingEvent[]): Promise<void> {
    if (await temporalOf(uow).activeWait(task.taskId)) return;
    await this.#openWait(uow, task, runId, 'WAIT_FOR_RECONCILIATION', executionId, null, now, events);
    await this.event(uow, task, executionId, 'reconciliation.scheduled', now, events, { executionId });
  }

  /** Opens the approval wait of a REQUIRE_APPROVAL decision (called by the action runtime in its transaction). */
  async requestApprovalWithin(uow: ExecutionUnitOfWork, task: AgentTask, request: HumanRequest, now: string, events: PendingEvent[]): Promise<void> {
    await temporalOf(uow).insertHuman(request);
    await this.event(uow, task, request.requestId, 'approval.requested', now, events);
    await this.#openWait(uow, task, request.runId, 'WAIT_FOR_APPROVAL', request.requestId, null, now, events);
  }

  async scheduleWithin(uow: ExecutionUnitOfWork, task: AgentTask, kind: Schedule['kind'], referenceId: string, dueAt: string, now: string, events: PendingEvent[]): Promise<Schedule> {
    const s = await temporalOf(uow).insertSchedule({
      scheduleId: this.#options.ids.next(), taskId: task.taskId, kind, referenceId, status: 'pending', dueAt, deadlineAt: null, policy: null, attempts: 0,
      owner: null, generation: 0, leaseExpiresAt: null, createdAt: now, updatedAt: now, correlationId: task.correlationId,
    });
    await this.event(uow, task, s.scheduleId, 'schedule.created', now, events, { kind, dueAt });
    return s;
  }

  /** Cancels pending/claimed timers (all, or those of one reference). Reconciliation work is never cancelled. */
  async cancelSchedulesWithin(uow: ExecutionUnitOfWork, task: AgentTask, now: string, events: PendingEvent[], referenceId?: string): Promise<void> {
    const p = temporalOf(uow);
    for (const s of await p.listSchedules(task.taskId)) {
      if (s.kind === 'reconciliation' || (s.status !== 'pending' && s.status !== 'claimed') || (referenceId !== undefined && s.referenceId !== referenceId)) continue;
      await p.updateSchedule({ ...s, status: 'cancelled', owner: null, leaseExpiresAt: null, updatedAt: now });
      await this.event(uow, task, s.scheduleId, 'schedule.cancelled', now, events, { kind: s.kind });
    }
  }

  /** Durable temporal evidence + telemetry. Telemetry never carries conversational content. */
  async event(
    uow: ExecutionUnitOfWork,
    task: AgentTask,
    entityId: string,
    type: TelemetryEventName,
    now: string,
    events: PendingEvent[],
    data: Record<string, unknown> = {},
    actorRef = PLATFORM_ACTOR,
    responseKey: string | null = null,
    correlationId = task.correlationId,
  ): Promise<void> {
    await temporalOf(uow).event({ eventId: this.#options.ids.next(), taskId: task.taskId, entityId, type, occurredAt: now, correlationId, actorRef, responseKey, data });
    const { content: _content, requestHash: _hash, ...safe } = data;
    events.push([type, { taskId: task.taskId, entityId, correlationId, ...scalarsOf(safe) }]);
  }

  async lockTask(uow: ExecutionUnitOfWork, taskId: string): Promise<AgentTask> {
    const task = await uow.lockTask(taskId);
    if (!task) throw new PlatformError('not_found', 'task_not_found', 'task not found');
    return task;
  }

  /** One transaction; telemetry only after commit. */
  async write<T>(fn: (uow: ExecutionUnitOfWork, events: PendingEvent[]) => Promise<T>): Promise<T> {
    const events: PendingEvent[] = [];
    const result = await this.#options.store.transaction((uow) => fn(uow, events));
    for (const [name, fields] of events) emitTelemetry(this.#options.logger, name, fields);
    return result;
  }
}

function requireScope(human: TrustedHumanContext, scope: HumanScope): void {
  if (!human.scopes.includes(scope)) throw new PlatformError('precondition', 'human_scope_denied', `operator lacks the ${scope} scope`);
}

/** Bounded, non-conversational telemetry fields (numbers, booleans, short codes). */
function scalarsOf(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 64) || v === null));
}
