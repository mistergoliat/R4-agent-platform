import type {
  ActionAttempt,
  ActionExecution,
  ActionProposal,
  ActionReceipt,
  JsonObject,
  JsonValue,
  PolicyDecision,
  TrustedActionContext,
} from '@r4/contracts';
import { query, type Pool } from './pool.js';
import { iso, jsonb, type Row } from './rows.js';

/**
 * R4-D governed-execution ledger: proposals, policy decisions, executions
 * (commands), attempts and receipts. Rows come from our own database
 * (trusted); every write was validated by the runtime first, and the schema
 * enforces immutability and the cross-record invariants (migration 0004).
 */

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

export function proposalFromRow(row: Row): ActionProposal {
  return {
    proposalId: row.proposal_id as string,
    taskId: row.task_id as string,
    runId: row.run_id as string,
    stepId: row.step_id as string,
    iteration: row.iteration as number,
    agentId: row.agent_id as string,
    agentVersion: row.agent_version as number,
    capabilityId: row.capability_id as string,
    arguments: row.arguments as JsonObject,
    evidenceRefs: row.evidence_refs as string[],
    contextSnapshotId: (row.context_snapshot_id as string | null) ?? null,
    leaseGeneration: row.lease_generation as number,
    correlationId: row.correlation_id as string,
    createdAt: iso(row.created_at),
  };
}

export function policyDecisionFromRow(row: Row): PolicyDecision {
  return {
    decisionId: row.decision_id as string,
    proposalId: row.proposal_id as string,
    taskId: row.task_id as string,
    runId: row.run_id as string,
    agentId: row.agent_id as string,
    agentVersion: row.agent_version as number,
    capabilityId: row.capability_id as string,
    capabilityVersion: row.capability_version as number,
    riskClass: row.risk_class as PolicyDecision['riskClass'],
    outcome: row.outcome as PolicyDecision['outcome'],
    reasonCode: row.reason_code as string,
    rule: row.rule as string,
    message: row.message as string,
    policy: {
      policyId: row.policy_id as string,
      version: row.policy_version as number,
      hash: row.policy_hash as string,
      engineVersion: row.engine_version as string,
    },
    identityAssurance: row.identity_assurance as PolicyDecision['identityAssurance'],
    leaseGeneration: row.lease_generation as number,
    correlationId: row.correlation_id as string,
    evaluatedAt: iso(row.evaluated_at),
  };
}

export function executionFromRow(row: Row): ActionExecution {
  return {
    executionId: row.execution_id as string,
    proposalId: row.proposal_id as string,
    policyDecisionId: row.policy_decision_id as string,
    taskId: row.task_id as string,
    runId: row.run_id as string,
    capabilityId: row.capability_id as string,
    capabilityVersion: row.capability_version as number,
    riskClass: row.risk_class as ActionExecution['riskClass'],
    executionKey: row.execution_key as string,
    semantics: {
      recovery: row.recovery_strategy as ActionExecution['semantics']['recovery'],
      reconcileSupported: row.reconcile_supported as boolean,
      maxAttempts: row.max_attempts as number,
      initialBackoffMs: row.initial_backoff_ms as number,
    },
    validatedArguments: row.validated_arguments as JsonObject,
    trustedContext: row.trusted_context as TrustedActionContext,
    correlationId: row.correlation_id as string,
    createdAt: iso(row.created_at),
    status: row.status as ActionExecution['status'],
    version: row.version as number,
    updatedAt: iso(row.updated_at),
  };
}

