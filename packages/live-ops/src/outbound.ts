import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import { providerStatusEventSchema, type OutboundChannelAdapter, type ProviderStatusEvent } from './channel.js';
import { decideDispatch, dispositionAfterSubmission, type SubmissionResult } from './delivery.js';
import type { ProductionConfig } from './mode.js';
import type { DispatchClaim, OutboundRecord, ProductionStore } from './ports.js';

export interface OutboundDeliveryOptions {
  readonly store: ProductionStore;
  readonly adapters: readonly OutboundChannelAdapter[];
  readonly config: ProductionConfig;
  /** Dispatcher identity (lease owner). */
  readonly owner: string;
  readonly logger: StructuredLogger;
}

export type DispatchCycle =
  | { readonly kind: 'idle' }
  | { readonly kind: 'held'; readonly outboundId: string; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly outboundId: string; readonly reason: string }
  | { readonly kind: 'submitted'; readonly outboundId: string; readonly status: OutboundRecord['status']; readonly result: SubmissionResult; readonly fenced: boolean };

const TERMINAL_EVENT: Partial<Record<OutboundRecord['status'], 'outbound.accepted' | 'outbound.delivered' | 'outbound.read' | 'outbound.failed' | 'outbound.unknown'>> = {
  accepted: 'outbound.accepted',
  delivered: 'outbound.delivered',
  read: 'outbound.read',
  failed: 'outbound.failed',
  unknown: 'outbound.unknown',
};

/**
 * The single owner of external message delivery (R4-I). Neither the Agent
 * Kernel, the agent pack, the webhook nor a worker sends anything: the
 * kernel only records `respond` (a durable step); this runtime turns each
 * accepted response into exactly one durable OutboundMessage (identity =
 * the step) and owns its whole lifecycle:
 *
 *   materialize  one outbound per accepted `respond` of a bound task
 *   dispatch     claim (lease + fencing generation, SKIP LOCKED) with the
 *                delivery gate evaluated in the claim transaction →
 *                one provider submission → fenced outcome record
 *   sweep        a dispatch whose lease expired (the process died during the
 *                provider call) becomes `unknown` — never re-sent
 *   reconcile    provider status evidence, idempotent and monotonic
 *
 * Retries are bounded (maxAttempts) and only for definitely-not-sent
 * submissions; this budget is independent of ADR-028's run recovery budget.
 * An ADR-028 recovery run produces NEW steps: it can never re-dispatch an
 * earlier response (unique per step), and an identical response to one
 * already live is created cancelled (`duplicate_content`).
 */
export class OutboundDeliveryRuntime {
  readonly #o: OutboundDeliveryOptions;
  readonly #adapters: ReadonlyMap<string, OutboundChannelAdapter>;

  constructor(options: OutboundDeliveryOptions) {
    this.#o = options;
    this.#adapters = new Map(options.adapters.map((a) => [a.channel, a]));
  }

  get owner(): string {
    return this.#o.owner;
  }

