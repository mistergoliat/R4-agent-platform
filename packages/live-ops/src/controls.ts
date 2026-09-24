import { PlatformError } from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import { autonomyEnabledFor, type AutonomyControlsState } from './autonomy.js';
import type { AutonomyControlRecord, ProductionStore } from './ports.js';

/** Controls as read when the durable state cannot be read: everything disabled (fail closed). */
export const CONTROLS_UNAVAILABLE: AutonomyControlsState = Object.freeze({ globalEnabled: false, channels: Object.freeze({}), version: 'unavailable' });

const SCOPE = /^(global|channel:[a-z][a-z0-9_.-]{0,63})$/;

/**
 * Durable autonomy controls (the kill switch, R4-I). One row per scope
 * (`global`, optionally `channel:<id>`); the migration creates `global`
 * DISABLED, so a fresh deployment is autonomous for nobody until an
 * operator enables it. Every read goes to the database (no cache): a change
 * applies to the very next claim, inbound or dispatch in every process.
 *
 * Engaged, it stops: new autonomous claims (worker admission), automatic
 * outbound dispatch (held, not cancelled) and new autonomous work from
 * inbound (tasks held for humans). It never drops inbound, deletes tasks or
 * erases state; provider-accepted messages stay as they are.
 */
export class AutonomyControls {
  readonly #store: ProductionStore;
  readonly #logger: StructuredLogger;

  constructor(options: { store: ProductionStore; logger: StructuredLogger }) {
    this.#store = options.store;
    this.#logger = options.logger;
  }

  /** Current state; any failure to read counts as disabled. */
  async state(): Promise<AutonomyControlsState> {
    try {
      return (await this.#store.readControls()).state;
    } catch {
      return CONTROLS_UNAVAILABLE;
    }
  }

  records(): Promise<readonly AutonomyControlRecord[]> {
    return this.#store.readControls().then((r) => r.records);
  }

  /** Worker admission (structurally a `WorkerAdmission`): may new autonomous work be claimed? */
  async admit(): Promise<{ admitted: boolean; reason: string }> {
    const state = await this.state();
    if (state === CONTROLS_UNAVAILABLE) return { admitted: false, reason: 'autonomy_controls_unavailable' };
    return state.globalEnabled ? { admitted: true, reason: 'autonomy_enabled' } : { admitted: false, reason: 'autonomy_disabled' };
  }

  async enabledFor(channel: string): Promise<boolean> {
    return autonomyEnabledFor(await this.state(), channel).enabled;
  }

  /** Operator change; audited durably by the store (append-only control events). */
  async set(change: { scope: string; autonomyEnabled: boolean; reason: string; changedBy: string; correlationId: string }): Promise<AutonomyControlRecord> {
    if (!SCOPE.test(change.scope)) throw new PlatformError('validation', 'invalid_control_scope', 'scope must be "global" or "channel:<id>"');
    if (change.reason.trim().length === 0 || change.reason.length > 500) throw new PlatformError('validation', 'validation_failed', 'a control change needs a reason (at most 500 characters)');
    const record = await this.#store.setControl(change);
    emitTelemetry(this.#logger, 'autonomy.control.changed', { scope: record.scope, autonomyEnabled: record.autonomyEnabled, version: record.version, changedBy: record.changedBy, correlationId: change.correlationId });
    return record;
  }
}
