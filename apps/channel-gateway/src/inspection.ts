import { PlatformError } from '@r4/contracts';
import type { InboundInspector, ProductionStore } from '@r4/live-ops';
import type { Pool } from '@r4/persistence-postgres';
import type { TemporalRuntime } from '@r4/task-runtime';

/**
 * R4-I.1 (ADR-040): the single inspection point, as the deploying composition plugs it into the gateway
 * (like the channel adapters: the gateway imports no adapter). The factory receives the gateway's own
 * resources; whatever it starts (an asynchronous worker) runs and stops with the gateway.
 */
export interface GatewayInspection {
  readonly inspector: InboundInspector;
  /** Its mode, for readiness only. */
  readonly mode: string;
  /** Why the mode is weaker than the one requested, else null. */
  readonly degradedReason: string | null;
  start(): void;
  stop(): Promise<void>;
}

export interface GatewayInspectionResources {
  readonly pool: Pool;
  readonly store: ProductionStore;
  readonly temporal: TemporalRuntime;
  readonly gatewayId: string;
  /** Structured, content-free events. */
  readonly log: (event: string, fields: Record<string, unknown>) => void;
}

export type GatewayInspectionFactory = (resources: GatewayInspectionResources) => Promise<GatewayInspection>;

/**
 * ADR-040 inv. 6 (decision rev. 02 §9.2): a gateway composed WITHOUT an inspector refuses to start while
 * the identity-verification schema holds any open protection window. It reads the schema directly, so it
 * holds even when no composition provides that component. There is no variable or flag that skips it.
 *
 * R4-J4-R4 (ADR-040 addendum): it also refuses while the durable component mode is `full`. The worker
 * starts verifications only in `full`, so a gateway without the inspector must never run while that row
 * says so: removing the inspector requires recomposing it in `protect_only` first (plan §5).
 */
export async function assertNoOpenProtection(pool: Pool): Promise<void> {
  const schema = await pool.query<{ present: boolean }>(`select to_regclass('identity_verification.expectations') is not null as present`);
  if (schema.rows[0]?.present !== true) return;
  const open = await pool.query<{ active: boolean }>('select exists (select 1 from identity_verification.expectations where protect_until > clock_timestamp()) as active');
  if (open.rows[0]?.active === true) {
    throw new PlatformError('precondition', 'identity_verification_protection_active', 'refusing to start the channel gateway without its inbound inspector: a protection window is still open (ADR-040 inv. 6; there is no override)');
  }
  const modeTable = await pool.query<{ present: boolean }>(`select to_regclass('identity_verification.component_mode') is not null as present`);
  if (modeTable.rows[0]?.present !== true) return;
  const full = await pool.query<{ full: boolean }>(`select exists (select 1 from identity_verification.component_mode where mode = 'full') as full`);
  if (full.rows[0]?.full === true) {
    throw new PlatformError('precondition', 'identity_verification_mode_full', 'refusing to start the channel gateway without its inbound inspector: the identity-verification component is in full mode; recompose it in protect_only first (ADR-040 addendum; there is no override)');
  }
}
