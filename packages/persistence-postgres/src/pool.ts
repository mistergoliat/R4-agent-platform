import pg from 'pg';
import { PlatformError } from '@r4/contracts';
import type { StructuredLogger } from '@r4/observability';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  connectionString: string;
  logger: StructuredLogger;
  applicationName?: string;
  max?: number;
}

export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? 'r4-agent-platform',
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  // Idle clients can error when the server restarts. Without a listener that
  // would crash the process; the pool discards the client and reconnects later.
  pool.on('error', (error) => {
    options.logger.warn({ err: { message: error.message, code: (error as { code?: string }).code } }, 'postgres idle client error');
  });
  return pool;
}

/**
 * Runs `fn` inside a single transaction. Any error rolls back. Connection-level
 * failures destroy the client instead of returning it to the pool.
 */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw mapPgError(error);
  }
  let broken = false;
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      broken = true;
    }
    throw mapPgError(error);
  } finally {
    client.release(broken);
  }
}

/** Runs a query outside an explicit transaction, mapping driver errors. */
export async function query<R extends pg.QueryResultRow>(pool: pg.Pool, text: string, values: unknown[] = []): Promise<pg.QueryResult<R>> {
  try {
    return await pool.query<R>(text, values);
  } catch (error) {
    throw mapPgError(error);
  }
}

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '08000', '08003', '08006']);

/** Translates driver errors into the platform taxonomy. PlatformErrors pass through. */
export function mapPgError(error: unknown): unknown {
  if (error instanceof PlatformError) return error;
  const code = (error as { code?: string } | null)?.code;
  const constraint = (error as { constraint?: string } | null)?.constraint;
  switch (code) {
    case '23505':
      return new PlatformError('conflict', 'unique_violation', `uniqueness constraint violated${constraint ? ` (${constraint})` : ''}`, { constraint });
    case '23503':
      return new PlatformError('precondition', 'reference_violation', `referenced record does not exist${constraint ? ` (${constraint})` : ''}`, { constraint });
    case '40001':
    case '40P01':
      return new PlatformError('conflict', 'concurrent_modification', 'concurrent modification; retry the request', { code });
  }
  const message = error instanceof Error ? error.message : String(error);
  if ((code && CONNECTION_ERROR_CODES.has(code)) || /Connection terminated|timeout exceeded when trying to connect/i.test(message)) {
    return new PlatformError('unavailable', 'database_unavailable', 'database is unavailable', { code });
  }
  return error;
}
