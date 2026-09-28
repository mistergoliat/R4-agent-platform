import { PlatformError, type HumanRequest } from '@r4/contracts';
import type { TemporalRuntime } from '@r4/task-runtime';
import { HOLD_REASONS, autonomyEnabledFor, type AutonomyControlsState } from './autonomy.js';
import type { AutonomyControls } from './controls.js';
import type { AutonomyControlRecord, ProductionStore } from './ports.js';

/**
 * The attribution of production administration: a trusted production-host
 * action, NOT a verified individual (R4 does not own operator identity).
 * It is recorded as `changed_by` of control events and as the actor of a
 * hold release, so the audit says truthfully who acted: the deployment's
 * administrative tooling, run by someone with production-host access.
 */
export const PRODUCTION_CONTROL_ACTOR = 'platform:production-control';

/** A task held because autonomy was disabled, as the administrator sees it (no conversation content). */
export interface AutonomyHold {
  readonly taskId: string;
  readonly requestId: string;
  readonly heldAt: string;
  readonly reason: string;
  readonly channel: string | null;
  readonly taskStatus: string | null;
  /** Whether autonomy is enabled for the task's channel now (release is refused otherwise). */
  readonly autonomyEnabled: boolean;
}

export interface AutonomyStatus {
  readonly autonomyEnabled: boolean;
  readonly global: AutonomyControlRecord | null;
  readonly channels: readonly AutonomyControlRecord[];
  readonly version: string;
}

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireReason(reason: string | undefined): string {
  const value = reason?.trim() ?? '';
  if (value.length === 0 || value.length > 500) throw new PlatformError('validation', 'reason_required', 'every administrative change needs an operational reason (1–500 characters)');
  return value;
}

/**
 * Production administration (R4-I, D-5/D-6): the deployment-side control of
 * the autonomy kill switch and the explicit release of tasks held because
 * autonomy was disabled. Its trust boundary is access to the production
 * runtime host — it is not the operator plane and never builds a
 * TrustedHumanContext. It only calls existing durable primitives:
 * `AutonomyControls.set` (audited control events) and
 * `TemporalRuntime.releasePlatformHold` (the handoff/wait transition). It
 * never runs cognition, never dispatches, never touches delivery state.
 *
 *   autonomy on  ≠  release held tasks   (each release is explicit, per task)
 */
export class ProductionAdministration {
  readonly #store: ProductionStore;
  readonly #temporal: TemporalRuntime;
  readonly #controls: AutonomyControls;
  readonly #correlationId: string;

  constructor(options: { store: ProductionStore; temporal: TemporalRuntime; controls: AutonomyControls; correlationId: string }) {
    this.#store = options.store;
    this.#temporal = options.temporal;
    this.#controls = options.controls;
    this.#correlationId = options.correlationId;
  }

  /** The durable kill-switch state. Unlike worker admission, an unreadable state is an error here, not "disabled". */
  async autonomyStatus(): Promise<AutonomyStatus> {
    const { state, records } = await this.#store.readControls();
    return { autonomyEnabled: state.globalEnabled, global: records.find((r) => r.scope === 'global') ?? null, channels: records.filter((r) => r.scope !== 'global'), version: state.version };
  }

  /** Global kill switch. Never releases a held task, never stops channels, never changes the rollout. */
  async setAutonomy(enabled: boolean, reason: string | undefined): Promise<AutonomyControlRecord> {
    return this.#controls.set({ scope: 'global', autonomyEnabled: enabled, reason: requireReason(reason), changedBy: PRODUCTION_CONTROL_ACTOR, correlationId: this.#correlationId });
  }

  /** Open platform holds caused by disabled autonomy (agent/operator handoffs, approvals and consultations never appear). */
  async holds(): Promise<AutonomyHold[]> {
    const { state } = await this.#store.readControls();
    const open = (await this.#temporal.attention()).requests.filter(isAutonomyHold);
    const out: AutonomyHold[] = [];
    for (const request of open) {
      const channel = (await this.#store.bindingByTask(request.taskId))?.channel ?? null;
      out.push({
        taskId: request.taskId, requestId: request.requestId, heldAt: request.createdAt, reason: HOLD_REASONS.killSwitch, channel,
        taskStatus: (await this.#store.taskState(request.taskId))?.status ?? null, autonomyEnabled: enabledFor(state, channel),
      });
    }
    return out;
  }

  /**
   * Releases exactly one task held because autonomy was disabled — only
   * while autonomy is enabled for it again (otherwise the release would be
   * meaningless: the next inbound would hold it again). The task becomes
   * claimable under the normal worker rules; nothing runs here.
   */
  async releaseHold(taskId: string, reason: string | undefined): Promise<{ taskId: string; request: HumanRequest; taskStatus: string | null }> {
    const note = requireReason(reason);
    if (!TASK_ID.test(taskId)) throw new PlatformError('validation', 'invalid_task_id', 'the task id must be a UUID');
    const { state } = await this.#store.readControls();
    const channel = (await this.#store.bindingByTask(taskId))?.channel ?? null;
    if (!enabledFor(state, channel)) throw new PlatformError('precondition', 'autonomy_disabled', 'autonomy is still disabled for this task; enable it first (autonomy on), then release');
    const request = await this.#temporal.releasePlatformHold(taskId, { reason: HOLD_REASONS.killSwitch, note, actorRef: PRODUCTION_CONTROL_ACTOR, correlationId: this.#correlationId });
    return { taskId, request, taskStatus: (await this.#store.taskState(taskId))?.status ?? null };
  }
}

function isAutonomyHold(request: HumanRequest): boolean {
  return request.kind === 'handoff' && request.status === 'requested' && request.payload.initiatedBy === 'platform' && request.payload.reason === HOLD_REASONS.killSwitch;
}

function enabledFor(state: AutonomyControlsState, channel: string | null): boolean {
  return channel === null ? state.globalEnabled : autonomyEnabledFor(state, channel).enabled;
}
