import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from '@r4/persistence-postgres';
import { migrateSales } from '@r4-sales/agent';
import { SALES_PRODUCTION_AGENT_VERSIONS } from '@r4-sales/agent/production';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { IDENTITY_KEY } from '../support/live-ops.js';

/**
 * R4-I production bootstrap through the real built command
 * (`npm run production:sales:bootstrap` → dist), one OS process per run, with
 * only a production environment (no channel or model credentials, no .env).
 * Requires `npm run build`.
 */
const CLI = fileURLToPath(new URL('../../agents/sales/dist/cli/production-bootstrap.js', import.meta.url));

let db: TestDatabase | null = null;
let pool: Pool | null = null;

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('agents/sales/dist is missing: run "npm run build" before "npm run test:recovery"');
});

afterEach(async () => {
  await pool?.end().catch(() => undefined);
  await db?.drop().catch(() => undefined);
  pool = null;
  db = null;
});

/** Every Sales definition version a production profile pins: the bootstrap registers exactly these. */
const PINNED = [...new Set(Object.values(SALES_PRODUCTION_AGENT_VERSIONS))].sort((a, b) => a - b);
const PINNED_LIST = PINNED.map((v) => `sales@${v}`).join(', ');

function run(env: Record<string, string | undefined>) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('R4_')));
  const r = spawnSync(process.execPath, [CLI], { env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('production:sales:bootstrap as a process', () => {
  it('registers every pinned Sales definition once, reports unchanged on repeat, and refuses a non-production environment', async () => {
    db = await createMigratedTestDatabase();
    pool = openPool(db.url);
    await migrateSales(pool);
    const env = { R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: 'sales-production@1', R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY, R4_PROD_ALLOW_NETWORK: 'false', R4_DATABASE_URL: db.url };

    expect(run({ ...env, R4_EXECUTION_MODE: undefined })).toMatchObject({ code: 1, stdout: '' });
    expect((await pool.query('select count(*)::int as n from agent_definitions')).rows).toEqual([{ n: 0 }]);

    expect(run(env)).toEqual({ code: 0, stdout: `production Sales bootstrap:\nregistered: ${PINNED_LIST}\n`, stderr: '' });
    expect(run(env)).toEqual({ code: 0, stdout: `production Sales bootstrap:\nunchanged: ${PINNED_LIST}\n`, stderr: '' });
    expect((await pool.query('select agent_id, version from agent_definitions order by version')).rows).toEqual(PINNED.map((version) => ({ agent_id: 'sales', version })));
  });
});
