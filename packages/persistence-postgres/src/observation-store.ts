import type { Observation } from '@r4/contracts';
import type { ObservationStore } from '@r4/capability-runtime';
import { query, type Pool } from './pool.js';
import { jsonb, observationFromRow } from './rows.js';

/** Observations are immutable; recording is idempotent on the invocation id. */
export class PostgresObservationStore implements ObservationStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(o: Observation): Promise<Observation> {
    const inserted = await query(
      this.#pool,
      `insert into observations (
         observation_id, task_id, run_id, agent_id, source_kind, capability_id, capability_version,
         invocation_id, outcome, payload, error_code, error_message, error_details,
         observed_at, valid_until, provenance, correlation_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14, $15, $16::jsonb, $17)
       on conflict (invocation_id) do nothing
       returning *`,
      [
        o.observationId, o.taskId, o.runId, o.agentId, o.source.kind, o.source.capabilityId, o.source.capabilityVersion,
        o.source.invocationId, o.outcome, o.outcome === 'succeeded' ? JSON.stringify(o.payload) : null,
        o.error?.code ?? null, o.error?.message ?? null, jsonb(o.error?.details),
        o.observedAt, o.validUntil, jsonb(o.provenance), o.correlationId,
      ],
    );
    if (inserted.rows[0]) return observationFromRow(inserted.rows[0]);
    const existing = await this.findByInvocationId(o.source.invocationId);
    if (!existing) throw new Error(`observation for invocation ${o.source.invocationId} vanished during recording`);
    return existing;
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
