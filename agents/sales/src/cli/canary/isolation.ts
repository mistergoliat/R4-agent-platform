import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { PlatformError } from '@r4/contracts';

/**
 * (R4-J3D-R) Isolation of the Sales canary: it runs the real Sales agent
 * only against a dedicated PostgreSQL database that proves it is one.
 *
 *   marker     `COMMENT ON DATABASE` = `r4-sales-canary:v1:<canaryId>`,
 *              written once by `sales:canary init` on an EMPTY database.
 *              A production database never carries it; no migration,
 *              table or harness state is involved.
 *   name       the database name must contain "canary" (a second,
 *              independent guard against a mistyped URL).
 *   traffic    no conversation binding, inbound event or outbound message
 *              of any channel other than the synthetic one. Checked at
 *              every command and before every worker claim
 *              (`CanaryAdmission`), so a database that ever received real
 *              traffic stops the canary at once.
 *
 * Tasks, runs, queues, schedules and outbound messages live in that
 * database only: `claimRunnableTask` and the delivery claim cannot cross
 * databases, so no production worker or gateway can see canary work and
 * the canary can never see theirs.
 */
export const CANARY_MARKER_PREFIX = 'r4-sales-canary:v1:';
/** The synthetic channel: inbound injected by the canary, outbound captured locally. Never a provider. */
export const SYNTHETIC_CHANNEL = 'r4-synthetic';
/** Who attributes canary-side administrative changes (autonomy in the canary database). */
export const CANARY_ACTOR = 'platform:sales-canary';

const NAME = /canary/i;

export interface CanaryDatabaseState {
  readonly database: string;
  readonly canaryId: string | null;
  /** Tables outside the system schemas (0 for a fresh database). */
  readonly userTables: number;
}

export async function readCanaryDatabase(pool: pg.Pool): Promise<CanaryDatabaseState> {
  const { rows } = await pool.query<{ database: string; marker: string | null; user_tables: string }>(
    `select current_database() as database,
            shobj_description(d.oid, 'pg_database') as marker,
            (select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema'))::text as user_tables
       from pg_database d where d.datname = current_database()`,
  );
  const row = rows[0]!;
  const marker = row.marker ?? '';
  return { database: row.database, canaryId: marker.startsWith(CANARY_MARKER_PREFIX) ? marker.slice(CANARY_MARKER_PREFIX.length) : null, userTables: Number(row.user_tables) };
}

/**
 * Marks a database as a Sales canary. Only an EMPTY database whose name
 * contains "canary" is ever marked; an already marked one is returned as
 * is. Anything else is refused untouched (it may be a production database).
 */
export async function markCanaryDatabase(pool: pg.Pool): Promise<{ canaryId: string; created: boolean }> {
  const state = await readCanaryDatabase(pool);
  if (!NAME.test(state.database)) throw new PlatformError('precondition', 'canary_database_name', 'the canary database name must contain "canary"');
  if (state.canaryId) return { canaryId: state.canaryId, created: false };
  if (state.userTables > 0) throw new PlatformError('precondition', 'not_a_canary_database', 'the database already has tables and no canary marker; the canary only initializes an empty, dedicated database');
  const canaryId = randomBytes(6).toString('hex');
  const { rows } = await pool.query<{ sql: string }>(`select format('comment on database %I is %L', current_database(), $1::text) as sql`, [`${CANARY_MARKER_PREFIX}${canaryId}`]);
  await pool.query(rows[0]!.sql);
  return { canaryId, created: true };
}

/** Foreign (non-synthetic) traffic recorded in the database, per table. */
export async function foreignTraffic(pool: pg.Pool): Promise<{ bindings: number; inbound: number; outbound: number }> {
  const { rows } = await pool.query<{ bindings: string; inbound: string; outbound: string }>(
    `select (select count(*) from channel_conversation_bindings where channel <> $1)::text as bindings,
            (select count(*) from inbound_events where channel <> $1)::text as inbound,
            (select count(*) from outbound_messages where channel <> $1)::text as outbound`,
    [SYNTHETIC_CHANNEL],
  );
  const r = rows[0]!;
  return { bindings: Number(r.bindings), inbound: Number(r.inbound), outbound: Number(r.outbound) };
}

/** Throws unless this is a marked canary database (by name and marker) without foreign traffic. Returns the canary id. */
export async function assertIsolatedCanaryDatabase(pool: pg.Pool): Promise<string> {
  const state = await readCanaryDatabase(pool);
  if (!NAME.test(state.database)) throw new PlatformError('precondition', 'canary_database_name', 'the canary database name must contain "canary"');
  if (!state.canaryId) throw new PlatformError('precondition', 'canary_marker_missing', 'the database carries no Sales canary marker; run "sales:canary init" on an empty, dedicated database');
  const foreign = await foreignTraffic(pool);
  if (foreign.bindings + foreign.inbound + foreign.outbound > 0) {
    throw new PlatformError('precondition', 'canary_isolation_violated', `the canary database holds non-synthetic channel traffic (bindings ${foreign.bindings}, inbound ${foreign.inbound}, outbound ${foreign.outbound}); the canary refuses to run on it`);
  }
  return state.canaryId;
}

/**
 * Worker admission of the canary (the worker's public `admission` seam):
 * the canary isolation must still hold AND the autonomy controls of the
 * canary database must admit. Asked before every claim; any failure to
 * decide refuses the claim.
 */
export class CanaryAdmission {
  readonly #pool: pg.Pool;
  readonly #controls: { admit(): Promise<{ readonly admitted: boolean; readonly reason: string }> };

  constructor(pool: pg.Pool, controls: { admit(): Promise<{ readonly admitted: boolean; readonly reason: string }> }) {
    this.#pool = pool;
    this.#controls = controls;
  }

  async admit(): Promise<{ admitted: boolean; reason: string }> {
    try {
      await assertIsolatedCanaryDatabase(this.#pool);
    } catch (error) {
      return { admitted: false, reason: error instanceof PlatformError ? error.code : 'canary_isolation_unverifiable' };
    }
    return this.#controls.admit();
  }
}
