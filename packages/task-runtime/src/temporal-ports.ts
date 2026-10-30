import type { ActionExecution, ApprovalRequest, Goal, Handoff, HumanRequest, RunStep, Schedule, ScheduleToken, TaskWait, TemporalEvent, WaitResolution } from '@r4/contracts';
import type { ServedAgents } from './ports.js';

/** A task's deferred terminal status (`task_terminal_intents`). */
export interface TerminalIntent {
  readonly targetStatus: 'cancelled' | 'failed';
  readonly reason: string;
  readonly actorKind: string;
  readonly actorRef: string;
  readonly requestedAt: string;
}

/** Durable interaction records of a task, for the cross-run conversation projection. */
export interface InteractionRecords {
  /** Every step of every run of the task, in order (the projection selects what it shows). */
  readonly steps: readonly RunStep[];
  readonly humans: readonly HumanRequest[];
  /** Human decisions (events with `responseKey`), carrying the human's explicit text. */
  readonly responses: readonly TemporalEvent[];
  readonly waits: readonly TaskWait[];
  /** (R4-J4-R7-2) `turn.closure.reconsider` events: the platform asked the agent to reconsider a silent closing. */
  readonly closures: readonly TemporalEvent[];
}

/** (R4-J4-R7-2) A conversational input (`actor_kind = 'user'`), as the turn guard names it. */
export interface ConversationInputRef {
  readonly inputId: string;
  readonly memoryEntryId: string;
  readonly receivedAt: string;
}

/**
 * (R4-J4-R7-2) The conversational obligation of a task against the context
 * snapshot `H` of a closing decision (R4_J4_R7_DESIGN §2). Structure only:
 * what the inputs mean is the model's, never derived here.
 */
export interface TurnObligation {
  /** The oldest conversational input `H` never evaluated (UNSEEN). Same `seen` rule as `hasUnseenInput`. */
  readonly unseen: ConversationInputRef | null;
  /**
   * (G2) The oldest input whose content the model did not receive, though evaluated: raw in no snapshot a decision
   * came from, or `L` uncovered and not raw in `H`. Snapshots record what they exclude too, and a compacted item
   * reaches the model only as an excerpt nothing verifies as sufficient: evaluated wakes a task, only delivered can
   * authorize a closing.
   */
  readonly undelivered: ConversationInputRef | null;
  /** The latest conversational input: the frontier `L`. */
  readonly frontier: ConversationInputRef | null;
  /** (G2) Every input neither a reply included nor a closing named, oldest first: what a silent closing would leave. */
  readonly pending: readonly ConversationInputRef[];
  /**
   * `L` is covered: a recorded `respond` whose snapshot included `L` and whose
   * outbound was not discarded, or a ratified closing (`turn.closed_without_reply`) of `L`.
   */
  readonly covered: boolean;
  /** The latest `turn.closure.reconsider` of `L`; `shown` = its episode was INCLUDED in `H`. */
  readonly reconsider: { readonly eventId: string; readonly stepId: string | null; readonly shown: boolean } | null;
  /** Audit metadata only, never a decision input: a recorded `respond` exists; conversational inputs no reply saw. */
  readonly hadPriorReply: boolean;
  readonly trailingCount: number;
}

/**
 * R4-E persistence operations. SQL only: the Temporal and Action runtimes
 * decide every transition; callers hold the task row lock (or, for schedule
 * claims, only the schedule row) inside one transaction. Time comes from
 * `now()` — the database temporal clock (`r4_now()`).
 */
export interface TemporalPersistence {
  /** The temporal clock (`r4_now()`): the single authority for due times, schedule leases and human/wait records. */
  now(): Promise<string>;
  listGoals(taskId: string): Promise<Goal[]>;

  insertWait(wait: TaskWait): Promise<void>;
  activeWait(taskId: string): Promise<TaskWait | null>;
  finishWait(waitId: string, status: 'completed' | 'cancelled', resolution: WaitResolution, at: string): Promise<void>;
  listWaits(taskId: string): Promise<TaskWait[]>;

  insertHuman(request: HumanRequest): Promise<void>;
  human(requestId: string): Promise<HumanRequest | null>;
  humanByProposal(proposalId: string): Promise<ApprovalRequest | null>;
  activeHandoff(taskId: string): Promise<Handoff | null>;
  listHumans(taskId?: string): Promise<HumanRequest[]>;
  updateHuman(request: HumanRequest): Promise<void>;

  /** Inserts, or returns the existing schedule for (kind, referenceId). */
  insertSchedule(schedule: Schedule): Promise<Schedule>;
  /** Scheduler claim: the oldest due pending (or lease-expired claimed) schedule, SKIP LOCKED; generation + 1. */
  claimDueSchedule(owner: string, leaseMs: number): Promise<Schedule | null>;
  /** Worker claim: the oldest dispatched (or lease-expired in-progress) reconciliation, SKIP LOCKED; generation + 1. */
  claimReconciliation(owner: string, leaseMs: number, served?: ServedAgents): Promise<Schedule | null>;
  /** Row-locks a schedule and verifies the token (owner, generation, unexpired lease on the temporal clock). */
  lockSchedule(token: ScheduleToken): Promise<Schedule>;
  scheduleFor(kind: Schedule['kind'], referenceId: string): Promise<Schedule | null>;
  updateSchedule(schedule: Schedule): Promise<void>;
  listSchedules(taskId: string): Promise<Schedule[]>;

  event(event: TemporalEvent): Promise<void>;
  response(entityId: string, responseKey: string): Promise<TemporalEvent | null>;
  events(taskId: string): Promise<TemporalEvent[]>;

  input(taskId: string, sourceRef: string, externalKey: string): Promise<{ inputId: string; requestHash: string } | null>;
  insertInput(input: { inputId: string; taskId: string; sourceRef: string; externalKey: string; requestHash: string; memoryEntryId: string; actorKind: string; actorRef: string; receivedAt: string; correlationId: string }): Promise<void>;
  /**
   * Whether the task has an input whose memory entry the given snapshot never evaluated. It decides waking, where
   * evaluated is the right question: a wake for an excluded input would recompile, exclude it and wake again.
   */
  hasUnseenInput(taskId: string, snapshotId: string | null): Promise<boolean>;
  /** (R4-J4-R7-2) The task's conversational obligation against the snapshot of a closing decision. */
  turnObligation(taskId: string, snapshotId: string | null): Promise<TurnObligation>;

  terminalIntent(taskId: string): Promise<TerminalIntent | null>;
  /** Executions of the task (or of all tasks) whose outcome is not established. */
  unresolved(taskId?: string): Promise<ActionExecution[]>;
  execution(executionId: string): Promise<ActionExecution | null>;
  /**
   * The proposal (of an earlier run of the task) that must be resolved before
   * cognition: an approved one still to re-authorize/execute, or a rejected /
   * expired / cancelled one whose human outcome is not observed yet.
   */
  pendingApprovalProposal(taskId: string): Promise<string | null>;

  interactionRecords(taskId: string): Promise<InteractionRecords>;
}

