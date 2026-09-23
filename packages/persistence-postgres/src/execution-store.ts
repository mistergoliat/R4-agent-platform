import type { ActionAttempt, ActionExecution, ActionProposal, ActionReceipt, ContextSnapshot, LeaseToken, MemoryEntry, Observation, PolicyDecision, RunStep, TaskLease } from '@r4/contracts';
import type { ClaimedTask, ExecutionStore, ExecutionUnitOfWork, LockedTaskLease } from '@r4/task-runtime';
import {
  attemptFromRow,
  executionFromRow,
  finishAttempt,
  insertAttempt,
  insertDecision,
  insertExecution,
  insertProposal,
  insertReceipt,
  one,
  policyDecisionFromRow,
  proposalFromRow,
  receiptFromRow,
  updateExecutionStatus,
} from './action-store.js';
import { insertContextSnapshot, insertMemoryEntry, loadContextSnapshot } from './memory-store.js';
import { recordObservation } from './observation-store.js';
import { query, withTransaction, type Pool } from './pool.js';
import { iso, jsonb, leaseFromRow, observationFromRow, stepFromRow, taskFromRow, type Row } from './rows.js';
import { PostgresTaskUnitOfWork } from './task-store.js';

const LEASE_COLUMNS = 'task_id, lease_owner, lease_generation, lease_acquired_at, lease_expires_at, last_heartbeat_at';

/**
 * PostgreSQL implementation of the execution ports (R4-C1).
 *
 * Every lease comparison uses `clock_timestamp()`: the database is the single
 * clock for ownership, so worker clock skew cannot extend or shorten a lease.
 */
export class PostgresExecutionStore implements ExecutionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  transaction<T>(fn: (uow: ExecutionUnitOfWork) => Promise<T>): Promise<T> {
    return withTransaction(this.#pool, (client) => fn(new PostgresExecutionUnitOfWork(client)));
  }

  async renewLease(token: LeaseToken, durationMs: number): Promise<TaskLease | null> {
    const result = await query(
      this.#pool,
      `update agent_tasks
          set lease_expires_at = clock_timestamp() + $4::int * interval '1 millisecond',
              last_heartbeat_at = clock_timestamp()
        where task_id = $1 and lease_owner = $2 and lease_generation = $3
          and lease_expires_at > clock_timestamp()
          and status = 'running'
        returning ${LEASE_COLUMNS}`,
      [token.taskId, token.owner, token.generation, durationMs],
    );
    return result.rows[0] ? leaseFromRow(result.rows[0]) : null;
  }
}

