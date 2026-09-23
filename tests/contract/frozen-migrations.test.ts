import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations } from '@r4/persistence-postgres';

/**
 * Migrations 0001–0006 are frozen from the R4-F baseline on: a schema change
 * is a new migration, never an edit. The runtime already refuses an edited
 * migration on a database that applied it (`migration_modified`); this pins
 * the content itself, so an edit fails before any database sees it.
 * Checksums use the migrator's own normalization (LF line endings).
 */
const FROZEN: Readonly<Record<string, string>> = {
  '0001_initial_runtime_schema': '3402a0f3305c5269fb64acfc7ee0f8b38c819efa2e50d8a4722d06af269138ab',
  '0002_execution_kernel': 'ecb358a7b814764b07b42c996004fa9b33c57d4eaf6439a20308ae70479a8122',
  '0003_context_and_memory': 'cae3ed6a4eeca47c28b40189189d20a58ba2c1daae9b2d47bf81c896118590da',
  '0004_governed_execution': 'c45344ef212b65f65a718395d869e34f34b98eb88fe752e1508f40f14121ccff',
  '0005_temporal_human_runtime': '096c645e71e1f7564aec79e3749c5336f968c7da991881f6699df29a324ae96e',
  // Owned by the Sales agent pack (schema `sales`), applied by the same generic migrator.
  '0006_sales_reference_application': '856c60a15ff38c3b54e3e11c2fb0a57dfdf4da39a50e1023ce970dd5015bc684',
};

const SALES_MIGRATIONS_DIR = fileURLToPath(new URL('../../agents/sales/migrations', import.meta.url));

describe('frozen migrations (R4-F baseline)', () => {
  it('0001–0006 are byte-for-byte unchanged', async () => {
    const all = [...(await loadMigrations(DEFAULT_MIGRATIONS_DIR)), ...(await loadMigrations(SALES_MIGRATIONS_DIR))];
    const actual = Object.fromEntries(all.filter((m) => m.id in FROZEN).map((m) => [m.id, m.checksum]));
    expect(actual).toEqual(FROZEN);
  });

  it('new migrations only extend the sequence', async () => {
    for (const m of [...(await loadMigrations(DEFAULT_MIGRATIONS_DIR)), ...(await loadMigrations(SALES_MIGRATIONS_DIR))]) {
      if (!(m.id in FROZEN)) expect(Number(m.id.slice(0, 4)), m.id).toBeGreaterThan(6);
    }
  });
});
