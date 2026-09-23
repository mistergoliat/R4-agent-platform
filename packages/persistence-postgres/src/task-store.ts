import type { AgentRun, AgentTask, Goal, TaskTransition, TaskView } from '@r4/contracts';
import type { IdempotencyRecord, TaskRuntimeStore, TaskUnitOfWork } from '@r4/task-runtime';
import { query, withTransaction, type Pool, type PoolClient } from './pool.js';
import { goalFromRow, jsonb, runFromRow, taskFromRow, transitionFromRow, type Row } from './rows.js';

/** PostgreSQL implementation of the Task Runtime persistence ports. */
export class PostgresTaskRuntimeStore implements TaskRuntimeStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  transaction<T>(fn: (uow: TaskUnitOfWork) => Promise<T>): Promise<T> {
    return withTransaction(this.#pool, (client) => fn(new PostgresTaskUnitOfWork(client)));
  }

  async getTaskView(taskId: string): Promise<TaskView | null> {
    const task = await query(this.#pool, 'select * from agent_tasks where task_id = $1', [taskId]);
    const row = task.rows[0];
    if (!row) return null;
    const goals = await query(this.#pool, 'select * from goals where task_id = $1 order by created_at, goal_id', [taskId]);
    const runs = await query<{ run_id: string; sequence: number; status: AgentRun['status'] }>(
      this.#pool,
      'select run_id, sequence, status from agent_runs where task_id = $1 order by sequence',
      [taskId],
    );
    return {
      task: taskFromRow(row),
      goals: goals.rows.map(goalFromRow),
      runs: runs.rows.map((r) => ({ runId: r.run_id, sequence: r.sequence, status: r.status })),
    };
  }

  async getRun(runId: string): Promise<AgentRun | null> {
    const result = await query(this.#pool, 'select * from agent_runs where run_id = $1', [runId]);
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  async listTransitions(taskId: string): Promise<TaskTransition[]> {
    const result = await query(this.#pool, 'select * from agent_task_transitions where task_id = $1 order by task_version', [taskId]);
    return result.rows.map(transitionFromRow);
  }
}

export class PostgresTaskUnitOfWork implements TaskUnitOfWork {
  protected readonly client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
  }

  async findTaskByIdempotencyKey(principalRef: string, key: string): Promise<{ task: AgentTask; requestHash: string } | null> {
    const result = await this.client.query<Row>(
      'select * from agent_tasks where requested_by_ref = $1 and idempotency_key = $2',
      [principalRef, key],
    );
    const row = result.rows[0];
    return row ? { task: taskFromRow(row), requestHash: row.idempotency_request_hash as string } : null;
  }

  async insertTask(task: AgentTask, idempotency: IdempotencyRecord | null): Promise<'inserted' | 'duplicate_idempotency_key'> {
    const result = await this.client.query(
      `insert into agent_tasks (
         task_id, task_type, agent_id, agent_version, status, status_reason, parent_task_id,
         root_goal_id, current_goal_id, requested_by_kind, requested_by_ref,
         input, constraints, budget, result, deadline_at,
         idempotency_key, idempotency_request_hash, correlation_id, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20, $21, $22)
       on conflict (requested_by_ref, idempotency_key) where idempotency_key is not null do nothing`,
      [
        task.taskId, task.taskType, task.agentId, task.agentVersion, task.status, task.statusReason, task.parentTaskId,
        task.rootGoalId, task.currentGoalId, task.requestedBy.kind, task.requestedBy.ref,
        jsonb(task.input), jsonb(task.constraints), jsonb(task.budget), jsonb(task.result), task.deadlineAt,
        idempotency?.key ?? null, idempotency?.requestHash ?? null, task.correlationId, task.version, task.createdAt, task.updatedAt,
      ],
    );
    return result.rowCount === 1 ? 'inserted' : 'duplicate_idempotency_key';
  }

  async lockTask(taskId: string): Promise<AgentTask | null> {
    const result = await this.client.query<Row>('select * from agent_tasks where task_id = $1 for update', [taskId]);
    return result.rows[0] ? taskFromRow(result.rows[0]) : null;
  }

  /** Only lifecycle fields are mutable; identity, assignment and input are write-once. */
  async updateTask(task: AgentTask, expectedVersion: number): Promise<boolean> {
    const result = await this.client.query(
      `update agent_tasks
          set status = $2, status_reason = $3, current_goal_id = $4, result = $5::jsonb,
              version = $6, updated_at = $7
        where task_id = $1 and version = $8`,
      [task.taskId, task.status, task.statusReason, task.currentGoalId, jsonb(task.result), task.version, task.updatedAt, expectedVersion],
    );
    return result.rowCount === 1;
  }

  async insertTransition(t: TaskTransition): Promise<void> {
    await this.client.query(
      `insert into agent_task_transitions (
         transition_id, task_id, from_status, to_status, reason, actor_kind, actor_ref,
         task_version, correlation_id, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [t.transitionId, t.taskId, t.fromStatus, t.toStatus, t.reason, t.actor.kind, t.actor.ref, t.taskVersion, t.correlationId, t.occurredAt],
    );
  }

  async insertGoal(goal: Goal): Promise<void> {
    await this.client.query(
      `insert into goals (
         goal_id, task_id, parent_goal_id, description, success_criteria, status, origin,
         correlation_id, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [goal.goalId, goal.taskId, goal.parentGoalId, goal.description, goal.successCriteria, goal.status, goal.origin, goal.correlationId, goal.version, goal.createdAt, goal.updatedAt],
    );
  }

  async lockGoal(goalId: string): Promise<Goal | null> {
    const result = await this.client.query<Row>('select * from goals where goal_id = $1 for update', [goalId]);
    return result.rows[0] ? goalFromRow(result.rows[0]) : null;
  }

  async updateGoal(goal: Goal, expectedVersion: number): Promise<boolean> {
    const result = await this.client.query(
      'update goals set status = $2, version = $3, updated_at = $4 where goal_id = $1 and version = $5',
      [goal.goalId, goal.status, goal.version, goal.updatedAt, expectedVersion],
    );
    return result.rowCount === 1;
  }

  async insertRun(run: AgentRun): Promise<void> {
    await this.client.query(
      `insert into agent_runs (
         run_id, task_id, sequence, agent_id, agent_version, status, context_snapshot_ref,
         model_calls, input_tokens, output_tokens, capability_calls, result, failure_code, failure_message,
         termination_reason, termination_code, termination_message, termination_details, recoveries,
         correlation_id, version, started_at, finished_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14,
               $15, $16, $17, $18::jsonb, $19, $20, $21, $22, $23, $24, $25)`,
      [
        run.runId, run.taskId, run.sequence, run.agentId, run.agentVersion, run.status, run.contextSnapshotRef,
        run.usage.modelCalls, run.usage.inputTokens, run.usage.outputTokens, run.usage.capabilityCalls,
        jsonb(run.result), run.failure?.code ?? null, run.failure?.message ?? null,
        run.termination?.reason ?? null, run.termination?.code ?? null, run.termination?.message ?? null,
        jsonb(run.termination?.details), run.recoveries,
        run.correlationId, run.version, run.startedAt, run.finishedAt, run.createdAt, run.updatedAt,
      ],
    );
  }

  async lockRun(runId: string): Promise<AgentRun | null> {
    const result = await this.client.query<Row>('select * from agent_runs where run_id = $1 for update', [runId]);
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  async findActiveRun(taskId: string): Promise<AgentRun | null> {
    const result = await this.client.query<Row>("select * from agent_runs where task_id = $1 and status = 'running' for update", [taskId]);
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  /** Safe without extra locking: callers hold the task row lock. */
  async nextRunSequence(taskId: string): Promise<number> {
    const result = await this.client.query<{ next: number }>(
      'select coalesce(max(sequence), 0)::int + 1 as next from agent_runs where task_id = $1',
      [taskId],
    );
    return result.rows[0]!.next;
  }

  async updateRun(run: AgentRun, expectedVersion: number): Promise<boolean> {
    const result = await this.client.query(
      `update agent_runs
          set status = $2, model_calls = $3, input_tokens = $4, output_tokens = $5, capability_calls = $6,
              result = $7::jsonb, failure_code = $8, failure_message = $9,
              termination_reason = $10, termination_code = $11, termination_message = $12,
              termination_details = $13::jsonb, recoveries = $14, version = $15,
              finished_at = $16, updated_at = $17, context_snapshot_ref = $19
        where run_id = $1 and version = $18`,
      [
        run.runId, run.status, run.usage.modelCalls, run.usage.inputTokens, run.usage.outputTokens, run.usage.capabilityCalls,
        jsonb(run.result), run.failure?.code ?? null, run.failure?.message ?? null,
        run.termination?.reason ?? null, run.termination?.code ?? null, run.termination?.message ?? null,
        jsonb(run.termination?.details), run.recoveries, run.version,
        run.finishedAt, run.updatedAt, expectedVersion, run.contextSnapshotRef,
      ],
    );
    return result.rowCount === 1;
  }

  async flagUnresolvedActionExecutions(runId: string, timestamp: string): Promise<number> {
    const result = await this.client.query(
      `update action_executions
          set status = 'needs_reconciliation', version = version + 1, updated_at = greatest(updated_at, $2::timestamptz)
        where run_id = $1 and status = 'executing'`,
      [runId, timestamp],
    );
    return result.rowCount ?? 0;
  }

  async countUncertainActionExecutions(taskId: string): Promise<number> {
    const result = await this.client.query<{ n: string }>(
      "select count(*) as n from action_executions where task_id = $1 and status in ('executing', 'needs_reconciliation')",
      [taskId],
    );
    return Number(result.rows[0]!.n);
  }

  async recordTerminalIntent(intent: Parameters<TaskUnitOfWork['recordTerminalIntent']>[0]): Promise<void> {
    await this.client.query(
      `insert into task_terminal_intents (task_id, target_status, reason, actor_kind, actor_ref, correlation_id, requested_at)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (task_id) do nothing`,
      [intent.taskId, intent.targetStatus, intent.reason, intent.actor.kind, intent.actor.ref, intent.correlationId, intent.requestedAt],
    );
  }
}
