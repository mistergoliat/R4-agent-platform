import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createSilentLogger } from '@r4/observability';
import { createPool, migrate, type Pool } from '@r4/persistence-postgres';
import { databaseUrlFor, testAdminDatabaseUrl } from './env.js';

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  drop(): Promise<void>;
}

/** Creates an empty, uniquely named database. Every test file gets its own. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = testAdminDatabaseUrl();
  const name = `r4_it_${randomBytes(6).toString('hex')}`;
  await withAdmin(adminUrl, (client) => client.query(`create database ${name}`));
  return {
    name,
    url: databaseUrlFor(adminUrl, name),
    drop: () => withAdmin(adminUrl, (client) => client.query(`drop database if exists ${name} with (force)`)).then(() => undefined),
  };
}

/** Empty database + all migrations applied. */
export async function createMigratedTestDatabase(): Promise<TestDatabase> {
  const db = await createTestDatabase();
  const pool = openPool(db.url);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  return db;
}

export function openPool(url: string): Pool {
  return createPool({ connectionString: url, logger: createSilentLogger(), applicationName: 'r4-tests', max: 5 });
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
