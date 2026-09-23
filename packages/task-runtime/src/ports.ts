import type {
  ActionAttempt,
  ActionExecution,
  ActionProposal,
  ActionReceipt,
  AgentRun,
  AgentTask,
  ContextSnapshot,
  PolicyDecision,
  Goal,
  LeaseToken,
  MemoryEntry,
  Observation,
  RegisteredAgentDefinition,
  RunStep,
  TaskLease,
  TaskTransition,
  TaskView,
} from '@r4/contracts';

/**
 * Persistence ports for the Task Runtime. The runtime computes every state
 * change; stores only persist it atomically. Implementations must be durable
 * (PostgreSQL in R4-B) — no state required for recovery may live in memory.
 */
export interface TaskRuntimeStore {
  /** Runs `fn` in one atomic transaction; everything commits or nothing does. */
  transaction<T>(fn: (uow: TaskUnitOfWork) => Promise<T>): Promise<T>;
  getTaskView(taskId: string): Promise<TaskView | null>;
  getRun(runId: string): Promise<AgentRun | null>;
  listTransitions(taskId: string): Promise<TaskTransition[]>;
}

export interface IdempotencyRecord {
  readonly key: string;
  readonly requestHash: string;
}

export interface TaskUnitOfWork {
  findTaskByIdempotencyKey(
    principalRef: string,
    key: string,
  ): Promise<{ task: AgentTask; requestHash: string } | null>;
  /** Returns `duplicate_idempotency_key` instead of throwing when a concurrent create won. */
  insertTask(task: AgentTask, idempotency: IdempotencyRecord | null): Promise<'inserted' | 'duplicate_idempotency_key'>;
  /** Reads and row-locks the task for the rest of the transaction. */
  lockTask(taskId: string): Promise<AgentTask | null>;
  /** Optimistic concurrency: returns false when the stored version differs. */
  updateTask(task: AgentTask, expectedVersion: number): Promise<boolean>;
  insertTransition(transition: TaskTransition): Promise<void>;

  insertGoal(goal: Goal): Promise<void>;
  lockGoal(goalId: string): Promise<Goal | null>;
  updateGoal(goal: Goal, expectedVersion: number): Promise<boolean>;

  insertRun(run: AgentRun): Promise<void>;
  lockRun(runId: string): Promise<AgentRun | null>;
  findActiveRun(taskId: string): Promise<AgentRun | null>;
  nextRunSequence(taskId: string): Promise<number>;
  updateRun(run: AgentRun, expectedVersion: number): Promise<boolean>;
  /**
   * (R4-D) When a run ends, every action execution of it still `executing`
   * (an attempt's outcome is unknown) becomes `needs_reconciliation`, so no
   * exit path — finish, suspension, abandonment or cancellation — leaves an
   * ambiguous effect looking like anything but what it is. Returns the count.
   */
  flagUnresolvedActionExecutions(runId: string, timestamp: string): Promise<number>;
}

/** Narrow view of the Agent Registry the Task Runtime needs. */
export interface AgentDefinitionResolver {
  /** Exact version, or the latest registered version when omitted. */
  resolve(agentId: string, version?: number): Promise<RegisteredAgentDefinition | null>;
}

/** A task row locked for the rest of the transaction, with its lease as of the database clock. */
export interface LockedTaskLease {
  readonly task: AgentTask;
  readonly lease: TaskLease | null;
  /** Database time at lock acquisition: the only clock leases are judged by. */
  readonly dbNow: Date;
}

export interface ClaimedTask {
  readonly task: AgentTask;
  readonly lease: TaskLease;
  /** Owner of the lease that was replaced; null when the task was unowned (never leased or released). */
  readonly previousOwner: string | null;
}

/**
 * Persistence ports for worker execution (R4-C1). Same rule as the Task
 * Runtime: the service decides, the store persists atomically. Leases are
 * evaluated on the database clock so that no worker's local clock is
 * authoritative.
 */
export interface ExecutionStore {
  transaction<T>(fn: (uow: ExecutionUnitOfWork) => Promise<T>): Promise<T>;
  /**
   * Heartbeat: single statement extending a lease that is still held (owner +
   * generation match, not expired, task running). Returns null otherwise.
   * Never touches the task's version or business state.
   */
  renewLease(token: LeaseToken, durationMs: number): Promise<TaskLease | null>;
}

export interface ExecutionUnitOfWork extends TaskUnitOfWork {
  /**
   * Leases the oldest runnable task (pending/running) that no live lease holds.
   * Atomic under concurrency: candidates are row-locked with SKIP LOCKED and
   * the lease condition is re-evaluated on the locked row, so two workers can
   * never both obtain the same task. Increments the fencing generation.
   */
  claimRunnableTask(owner: string, leaseDurationMs: number): Promise<ClaimedTask | null>;
  /** Row-locks the task; every owner-only write starts here. */
  lockTaskLease(taskId: string): Promise<LockedTaskLease | null>;
  /** Clears the lease if (owner, generation) still match. Keeps the generation. */
  releaseLease(token: LeaseToken): Promise<boolean>;

  listRunSteps(runId: string): Promise<RunStep[]>;
  findStepByInvocationId(invocationId: string): Promise<RunStep | null>;
  insertRunStep(step: RunStep): Promise<void>;
  /** Pending → observed. Returns false when the step is no longer pending. */
  completePendingStep(step: RunStep): Promise<boolean>;

  listObservations(taskId: string): Promise<Observation[]>;
  /** Idempotent on `source.invocationId`; returns the stored row either way. */
  insertObservation(observation: Observation): Promise<Observation>;

  /** R4-C2: the latest attempt recorded for (run, iteration), or null. */
  findLatestContextSnapshot(runId: string, iteration: number): Promise<ContextSnapshot | null>;
  /** Snapshots are immutable: insert only (the store must refuse updates and deletes). */
  insertContextSnapshot(snapshot: ContextSnapshot): Promise<void>;
  /**
   * Appends a memory entry. A DERIVED_SUMMARY is idempotent on (task,
   * derivation key): the stored entry is returned when it already exists.
   */
  insertMemoryEntry(entry: MemoryEntry): Promise<MemoryEntry>;

  // R4-D governed execution. Proposals, decisions, attempts (once finished)
  // and receipts are immutable: the store must refuse any other change.
  insertActionProposal(proposal: ActionProposal): Promise<void>;
  findActionProposal(proposalId: string): Promise<ActionProposal | null>;
  insertPolicyDecision(decision: PolicyDecision): Promise<void>;
  findPolicyDecisionByProposal(proposalId: string): Promise<PolicyDecision | null>;
  insertActionExecution(execution: ActionExecution): Promise<void>;
  findActionExecutionByProposal(proposalId: string): Promise<ActionExecution | null>;
  /** Status change only (the command is immutable). Optimistic: false when the version moved. */
  updateActionExecutionStatus(execution: ActionExecution, expectedVersion: number): Promise<boolean>;
  /** Commands created for the task (write budget). */
  countActionExecutions(taskId: string): Promise<number>;
  listActionAttempts(executionId: string): Promise<ActionAttempt[]>;
  insertActionAttempt(attempt: ActionAttempt): Promise<void>;
  /** Records an attempt's outcome, once. False when it already has one. */
  finishActionAttempt(attempt: ActionAttempt): Promise<boolean>;
  insertActionReceipt(receipt: ActionReceipt): Promise<void>;
  findActionReceiptByExecution(executionId: string): Promise<ActionReceipt | null>;
  findObservationByProposal(proposalId: string): Promise<Observation | null>;
}
