import { migrate, migrationStatus, type Pool } from '@r4/persistence-postgres';
import type { StructuredLogger } from '@r4/observability';
import { SALES_MIGRATIONS_DIR } from './definition.js';

/**
 * Applies the pack's own migrations (the `sales` schema) with the platform's
 * generic forward-only migrator. Core migrations are applied separately
 * (`npm run db:migrate`) and never contain Sales tables.
 */
export async function migrateSales(pool: Pool, logger?: StructuredLogger): Promise<{ applied: string[] }> {
  return migrate(pool, { directory: SALES_MIGRATIONS_DIR, ...(logger ? { logger } : {}) });
}

export async function salesSchemaIsCurrent(pool: Pool): Promise<boolean> {
  const status = await migrationStatus(pool, SALES_MIGRATIONS_DIR);
  return status.pending.length === 0 && status.modified.length === 0;
}
