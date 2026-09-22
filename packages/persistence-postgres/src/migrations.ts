import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PlatformError, sha256Hex } from '@r4/contracts';
import type { StructuredLogger } from '@r4/observability';
import { mapPgError, type Pool } from './pool.js';

/** Packaged migrations directory (works from both `src/` and `dist/`). */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const MIGRATIONS_TABLE = 'r4_schema_migrations';
/** Arbitrary constant: serializes concurrent migrators across processes. */
const MIGRATION_LOCK_KEY = 4_004_001;

export interface Migration {
  readonly id: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationStatus {
  readonly applied: readonly string[];
  readonly pending: readonly string[];
  /** Applied migrations whose file content changed afterwards. */
  readonly modified: readonly string[];
}

export async function loadMigrations(directory: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const migrations: Migration[] = [];
  for (const name of names) {
    // Normalize line endings so checksums are stable across platforms.
    const sql = (await readFile(join(directory, name), 'utf8')).replace(/\r\n/g, '\n');
    migrations.push({ id: name.replace(/\.sql$/, ''), sql, checksum: sha256Hex(sql) });
  }
  return migrations;
}

/**
 * Forward-only migrator. Each migration runs in its own transaction; an
 * advisory lock makes concurrent boots safe. Editing an applied migration is
 * detected by checksum and refused.
 */
export async function migrate(
  pool: Pool,
  options: { logger?: StructuredLogger; directory?: string } = {},
): Promise<{ applied: string[] }> {
  const migrations = await loadMigrations(options.directory);
  const client = await pool.connect().catch((error: unknown) => {
    throw mapPgError(error);
  });
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `create table if not exists ${MIGRATIONS_TABLE} (
         id text primary key,
         checksum text not null,
         applied_at timestamptz not null default now()
       )`,
    );
    const existing = new Map(
      (await client.query<{ id: string; checksum: string }>(`select id, checksum from ${MIGRATIONS_TABLE}`)).rows.map((r) => [r.id, r.checksum]),
    );
    for (const migration of migrations) {
      const checksum = existing.get(migration.id);
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) {
          throw new PlatformError('internal', 'migration_modified', `applied migration ${migration.id} was modified; add a new migration instead`);
        }
        continue;
      }
      try {
        await client.query('begin');
        await client.query(migration.sql);
        await client.query(`insert into ${MIGRATIONS_TABLE} (id, checksum) values ($1, $2)`, [migration.id, migration.checksum]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      }
      applied.push(migration.id);
      options.logger?.info({ event: 'db.migration.applied', migrationId: migration.id }, 'migration applied');
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return { applied };
}

export async function migrationStatus(pool: Pool, directory?: string): Promise<MigrationStatus> {
  const migrations = await loadMigrations(directory);
  let rows: { id: string; checksum: string }[] = [];
  try {
    const exists = await pool.query<{ exists: boolean }>(`select to_regclass($1) is not null as exists`, [MIGRATIONS_TABLE]);
    if (exists.rows[0]?.exists) {
      rows = (await pool.query<{ id: string; checksum: string }>(`select id, checksum from ${MIGRATIONS_TABLE}`)).rows;
    }
  } catch (error) {
    throw mapPgError(error);
  }
  const applied = new Map(rows.map((r) => [r.id, r.checksum]));
  return {
    applied: [...applied.keys()].sort(),
    pending: migrations.filter((m) => !applied.has(m.id)).map((m) => m.id),
    modified: migrations.filter((m) => applied.has(m.id) && applied.get(m.id) !== m.checksum).map((m) => m.id),
  };
}
