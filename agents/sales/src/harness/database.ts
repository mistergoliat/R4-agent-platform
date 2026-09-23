import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createLogger } from '@r4/observability';
import { createPool, migrate } from '@r4/persistence-postgres';
import { migrateSales } from '../migrate.js';

export interface ScenarioDatabase {
  readonly url: string;
  readonly name: string;
  drop(): Promise<void>;
}

/** Local Docker default (see docker-compose.yml); override with R4_SALES_ADMIN_DATABASE_URL or R4_TEST_DATABASE_URL. */
export function adminDatabaseUrl(env: NodeJS.ProcessEnv): string {
  return env.R4_SALES_ADMIN_DATABASE_URL ?? env.R4_TEST_DATABASE_URL ?? 'postgres://r4:r4_local_only@127.0.0.1:55432/postgres';
}

/**
 * A throwaway database with Core and Sales migrations applied, so each
 * scenario starts from nothing and cannot see another scenario's tasks.
 */
export async function createScenarioDatabase(adminUrl: string, prefix = 'r4_sales'): Promise<ScenarioDatabase> {
  const name = `${prefix}_${randomBytes(5).toString('hex')}`;
  await withAdmin(adminUrl, (c) => c.query(`create database ${name}`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = createPool({ connectionString: url.toString(), logger: createLogger({ service: 'sales-db', level: 'silent' }), applicationName: 'sales-db', max: 1 });
  try {
    await migrate(pool);
    await migrateSales(pool);
  } finally {
    await pool.end();
  }
  return { url: url.toString(), name, drop: () => withAdmin(adminUrl, (c) => c.query(`drop database if exists ${name} with (force)`)).then(() => undefined) };
}

async function withAdmin<T>(adminUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A URL safe to print: no password. */
export function redactedUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = '***';
  return parsed.toString();
}
