import type { ExecutionExpectation, WorkerPresenceIdentity, WorkerPresenceReason, WorkerPresenceStore, WorkerPresenceSummary } from '@r4/task-runtime';
import { loadMigrations } from './migrations.js';
import { query, type Pool } from './pool.js';

/**
 * Worker presence (R4-I, 0008). Every timestamp and every freshness
 * comparison uses `clock_timestamp()`: the database is the single clock, so
 * host clock skew never makes a dead worker look alive.
 */
export class PostgresWorkerPresenceStore implements WorkerPresenceStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async registerWorker(identity: WorkerPresenceIdentity, freshForMs: number): Promise<void> {
    await query(
      this.#pool,
      `insert into worker_presence (worker_id, execution_mode, compatibility, build_ref, state, reason, started_at, heartbeat_at, expires_at)
       values ($1, $2, $3, $4, 'ready', null, clock_timestamp(), clock_timestamp(), clock_timestamp() + $5::int * interval '1 millisecond')
       on conflict (worker_id) do update set
         execution_mode = excluded.execution_mode, compatibility = excluded.compatibility, build_ref = excluded.build_ref,
         state = 'ready', reason = null, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at`,
      [identity.workerId, identity.executionMode, identity.compatibility, identity.buildRef, freshForMs],
    );
  }

  async refreshWorker(workerId: string, update: { readonly state: 'ready' | 'not_ready'; readonly reason: WorkerPresenceReason | null }, freshForMs: number): Promise<boolean> {
    const result = await query(
      this.#pool,
      `update worker_presence
          set state = $2, reason = $3, heartbeat_at = clock_timestamp(), expires_at = clock_timestamp() + $4::int * interval '1 millisecond'
        where worker_id = $1 and state <> 'stopping'`,
      [workerId, update.state, update.state === 'ready' ? null : update.reason, freshForMs],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markWorkerStopping(workerId: string): Promise<void> {
    await query(this.#pool, `update worker_presence set state = 'stopping', reason = 'shutting_down', heartbeat_at = greatest(clock_timestamp(), heartbeat_at), expires_at = greatest(clock_timestamp(), expires_at) where worker_id = $1`, [workerId]);
  }

  async summarizeWorkers(expected: ExecutionExpectation): Promise<WorkerPresenceSummary> {
    const result = await query<{ ready: number; not_ready: number; stopping: number; incompatible: number; stale: number; other_mode: number; reasons: string[] | null; build_refs: string[] | null }>(
      this.#pool,
      `with p as (
         select *, expires_at > clock_timestamp() as fresh, execution_mode = $1 as same_mode, compatibility = $2 as compatible
           from worker_presence
       )
       select count(*) filter (where fresh and same_mode and compatible and state = 'ready')::int as ready,
              count(*) filter (where fresh and same_mode and compatible and state = 'not_ready')::int as not_ready,
              count(*) filter (where fresh and same_mode and compatible and state = 'stopping')::int as stopping,
              count(*) filter (where fresh and same_mode and not compatible)::int as incompatible,
              count(*) filter (where not fresh and same_mode)::int as stale,
              count(*) filter (where fresh and not same_mode)::int as other_mode,
              array_agg(distinct reason) filter (where fresh and same_mode and compatible and state = 'not_ready') as reasons,
              array_agg(distinct build_ref) filter (where fresh and same_mode and compatible and state = 'ready' and build_ref is not null) as build_refs
         from p`,
      [expected.executionMode, expected.compatibility],
    );
    const row = result.rows[0]!;
    return {
      ready: row.ready,
      notReady: row.not_ready,
      stopping: row.stopping,
      incompatible: row.incompatible,
      stale: row.stale,
      otherMode: row.other_mode,
      reasons: (row.reasons ?? []) as WorkerPresenceReason[],
      buildRefs: (row.build_refs ?? []).slice(0, 10),
    };
  }

  async purgeExpiredWorkers(expiredForMs: number): Promise<number> {
    const result = await query(this.#pool, `delete from worker_presence where expires_at < clock_timestamp() - $1::bigint * interval '1 millisecond'`, [expiredForMs]);
    return result.rowCount ?? 0;
  }
}

/** The latest packaged Core migration: the schema half of a worker's execution-contract compatibility. */
export async function coreSchemaHead(): Promise<string> {
  const migrations = await loadMigrations();
  const head = migrations.at(-1);
  if (!head) throw new Error('no packaged Core migrations');
  return head.id;
}