class PostgresExecutionUnitOfWork extends PostgresTaskUnitOfWork implements ExecutionUnitOfWork {
  /**
   * One statement: pick the oldest runnable task whose lease is absent or
   * expired, row-lock it (SKIP LOCKED: concurrent claimers move on instead of
   * queueing), then take the lease and bump the fencing generation. Under READ
   * COMMITTED, a row changed by a concurrent claim after our snapshot is
   * re-checked against the WHERE clause once locked, so a freshly taken lease
   * is never overwritten.
   */
  async claimRunnableTask(owner: string, leaseDurationMs: number): Promise<ClaimedTask | null> {
    const result = await this.client.query<Row>(
      `with clock as (select clock_timestamp() as now),
       candidate as (
         select task_id, lease_owner as previous_owner
           from agent_tasks
          where status in ('pending', 'running')
            and (lease_expires_at is null or lease_expires_at <= (select now from clock))
          order by created_at, task_id
          limit 1
          for update skip locked
       )
       update agent_tasks t
          set lease_owner = $1,
              lease_generation = t.lease_generation + 1,
              lease_acquired_at = (select now from clock),
              lease_expires_at = (select now from clock) + $2::int * interval '1 millisecond',
              last_heartbeat_at = (select now from clock)
         from candidate c
        where t.task_id = c.task_id
        returning t.*, c.previous_owner`,
      [owner, leaseDurationMs],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { task: taskFromRow(row), lease: leaseFromRow(row)!, previousOwner: (row.previous_owner as string | null) ?? null };
  }

  async lockTaskLease(taskId: string): Promise<LockedTaskLease | null> {
    const locked = await this.client.query<Row>('select * from agent_tasks where task_id = $1 for update', [taskId]);
    const row = locked.rows[0];
    if (!row) return null;
    // Read the clock only after the lock is held: a lease that expired while we
    // waited for a concurrent claim must be seen as expired.
    const clock = await this.client.query<{ now: Date }>('select clock_timestamp() as now');
    return { task: taskFromRow(row), lease: leaseFromRow(row), dbNow: new Date(iso(clock.rows[0]!.now)) };
  }

  async releaseLease(token: LeaseToken): Promise<boolean> {
    const result = await this.client.query(
      `update agent_tasks set lease_owner = null, lease_expires_at = null
        where task_id = $1 and lease_owner = $2 and lease_generation = $3`,
      [token.taskId, token.owner, token.generation],
    );
    return result.rowCount === 1;
  }

  async listRunSteps(runId: string): Promise<RunStep[]> {
    const result = await this.client.query<Row>('select * from agent_run_steps where run_id = $1 order by iteration', [runId]);
    return result.rows.map(stepFromRow);
  }

  async findStepByInvocationId(invocationId: string): Promise<RunStep | null> {
    const result = await this.client.query<Row>('select * from agent_run_steps where invocation_id = $1', [invocationId]);
    return result.rows[0] ? stepFromRow(result.rows[0]) : null;
  }

  async insertRunStep(step: RunStep): Promise<void> {
    await this.client.query(
      `insert into agent_run_steps (
         step_id, run_id, task_id, iteration, lease_generation, decision_type, decision, outcome,
         error_code, error_message, invocation_id, observation_id, input_tokens, output_tokens,
         correlation_id, created_at, completed_at, context_snapshot_id, proposal_id)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        step.stepId, step.runId, step.taskId, step.iteration, step.leaseGeneration, step.decision?.type ?? null, jsonb(step.decision), step.outcome,
        step.error?.code ?? null, step.error?.message ?? null, step.invocationId, step.observationId, step.usage.inputTokens, step.usage.outputTokens,
        step.correlationId, step.createdAt, step.completedAt, step.contextSnapshotId, step.proposalId,
      ],
    );
  }

  async completePendingStep(step: RunStep): Promise<boolean> {
    const result = await this.client.query(
      `update agent_run_steps set outcome = $2, observation_id = $3, completed_at = $4
        where step_id = $1 and outcome = 'pending'`,
      [step.stepId, step.outcome, step.observationId, step.completedAt],
    );
    return result.rowCount === 1;
  }

  async listObservations(taskId: string): Promise<Observation[]> {
    const result = await this.client.query<Row>('select * from observations where task_id = $1 order by observed_at, observation_id', [taskId]);
    return result.rows.map(observationFromRow);
  }

  insertObservation(observation: Observation): Promise<Observation> {
    return recordObservation(this.client, observation);
  }

  async findLatestContextSnapshot(runId: string, iteration: number): Promise<ContextSnapshot | null> {
    const result = await this.client.query<Row>(
      'select * from context_snapshots where run_id = $1 and iteration = $2 order by attempt desc limit 1',
      [runId, iteration],
    );
    return result.rows[0] ? loadContextSnapshot(this.client, result.rows[0]) : null;
  }

  insertContextSnapshot(snapshot: ContextSnapshot): Promise<void> {
    return insertContextSnapshot(this.client, snapshot);
  }

  insertMemoryEntry(entry: MemoryEntry): Promise<MemoryEntry> {
    return insertMemoryEntry(this.client, entry);
  }

  // R4-D governed execution ledger
  insertActionProposal(proposal: ActionProposal): Promise<void> {
    return insertProposal(this.client, proposal);
  }

  findActionProposal(proposalId: string): Promise<ActionProposal | null> {
    return one(this.client, 'select * from action_proposals where proposal_id = $1', [proposalId], proposalFromRow);
  }

  insertPolicyDecision(decision: PolicyDecision): Promise<void> {
    return insertDecision(this.client, decision);
  }

  findPolicyDecisionByProposal(proposalId: string): Promise<PolicyDecision | null> {
    return one(this.client, 'select * from policy_decisions where proposal_id = $1', [proposalId], policyDecisionFromRow);
  }

  insertActionExecution(execution: ActionExecution): Promise<void> {
    return insertExecution(this.client, execution);
  }

  findActionExecutionByProposal(proposalId: string): Promise<ActionExecution | null> {
    // Row-locked: attempts and status changes of one command are serialized.
    return one(this.client, 'select * from action_executions where proposal_id = $1 for update', [proposalId], executionFromRow);
  }

  updateActionExecutionStatus(execution: ActionExecution, expectedVersion: number): Promise<boolean> {
    return updateExecutionStatus(this.client, execution, expectedVersion);
  }

  async countActionExecutions(taskId: string): Promise<number> {
    const result = await this.client.query<{ n: number }>('select count(*)::int as n from action_executions where task_id = $1', [taskId]);
    return result.rows[0]!.n;
  }

  async listActionAttempts(executionId: string): Promise<ActionAttempt[]> {
    const result = await this.client.query<Row>('select * from action_execution_attempts where execution_id = $1 order by attempt_number', [executionId]);
    return result.rows.map(attemptFromRow);
  }

  insertActionAttempt(attempt: ActionAttempt): Promise<void> {
    return insertAttempt(this.client, attempt);
  }

  finishActionAttempt(attempt: ActionAttempt): Promise<boolean> {
    return finishAttempt(this.client, attempt);
  }

  insertActionReceipt(receipt: ActionReceipt): Promise<void> {
    return insertReceipt(this.client, receipt);
  }

  findActionReceiptByExecution(executionId: string): Promise<ActionReceipt | null> {
    return one(this.client, 'select * from action_receipts where execution_id = $1', [executionId], receiptFromRow);
  }

  findObservationByProposal(proposalId: string): Promise<Observation | null> {
    return one(this.client, 'select * from observations where proposal_id = $1', [proposalId], observationFromRow);
  }
}
