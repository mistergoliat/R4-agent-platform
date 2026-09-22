import { migrationStatus } from './migrations.js';
import type { Pool } from './pool.js';

export interface DatabaseReadiness {
  readonly ok: boolean;
  readonly reachable: boolean;
  readonly pendingMigrations: readonly string[];
  readonly modifiedMigrations: readonly string[];
  readonly error?: string;
}

/** Ready = reachable and schema exactly at the packaged migration set. */
export async function checkDatabaseReadiness(pool: Pool): Promise<DatabaseReadiness> {
  try {
    await pool.query('select 1');
  } catch (error) {
    return { ok: false, reachable: false, pendingMigrations: [], modifiedMigrations: [], error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const status = await migrationStatus(pool);
    return {
      ok: status.pending.length === 0 && status.modified.length === 0,
      reachable: true,
      pendingMigrations: status.pending,
      modifiedMigrations: status.modified,
    };
  } catch (error) {
    return { ok: false, reachable: true, pendingMigrations: [], modifiedMigrations: [], error: error instanceof Error ? error.message : String(error) };
  }
}
