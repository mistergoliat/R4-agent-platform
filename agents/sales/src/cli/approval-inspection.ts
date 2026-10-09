import { PlatformError } from '@r4/contracts';
import { PostgresExecutionStore, PostgresProductionStore, createPool, migrationStatus } from '@r4/persistence-postgres';
import { ApprovalInspection, type OpenApprovalInspection } from '../production/approvals.js';

/**
 * (R4-J3D-R) Host-side composition of the read-only approval inspection
 * (production/approvals.ts) over a deployment's database. It reads open
 * human requests through the persistence adapter's own temporal port, in
 * one read transaction — the same read the Temporal Runtime's `attention()`
 * performs (the pack never composes the Task Runtime itself) — and binding
 * and task facts through the production store. Nothing else: no model,
 * channel, delivery, HTTP, operator context or write. Refuses a schema that
 * is not current (Core plus the pack's `migrationDirectories`) before
 * anything is read.
 */
export const openApprovalInspection: OpenApprovalInspection = async (options) => {
  const pool = createPool({ connectionString: options.databaseUrl, logger: options.logger, applicationName: 'r4-approval-inspection', max: 2 });
  try {
    for (const directory of [undefined, ...options.migrationDirectories]) {
      const status = await migrationStatus(pool, directory);
      if (status.pending.length > 0 || status.modified.length > 0) {
        throw new PlatformError('unavailable', 'schema_not_current', `database schema is not current (pending: ${status.pending.join(', ') || 'none'}; modified: ${status.modified.join(', ') || 'none'})`);
      }
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  const executionStore = new PostgresExecutionStore(pool);
  const attention = () =>
    executionStore.transaction(async (uow) => {
      if (!uow.temporal) throw new PlatformError('internal', 'temporal_unavailable', 'temporal persistence is required');
      return { requests: (await uow.temporal.listHumans()).filter((h) => h.status === 'requested' || h.status === 'active') };
    });
  const inspection = new ApprovalInspection({ temporal: { attention }, store: new PostgresProductionStore(pool) });
  return { inspection, close: () => pool.end().catch(() => undefined) };
};
