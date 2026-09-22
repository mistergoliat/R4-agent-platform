import pg from 'pg';
import { testAdminDatabaseUrl } from './env.js';

/**
 * Integration suites require a real PostgreSQL. They fail loudly (never skip
 * silently) when it is missing, pointing at the documented way to start it.
 */
export default async function setup(): Promise<void> {
  const client = new pg.Client({ connectionString: testAdminDatabaseUrl(), connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query('select 1');
  } catch (error) {
    throw new Error(
      `PostgreSQL is not reachable at R4_TEST_DATABASE_URL (${redact(testAdminDatabaseUrl())}). ` +
        `Start it with "npm run db:up". Cause: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

function redact(url: string): string {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = '***';
  return parsed.toString();
}
