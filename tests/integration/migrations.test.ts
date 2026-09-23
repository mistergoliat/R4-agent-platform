import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, checkDatabaseReadiness, migrate, migrationStatus, type Pool } from '@r4/persistence-postgres';
import { createTestDatabase, openPool, type TestDatabase } from '../support/database.js';

const EXPECTED_MIGRATIONS = ['0001_initial_runtime_schema', '0002_execution_kernel', '0003_context_and_memory'];
const EXPECTED_TABLES = [
  'agent_definitions', 'agent_run_steps', 'agent_runs', 'agent_task_transitions', 'agent_tasks',
  'context_snapshot_items', 'context_snapshots', 'goals', 'memory_entries', 'observations', 'r4_schema_migrations',
];

let db: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = openPool(db.url);
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('migrations from an empty database', () => {
  it('reports an empty database as not ready with all migrations pending', async () => {
    const status = await migrationStatus(pool);
    expect(status.applied).toEqual([]);
    expect(status.pending).toEqual(EXPECTED_MIGRATIONS);
    expect((await checkDatabaseReadiness(pool)).ok).toBe(false);
  });

  it('applies every migration to an empty database', async () => {
    const { applied } = await migrate(pool);
    expect(applied).toEqual(EXPECTED_MIGRATIONS);

    const tables = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
    expect(await checkDatabaseReadiness(pool)).toMatchObject({ ok: true, reachable: true, pendingMigrations: [] });
  });

  it('is idempotent: re-running applies nothing', async () => {
    expect(await migrate(pool)).toEqual({ applied: [] });
  });

  it('serializes concurrent migrators', async () => {
    const results = await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
    expect(results.flatMap((r) => r.applied)).toEqual([]);
  });

  it('detects an applied migration whose file was edited', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'r4-migrations-'));
    try {
      await cp(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
      const file = join(dir, '0001_initial_runtime_schema.sql');
      await writeFile(file, `${await readFile(file, 'utf8')}\n-- sneaky edit\n`);
      expect((await migrationStatus(pool, dir)).modified).toEqual(['0001_initial_runtime_schema']);
      await expect(migrate(pool, { directory: dir })).rejects.toMatchObject({ code: 'migration_modified' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('enforces key invariants at the database level, not only in code', async () => {
    const constraints = await pool.query<{ name: string }>(
      `select indexname as name from pg_indexes where schemaname = 'public'
       union all
       select conname as name from pg_constraint where connamespace = 'public'::regnamespace`,
    );
    const names = constraints.rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'agent_runs_one_active_per_task',
        'goals_one_root_per_task',
        'agent_tasks_idempotency_uq',
        'agent_tasks_root_goal_fk',
        'agent_tasks_current_goal_fk',
        // R4-C1
        'agent_tasks_lease_consistency',
        'agent_runs_termination_present',
        'agent_runs_termination_matches_status',
        'agent_run_steps_one_pending_per_run',
        'agent_run_steps_invocation_id_key',
        // R4-C2
        'agent_run_steps_context_snapshot_fk',
        'context_snapshots_run_id_iteration_attempt_key',
        'memory_entries_task_id_derivation_key_key',
      ]),
    );
  });
});
