import { loadSchedulerConfig } from '@r4/scheduler';

/**
 * R4-J1E-R2.1 — production composition correction: the processes a Sales
 * production deployment runs. Each is an independent OS process sharing only
 * PostgreSQL (ADR-022, ADR-029 §16); none embeds another.
 *
 * The scheduler is required, not optional: it is the only consumer of durable
 * schedules (`TemporalRuntime.claimSchedule`). Without it an agent's
 * WAIT_UNTIL is never woken, human request expiries never expire, retries are
 * never released and reconciliation is never dispatched. Its entry point is the generic one
 * (`apps/scheduler`): time is not Sales-specific.
 *
 * `script` is the root package script that starts the process.
 */
export interface ProductionProcess {
  readonly name: string;
  readonly script: string;
  readonly owns: string;
}

export const SALES_PRODUCTION_PROCESSES: readonly ProductionProcess[] = Object.freeze([
  Object.freeze({ name: 'r4-channel-gateway', script: 'production:sales:gateway', owns: 'provider webhooks (canonical inbound, binding, task input) and outbound dispatch; the only process that talks to the channel provider' }),
  Object.freeze({ name: 'r4-sales-worker', script: 'production:sales:worker', owns: 'task claims, kernel, model, capabilities (Catalog), dispatched reconciliation' }),
  Object.freeze({ name: 'r4-scheduler', script: 'start:scheduler', owns: 'time only: claims due schedules and fires them (WAIT_UNTIL wake, expiries, retry release, reconciliation dispatch); no model, no capabilities' }),
]);

/** The scheduler's own configuration check (the same loader its entry point runs): usable, or why it would refuse to start. */
export function schedulerConfigurationStatus(env: NodeJS.ProcessEnv): { readonly usable: true; readonly owner: string; readonly leaseMs: number; readonly pollMs: number; readonly reconciliationPolicy: Record<string, number> } | { readonly usable: false; readonly reason: string } {
  try {
    const config = loadSchedulerConfig(env);
    return { usable: true, owner: config.owner, leaseMs: config.leaseMs, pollMs: config.pollMs, reconciliationPolicy: { ...config.reconciliationPolicy } };
  } catch (error) {
    // The loader names the missing or invalid variables; it never echoes the connection string.
    return { usable: false, reason: error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/gi, '[redacted database url]') : String(error) };
  }
}
