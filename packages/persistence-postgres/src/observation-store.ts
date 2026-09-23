import type { Observation } from '@r4/contracts';
import type { ObservationStore } from '@r4/capability-runtime';
import { mapPgError, query, type Pool } from './pool.js';
import { jsonb, observationFromRow } from './rows.js';

/** Observations are immutable; recording is idempotent on the invocation id. */
export class PostgresObservationStore implements ObservationStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(o: Observation): Promise<Observation> {
    try {
      return await recordObservation(this.#pool, o);
    } catch (error) {
      throw mapPgError(error);
    }
  }

  async findByInvocationId(invocationId: string): Promise<Observation | null> {
    const result = await query(this.#pool, 'select * from observations where invocation_id = $1', [invocationId]);
    return result.rows[0] ? observationFromRow(result.rows[0]) : null;
  }

  async listByTask(taskId: string): Promise<Observation[]> {
    const result = await query(this.#pool, 'select * from observations where task_id = $1 order by observed_at, observation_id', [taskId]);
    return result.rows.map(observationFromRow);
  }
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Inserts an observation unless one already exists for its idempotency key —
 * the invocation id of a READ, or (R4-D) the proposal id of an action — and
 * returns the stored row either way. Works on a pool or inside a transaction.
 */
export async function recordObservation(db: Queryable, o: Observation): Promise<Observation> {
  const action = o.source.kind === 'action' ? o.source : null;
  const key = o.source.kind === 'action' ? { column: 'proposal_id', value: o.source.proposalId } : { column: 'invocation_id', value: o.source.invocationId };
  const inserted = await db.query(
    `insert into observations (
       observation_id, task_id, run_id, agent_id, source_kind, capability_id, capability_version,
       invocation_id, outcome, payload, error_code, error_message, error_details,
       observed_at, valid_until, provenance, correlation_id,
       proposal_id, policy_decision_id, execution_id, receipt_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14, $15, $16::jsonb, $17, $18, $19, $20, $21)
     on conflict (${key.column}) do nothing
     returning *`,
    [
      o.observationId, o.taskId, o.runId, o.agentId, o.source.kind, o.source.capabilityId, o.source.capabilityVersion,
      o.source.kind === 'capability' ? o.source.invocationId : null, o.outcome, o.outcome === 'succeeded' ? JSON.stringify(o.payload) : null,
      o.error?.code ?? null, o.error?.message ?? null, jsonb(o.error?.details),
      o.observedAt, o.validUntil, jsonb(o.provenance), o.correlationId,
      action?.proposalId ?? null, action?.policyDecisionId ?? null, action?.executionId ?? null, action?.receiptId ?? null,
    ],
  );
  if (inserted.rows[0]) return observationFromRow(inserted.rows[0]);
  const existing = await db.query(`select * from observations where ${key.column} = $1`, [key.value]);
  if (!existing.rows[0]) throw new Error(`observation for ${key.column} ${key.value} vanished during recording`);
  return observationFromRow(existing.rows[0]);
}
