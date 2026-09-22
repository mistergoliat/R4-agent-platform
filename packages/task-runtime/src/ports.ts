import type {
  AgentRun,
  AgentTask,
  Goal,
  RegisteredAgentDefinition,
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
}

/** Narrow view of the Agent Registry the Task Runtime needs. */
export interface AgentDefinitionResolver {
  /** Exact version, or the latest registered version when omitted. */
  resolve(agentId: string, version?: number): Promise<RegisteredAgentDefinition | null>;
}