export function attemptFromRow(row: Row): ActionAttempt {
  return {
    attemptId: row.attempt_id as string,
    executionId: row.execution_id as string,
    attemptNumber: row.attempt_number as number,
    kind: row.kind as ActionAttempt['kind'],
    workerId: row.worker_id as string,
    leaseGeneration: row.lease_generation as number,
    startedAt: iso(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
    outcome: (row.outcome as ActionAttempt['outcome']) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    detail: (row.detail as JsonValue | null) ?? null,
  };
}

export function receiptFromRow(row: Row): ActionReceipt {
  const errorCode = (row.error_code as string | null) ?? null;
  return {
    receiptId: row.receipt_id as string,
    executionId: row.execution_id as string,
    proposalId: row.proposal_id as string,
    taskId: row.task_id as string,
    runId: row.run_id as string,
    capabilityId: row.capability_id as string,
    capabilityVersion: row.capability_version as number,
    executionKey: row.execution_key as string,
    status: row.status as ActionReceipt['status'],
    resourceRef: (row.resource_ref as string | null) ?? null,
    externalOperationRef: (row.external_operation_ref as string | null) ?? null,
    result: (row.result as JsonValue | null) ?? null,
    error: errorCode === null ? null : { code: errorCode, message: (row.error_message as string | null) ?? '', details: (row.error_details as JsonValue | null) ?? null },
    executedAt: iso(row.executed_at),
    recordedAt: iso(row.recorded_at),
    evidence: {
      obtainedVia: row.obtained_via as ActionReceipt['evidence']['obtainedVia'],
      attemptId: row.attempt_id as string,
      attemptNumber: row.attempt_number as number,
      attempts: row.attempts as number,
      replayed: row.replayed as boolean,
    },
    correlationId: row.correlation_id as string,
  };
}

export async function insertProposal(db: Queryable, p: ActionProposal): Promise<void> {
  await db.query(
    `insert into action_proposals (
       proposal_id, task_id, run_id, step_id, iteration, agent_id, agent_version, capability_id, arguments,
       evidence_refs, context_snapshot_id, lease_generation, correlation_id, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::uuid[], $11, $12, $13, $14)`,
    [p.proposalId, p.taskId, p.runId, p.stepId, p.iteration, p.agentId, p.agentVersion, p.capabilityId, jsonb(p.arguments), p.evidenceRefs, p.contextSnapshotId, p.leaseGeneration, p.correlationId, p.createdAt],
  );
}

export async function insertDecision(db: Queryable, d: PolicyDecision): Promise<void> {
  await db.query(
    `insert into policy_decisions (
       decision_id, proposal_id, task_id, run_id, agent_id, agent_version, capability_id, capability_version, risk_class,
       outcome, reason_code, rule, message, policy_id, policy_version, policy_hash, engine_version, identity_assurance,
       lease_generation, correlation_id, evaluated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      d.decisionId, d.proposalId, d.taskId, d.runId, d.agentId, d.agentVersion, d.capabilityId, d.capabilityVersion, d.riskClass,
      d.outcome, d.reasonCode, d.rule, d.message, d.policy.policyId, d.policy.version, d.policy.hash, d.policy.engineVersion, d.identityAssurance,
      d.leaseGeneration, d.correlationId, d.evaluatedAt,
    ],
  );
}

export async function insertExecution(db: Queryable, e: ActionExecution): Promise<void> {
  await db.query(
    `insert into action_executions (
       execution_id, proposal_id, policy_decision_id, task_id, run_id, capability_id, capability_version, risk_class,
       execution_key, recovery_strategy, reconcile_supported, max_attempts, initial_backoff_ms, validated_arguments,
       trusted_context, status, version, correlation_id, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20)`,
    [
      e.executionId, e.proposalId, e.policyDecisionId, e.taskId, e.runId, e.capabilityId, e.capabilityVersion, e.riskClass,
      e.executionKey, e.semantics.recovery, e.semantics.reconcileSupported, e.semantics.maxAttempts, e.semantics.initialBackoffMs, jsonb(e.validatedArguments),
      jsonb(e.trustedContext), e.status, e.version, e.correlationId, e.createdAt, e.updatedAt,
    ],
  );
}

export async function updateExecutionStatus(db: Queryable, e: ActionExecution, expectedVersion: number): Promise<boolean> {
  const result = await db.query(
    'update action_executions set status = $2, version = $3, updated_at = $4 where execution_id = $1 and version = $5',
    [e.executionId, e.status, e.version, e.updatedAt, expectedVersion],
  );
  return result.rowCount === 1;
}

export async function insertAttempt(db: Queryable, a: ActionAttempt): Promise<void> {
  await db.query(
    `insert into action_execution_attempts (
       attempt_id, execution_id, attempt_number, kind, worker_id, lease_generation, started_at, finished_at, outcome, error_code, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [a.attemptId, a.executionId, a.attemptNumber, a.kind, a.workerId, a.leaseGeneration, a.startedAt, a.finishedAt, a.outcome, a.errorCode, jsonb(a.detail)],
  );
}

export async function finishAttempt(db: Queryable, a: ActionAttempt): Promise<boolean> {
  const result = await db.query(
    `update action_execution_attempts set finished_at = $2, outcome = $3, error_code = $4, detail = $5::jsonb
      where attempt_id = $1 and outcome is null`,
    [a.attemptId, a.finishedAt, a.outcome, a.errorCode, jsonb(a.detail)],
  );
  return result.rowCount === 1;
}

export async function insertReceipt(db: Queryable, r: ActionReceipt): Promise<void> {
  await db.query(
    `insert into action_receipts (
       receipt_id, execution_id, execution_key, proposal_id, task_id, run_id, capability_id, capability_version, status,
       resource_ref, external_operation_ref, result, error_code, error_message, error_details, obtained_via, attempt_id,
       attempt_number, attempts, replayed, executed_at, recorded_at, correlation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23)`,
    [
      r.receiptId, r.executionId, r.executionKey, r.proposalId, r.taskId, r.runId, r.capabilityId, r.capabilityVersion, r.status,
      r.resourceRef, r.externalOperationRef, r.result === null ? null : JSON.stringify(r.result), r.error?.code ?? null, r.error?.message ?? null, jsonb(r.error?.details),
      r.evidence.obtainedVia, r.evidence.attemptId, r.evidence.attemptNumber, r.evidence.attempts, r.evidence.replayed, r.executedAt, r.recordedAt, r.correlationId,
    ],
  );
}

export async function one<T>(db: Queryable, sql: string, values: unknown[], map: (row: Row) => T): Promise<T | null> {
  const result = await db.query(sql, values);
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** Everything the ledger holds for one task, in order — for audit and tests. */
export interface TaskActionLedger {
  readonly proposals: ActionProposal[];
  readonly decisions: PolicyDecision[];
  readonly executions: ActionExecution[];
  readonly attempts: ActionAttempt[];
  readonly receipts: ActionReceipt[];
}

/**
 * Metrics foundation (no dashboards): everything is derived by aggregating
 * the ledger, so any future evaluation can recompute it from history.
 */
export interface ActionMetrics {
  readonly proposals: number;
  readonly decisions: { readonly allow: number; readonly deny: number; readonly requireApproval: number };
  readonly validationRejections: number;
  readonly executions: number;
  readonly attempts: { readonly execute: number; readonly replay: number; readonly reconcile: number };
  readonly receipts: { readonly succeeded: number; readonly rejected: number; readonly failed: number };
  readonly uncertainOutcomes: number;
  /** Calls the domain answered with an effect applied earlier under the same key. */
  readonly duplicatesPrevented: number;
  /** Command creation → receipt, milliseconds. */
  readonly receiptLatencyMs: { readonly count: number; readonly max: number | null; readonly avg: number | null };
}

/** Read side of the governed-execution ledger (unfenced reads only: never writes). */
export class PostgresActionLedgerStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async forTask(taskId: string): Promise<TaskActionLedger> {
    const rows = (sql: string) => query(this.#pool, sql, [taskId]).then((r) => r.rows);
    return {
      proposals: (await rows('select * from action_proposals where task_id = $1 order by created_at, proposal_id')).map(proposalFromRow),
      decisions: (await rows('select * from policy_decisions where task_id = $1 order by evaluated_at, decision_id')).map(policyDecisionFromRow),
      executions: (await rows('select * from action_executions where task_id = $1 order by created_at, execution_id')).map(executionFromRow),
      attempts: (await rows('select a.* from action_execution_attempts a join action_executions e using (execution_id) where e.task_id = $1 order by e.created_at, a.attempt_number')).map(attemptFromRow),
      receipts: (await rows('select * from action_receipts where task_id = $1 order by recorded_at, receipt_id')).map(receiptFromRow),
    };
  }

  /** Aggregates for one task, or for everything when `taskId` is omitted. */
  async metrics(taskId?: string): Promise<ActionMetrics> {
    const scope = taskId === undefined ? 'true' : 'task_id = $1';
    const values = taskId === undefined ? [] : [taskId];
    const count = async (sql: string) => Number((await query<{ n: string }>(this.#pool, sql, values)).rows[0]!.n);
    const by = async (sql: string) => Object.fromEntries((await query<{ k: string; n: string }>(this.#pool, sql, values)).rows.map((r) => [r.k, Number(r.n)]));
    const decisions = await by(`select outcome as k, count(*) as n from policy_decisions where ${scope} group by outcome`);
    const attempts = await by(`select a.kind as k, count(*) as n from action_execution_attempts a join action_executions e using (execution_id) where ${scope.replace('task_id', 'e.task_id')} group by a.kind`);
    const receipts = await by(`select status as k, count(*) as n from action_receipts where ${scope} group by status`);
    const latency = (
      await query<{ n: string; max: number | null; avg: number | null }>(
        this.#pool,
        `select count(*) as n, max(extract(epoch from (r.recorded_at - e.created_at)) * 1000)::float8 as max,
                avg(extract(epoch from (r.recorded_at - e.created_at)) * 1000)::float8 as avg
           from action_receipts r join action_executions e using (execution_id) where ${scope.replace('task_id', 'r.task_id')}`,
        values,
      )
    ).rows[0]!;
    return {
      proposals: await count(`select count(*) as n from action_proposals where ${scope}`),
      decisions: { allow: decisions.allow ?? 0, deny: decisions.deny ?? 0, requireApproval: decisions.require_approval ?? 0 },
      validationRejections: await count(`select count(*) as n from observations where source_kind = 'action' and error_code = 'write_validation_failure' and ${scope}`),
      executions: await count(`select count(*) as n from action_executions where ${scope}`),
      attempts: { execute: attempts.execute ?? 0, replay: attempts.replay ?? 0, reconcile: attempts.reconcile ?? 0 },
      receipts: { succeeded: receipts.succeeded ?? 0, rejected: receipts.rejected ?? 0, failed: receipts.failed ?? 0 },
      uncertainOutcomes: await count(`select count(*) as n from action_executions where status = 'needs_reconciliation' and ${scope}`),
      duplicatesPrevented: await count(
        `select count(*) as n from action_execution_attempts a join action_executions e using (execution_id)
          where a.kind <> 'execute' and (a.detail ->> 'replayed')::boolean is true and ${scope.replace('task_id', 'e.task_id')}`,
      ),
      receiptLatencyMs: { count: Number(latency.n), max: latency.max, avg: latency.avg },
    };
  }
}
