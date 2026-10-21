import { fileURLToPath } from 'node:url';
import { migrate, migrationStatus, type Pool } from '@r4/persistence-postgres';

/** This package's own forward-only migrations (schema `identity_verification`), applied by the platform's generic migrator. */
export const IDENTITY_VERIFICATION_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export async function migrateIdentityVerification(pool: Pool): Promise<{ applied: string[] }> {
  return migrate(pool, { directory: IDENTITY_VERIFICATION_MIGRATIONS_DIR });
}

export async function identityVerificationSchemaIsCurrent(pool: Pool): Promise<boolean> {
  const status = await migrationStatus(pool, IDENTITY_VERIFICATION_MIGRATIONS_DIR);
  return status.pending.length === 0 && status.modified.length === 0;
}