  async materialize(limit = 50): Promise<OutboundRecord[]> {
    const created = await this.#o.store.materializeResponses({ limit, duplicateWindowMs: this.#o.config.outbound.duplicateWindowMs });
    for (const o of created) {
      emitTelemetry(this.#o.logger, 'outbound.created', { outboundId: o.outboundId, taskId: o.taskId, runId: o.runId, responseStepId: o.responseStepId, channel: o.channel, origin: o.origin, status: o.status, correlationId: o.correlationId });
      if (o.status === 'cancelled') emitTelemetry(this.#o.logger, 'outbound.cancelled', { outboundId: o.outboundId, taskId: o.taskId, reason: o.cancelReason, duplicateOf: o.duplicateOf });
    }
    return created;
  }

  /** At most one claim and one provider submission. */
  async dispatchOnce(): Promise<DispatchCycle> {
    const { store, config, logger } = this.#o;
    const claim: DispatchClaim | null = await store.claimNextOutbound({
      owner: this.#o.owner,
      leaseMs: config.outbound.leaseMs,
      holdRecheckMs: config.outbound.holdRecheckMs,
      customerWindowMs: (channel) => this.#adapters.get(channel)?.customerWindowMs ?? null,
      deniedNow: (key) => config.rollout.denylist.includes(key),
      decide: (facts) => decideDispatch(facts, { maxAgeMs: config.outbound.maxAgeMs }),
    });
    if (!claim) return { kind: 'idle' };
    const base = { outboundId: claim.outbound.outboundId, taskId: claim.outbound.taskId, channel: claim.outbound.channel, origin: claim.outbound.origin, correlationId: claim.outbound.correlationId };
    if (claim.kind === 'held') {
      emitTelemetry(logger, 'outbound.held', { ...base, reason: claim.reason });
      return { kind: 'held', outboundId: claim.outbound.outboundId, reason: claim.reason };
    }
    if (claim.kind === 'cancelled') {
      emitTelemetry(logger, 'outbound.cancelled', { ...base, reason: claim.reason });
      return { kind: 'cancelled', outboundId: claim.outbound.outboundId, reason: claim.reason };
    }
    const adapter = this.#adapters.get(claim.outbound.channel);
    emitTelemetry(logger, 'outbound.dispatch.attempted', { ...base, attempt: claim.token.attempt, generation: claim.token.generation });
    let result: SubmissionResult;
    const started = Date.now();
    if (!adapter) {
      // Nothing left the process: definitely not sent.
      result = { outcome: 'rejected', providerMessageId: null, httpStatus: null, errorClass: 'no_channel_adapter', errorCode: null, retryAfterMs: null, latencyMs: 0 };
    } else {
      try {
        result = await adapter.submit(
          { outboundId: claim.outbound.outboundId, idempotencyKey: claim.outbound.idempotencyKey, accountRef: claim.accountRef, recipientRef: claim.recipientRef, text: claim.text, attempt: claim.token.attempt },
          { timeoutMs: config.outbound.providerTimeoutMs },
        );
      } catch {
        // An adapter that throws cannot tell whether the request left: unknown, never retried.
        result = { outcome: 'unknown', providerMessageId: null, httpStatus: null, errorClass: 'adapter_exception', errorCode: null, retryAfterMs: null, latencyMs: Date.now() - started };
      }
    }
    const disposition = dispositionAfterSubmission(result, claim.token.attempt, { maxAttempts: config.outbound.maxAttempts });
    const recorded = await store.recordSubmission(claim.token, result, disposition);
    const status = recorded.outbound.status;
    if (status === 'pending') emitTelemetry(logger, 'outbound.retry_scheduled', { ...base, attempt: claim.token.attempt, errorClass: result.errorClass, httpStatus: result.httpStatus });
    const event = TERMINAL_EVENT[status];
    if (event) emitTelemetry(logger, event, { ...base, attempt: claim.token.attempt, providerMessageIdKnown: recorded.outbound.providerMessageId !== null, errorClass: result.errorClass, httpStatus: result.httpStatus, latencyMs: result.latencyMs, fenced: recorded.applied });
    return { kind: 'submitted', outboundId: claim.outbound.outboundId, status, result, fenced: recorded.applied };
  }

  /** Dispatches whose owner died mid-call: their outcome is unknown (never assumed sent or not sent). */
  async sweep(limit = 50): Promise<OutboundRecord[]> {
    const expired = await this.#o.store.expireDispatchLeases(limit);
    for (const o of expired) emitTelemetry(this.#o.logger, 'outbound.unknown', { outboundId: o.outboundId, taskId: o.taskId, channel: o.channel, errorClass: o.errorClass, attempt: o.attempts });
    return expired;
  }

  /** Provider evidence (status callbacks): idempotent per event, monotonic per outbound. */
  async applyProviderStatus(raw: ProviderStatusEvent): Promise<void> {
    const event = providerStatusEventSchema.parse(raw);
    const applied = await this.#o.store.applyProviderStatus(event);
    if (applied.duplicate) return;
    const fields = { channel: event.channel, outboundId: applied.outbound?.outboundId ?? null, taskId: applied.outbound?.taskId ?? null, evidence: event.status, from: applied.from, to: applied.to, effect: applied.effect };
    emitTelemetry(this.#o.logger, applied.effect === 'applied' ? 'outbound.status.applied' : 'outbound.status.ignored', fields);
    const terminal = applied.effect === 'applied' && applied.to ? TERMINAL_EVENT[applied.to] : undefined;
    if (terminal && applied.outbound) emitTelemetry(this.#o.logger, terminal, { outboundId: applied.outbound.outboundId, taskId: applied.outbound.taskId, channel: event.channel, via: 'provider_status' });
  }

  /** One maintenance + delivery pass: sweep, materialize, then dispatch up to `maxDispatches`. */
  async tick(maxDispatches = 20): Promise<{ swept: number; materialized: number; cycles: DispatchCycle[] }> {
    const swept = await this.sweep();
    const materialized = await this.materialize();
    const cycles: DispatchCycle[] = [];
    for (let i = 0; i < maxDispatches; i += 1) {
      const cycle = await this.dispatchOnce();
      if (cycle.kind === 'idle') break;
      cycles.push(cycle);
    }
    return { swept: swept.length, materialized: materialized.length, cycles };
  }
}

/**
 * The dispatcher loop of a delivery process. Graceful stop: no new claims;
 * the submission in flight finishes and its outcome is recorded (a hard kill
 * instead leaves a `dispatching` lease that the next sweep turns `unknown`).
 */
export class DeliveryDispatcher {
  readonly #runtime: OutboundDeliveryRuntime;
  readonly #pollMs: number;
  readonly #logger: StructuredLogger;
  #loop: Promise<void> | null = null;
  #stopping = false;
  #wake: (() => void) | null = null;

  constructor(options: { runtime: OutboundDeliveryRuntime; pollIntervalMs: number; logger: StructuredLogger }) {
    this.#runtime = options.runtime;
    this.#pollMs = options.pollIntervalMs;
    this.#logger = options.logger;
  }

  start(): void {
    if (this.#loop) throw new Error('dispatcher already started');
    this.#stopping = false;
    this.#loop = (async () => {
      while (!this.#stopping) {
        let busy = false;
        try {
          const pass = await this.#runtime.tick();
          busy = pass.cycles.length > 0 || pass.materialized > 0;
        } catch (error) {
          this.#logger.warn({ owner: this.#runtime.owner, err: error instanceof Error ? { name: error.name, message: error.message } : String(error) }, 'delivery tick failed');
        }
        if (!busy && !this.#stopping) await this.#sleep();
      }
    })();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#wake?.();
    await this.#loop;
    this.#loop = null;
  }

  #sleep(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, this.#pollMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.#wake = done;
    }).finally(() => {
      this.#wake = null;
    });
  }
}
