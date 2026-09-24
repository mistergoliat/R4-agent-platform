import { PlatformError, sha256Hex, type CreateTaskRequestInput, type IdGenerator, type Principal } from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import type { TaskRuntime, TemporalRuntime } from '@r4/task-runtime';
import { decideInboundAutonomy, type InboundAutonomyDecision } from './autonomy.js';
import { canonicalInboundSchema, type CanonicalInbound, type HeaderBag, type InboundChannelAdapter } from './channel.js';
import type { AutonomyControls } from './controls.js';
import type { ProductionConfig, ProductionSecrets } from './mode.js';
import type { OutboundDeliveryRuntime } from './outbound.js';
import type { ConversationBindingRecord, InboundEventRecord, ProductionStore } from './ports.js';
import { profileFingerprint, profileLabel, type ProductionProfile } from './profile.js';
import { conversationKey, rolloutEligibility, rolloutFingerprint } from './rollout.js';

/**
 * How a pack opens the durable task that serves a new channel conversation.
 * `request` must be deterministic in the binding (it is replayed through the
 * task's creation idempotency key); `afterOpen` must be idempotent.
 */
export interface ConversationTaskFactory {
  readonly requestedBy: Principal;
  request(binding: { readonly bindingId: string; readonly channel: string }): CreateTaskRequestInput;
  afterOpen?(taskId: string, binding: ConversationBindingRecord): Promise<void>;
}

export interface ChannelIngressOptions {
  readonly store: ProductionStore;
  readonly tasks: TaskRuntime;
  readonly temporal: TemporalRuntime;
  readonly controls: AutonomyControls;
  readonly adapters: readonly InboundChannelAdapter[];
  /** Provider status notifications arrive on the same webhook; the delivery owner applies them. */
  readonly delivery: Pick<OutboundDeliveryRuntime, 'applyProviderStatus'>;
  readonly config: ProductionConfig;
  readonly secrets: ProductionSecrets;
  readonly profile: ProductionProfile;
  readonly taskFactory: ConversationTaskFactory;
  readonly ids: IdGenerator;
  readonly logger: StructuredLogger;
}

export type IngestOutcome =
  | { readonly kind: 'duplicate'; readonly inboundId: string }
  | { readonly kind: 'ingested'; readonly inboundId: string; readonly taskId: string; readonly inputId: string; readonly taskCreated: boolean; readonly disposition: string }
  | { readonly kind: 'failed'; readonly inboundId: string; readonly code: string };

export interface WebhookResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly contentType?: string;
}

/** Marker text of an input whose content R4 cannot represent (platform-authored, not contact text). */
export function unsupportedContentMarker(contentType: string): string {
  return `[unsupported inbound content: ${contentType}]`;
}

/**
 * Canonical channel ingress (R4-I). The only way production traffic enters
 * R4: provider notification → authenticate → canonicalize → dedupe (durable
 * unique identity) → conversation binding → durable canonical input on the
 * bound task — and nothing else. No model, domain owner or delivery is
 * called inside the request; workers execute asynchronously.
 *
 * Autonomy is decided here only as a HOLD (never as execution): when the
 * kill switch is engaged, the conversation is denied or outside its cohort,
 * or the content is unsupported (per profile), the task is held for humans
 * in the same transaction that records the input — the input is never lost
 * and never starts autonomous work.
 */
export class ChannelIngress {
  readonly #o: ChannelIngressOptions;
  readonly #adapters: ReadonlyMap<string, InboundChannelAdapter>;
  readonly #profile: string;
  readonly #profileFingerprint: string;
  readonly #rolloutFingerprint: string;

  constructor(options: ChannelIngressOptions) {
    this.#o = options;
    this.#adapters = new Map(options.adapters.map((a) => [a.channel, a]));
    this.#profile = profileLabel(options.profile);
    this.#profileFingerprint = profileFingerprint(options.profile);
    this.#rolloutFingerprint = rolloutFingerprint(options.config.rollout);
  }

  channels(): string[] {
    return [...this.#adapters.keys()];
  }

  verify(channel: string, query: Readonly<Record<string, string | undefined>>): WebhookResponse {
    const adapter = this.#adapters.get(channel);
    if (!adapter) return { status: 404, body: { error: 'unknown_channel' } };
    const verified = adapter.verifySubscription(query);
    return verified.ok ? { status: 200, body: { challenge: verified.body }, contentType: 'text/plain' } : { status: verified.status, body: { error: verified.reason } };
  }

  /**
   * One provider notification, as received (raw body for the signature).
   * 401 when not authentic (the provider's retries are harmless: nothing was
   * persisted). 200 once every item is durable — including items that could
   * not be canonicalized (recorded as rejected: a provider retry cannot fix
   * them, so no retry loop). 500 only on an infrastructure failure, so the
   * provider re-delivers (safe: dedupe).
   */
  async receive(channel: string, rawBody: string, headers: HeaderBag, correlationId: string): Promise<WebhookResponse> {
    const adapter = this.#adapters.get(channel);
    if (!adapter) return { status: 404, body: { error: 'unknown_channel' } };
    const auth = adapter.authenticate(rawBody, headers);
    if (!auth.ok) {
      emitTelemetry(this.#o.logger, 'inbound.authentication_failed', { channel, reason: auth.reason, correlationId });
      return { status: 401, body: { error: 'unauthenticated' } };
    }
    const parsed = adapter.parse(rawBody);
    const results = { ingested: 0, duplicates: 0, failed: 0, rejected: 0, statuses: 0 };
    for (const item of parsed.rejected) {
      const providerEventId = item.providerEventId ?? `unidentified:${sha256Hex(rawBody).slice(0, 48)}`;
      const { created } = await this.#o.store.recordInbound({
        inboundId: this.#o.ids.next(), channel, providerEventId, contentKind: 'rejected', contentType: null, content: null, contentSha256: null,
        conversationKey: null, accountRef: null, conversationRef: null, occurredAt: null, status: 'rejected', failureCode: item.reason.slice(0, 120), correlationId,
      });
      if (created) emitTelemetry(this.#o.logger, 'inbound.rejected', { channel, reason: item.reason.slice(0, 64), correlationId });
      results.rejected += 1;
    }
    for (const inbound of parsed.inbound) {
      const outcome = await this.ingest(inbound, correlationId);
      if (outcome.kind === 'ingested') results.ingested += 1;
      else if (outcome.kind === 'duplicate') results.duplicates += 1;
      else results.failed += 1;
    }
    for (const status of parsed.statuses) {
      await this.#o.delivery.applyProviderStatus(status);
      results.statuses += 1;
    }
    return { status: 200, body: { ok: true, ...results } };
  }

  /** Canonical inbound → durable input. Idempotent by the provider event identity. */
  async ingest(raw: CanonicalInbound, correlationId: string): Promise<IngestOutcome> {
    const event = canonicalInboundSchema.parse(raw);
    const key = conversationKey(this.#o.secrets.identityHashKey, event.channel, event.accountRef, event.conversationRef);
    const text = event.content.kind === 'text' ? event.content.text : unsupportedContentMarker(event.content.contentType);
    const { record, created } = await this.#o.store.recordInbound({
      inboundId: this.#o.ids.next(),
      channel: event.channel,
      providerEventId: event.providerEventId,
      contentKind: event.content.kind,
      contentType: event.content.kind === 'unsupported' ? event.content.contentType : 'text',
      content: text,
      contentSha256: sha256Hex(text),
      conversationKey: key,
      accountRef: event.accountRef,
      conversationRef: event.conversationRef,
      occurredAt: event.occurredAt,
      status: 'received',
      failureCode: null,
      correlationId,
    });
    if (!created) {
      emitTelemetry(this.#o.logger, 'inbound.duplicate', { channel: event.channel, inboundId: record.inboundId, status: record.status, correlationId });
      return { kind: 'duplicate', inboundId: record.inboundId };
    }
    emitTelemetry(this.#o.logger, 'inbound.received', { channel: event.channel, inboundId: record.inboundId, contentKind: event.content.kind, correlationId });
    return this.#process(record);
  }

  /** Crash recovery: inbound persisted but never settled (the process died between persistence and ingestion). */
  async resumeUnsettled(olderThanMs = 30_000, limit = 50): Promise<IngestOutcome[]> {
    const pending = await this.#o.store.unsettledInbound(olderThanMs, limit);
    const out: IngestOutcome[] = [];
    for (const record of pending) out.push(await this.#process(record));
    return out;
  }

  async #process(record: InboundEventRecord): Promise<IngestOutcome> {
    const { store, controls, config, profile, taskFactory, temporal, tasks, logger } = this.#o;
    if (record.conversationKey === null || record.accountRef === null || record.conversationRef === null || record.content === null || record.occurredAt === null) {
      await store.settleInbound(record.inboundId, { status: 'failed', failureCode: 'incomplete_inbound_record' });
      return { kind: 'failed', inboundId: record.inboundId, code: 'incomplete_inbound_record' };
    }
    const unsupported = record.contentKind === 'unsupported';
    try {
      for (let attempt = 0; ; attempt += 1) {
        let binding = await store.findOpenBinding(record.channel, record.conversationKey);
        if (binding?.taskId) {
          const state = await store.taskState(binding.taskId);
          // Truly terminal work is never revived: a new contact opens a new task (no cross-task memory).
          if (!state || state.terminalIntent || state.status === 'completed' || state.status === 'cancelled' || state.status === 'failed') {
            await store.closeBinding(binding.bindingId, state ? `task_${state.terminalIntent ? 'terminal_intent' : state.status}` : 'task_missing');
            emitTelemetry(logger, 'conversation.binding.closed', { channel: record.channel, bindingId: binding.bindingId, taskId: binding.taskId, reason: state?.status ?? 'task_missing' });
            binding = null;
          }
        }
        if (!binding) {
          const eligibility = rolloutEligibility(config.rollout, record.conversationKey);
          binding = await store.openBinding({
            bindingId: this.#o.ids.next(), channel: record.channel, conversationKey: record.conversationKey, accountRef: record.accountRef, recipientRef: record.conversationRef,
            autonomy: eligibility.eligible ? 'autonomous' : 'excluded', eligibilityReason: eligibility.reason, rolloutFingerprint: this.#rolloutFingerprint,
            profile: this.#profile, profileFingerprint: this.#profileFingerprint,
          });
          emitTelemetry(logger, 'conversation.binding.opened', { channel: record.channel, bindingId: binding.bindingId, autonomy: binding.autonomy, eligibilityReason: binding.eligibilityReason, rolloutBucketed: eligibility.reason === 'cohort' });
        }
        const decision: InboundAutonomyDecision = decideInboundAutonomy({
          controls: await controls.state(),
          channel: record.channel,
          deniedNow: config.rollout.denylist.includes(record.conversationKey),
          bindingAutonomous: binding.autonomy === 'autonomous',
          unsupportedContent: unsupported,
          unsupportedContentPolicy: profile.unsupportedContent,
        });
        const hold = decision.kind === 'hold' ? { reason: decision.reason, summary: decision.summary } : undefined;
        const input = { externalKey: record.providerEventId, content: record.content, sourceRef: `channel:${record.channel}`, occurredAt: record.occurredAt };
        // The provider identity is a provisional participant reference; the address itself never becomes a principal.
        const actor: Principal = { kind: 'user', ref: `${record.channel}:${record.conversationKey.slice(0, 32)}` };
        try {
          let taskId: string;
          let inputId: string;
          let taskCreated = false;
          let held: boolean;
          if (!binding.taskId) {
            const result = await temporal.createTaskWithInput(tasks, {
              request: taskFactory.request({ bindingId: binding.bindingId, channel: binding.channel }),
              requestedBy: taskFactory.requestedBy,
              correlationId: `conversation-${binding.bindingId}`,
              idempotencyKey: `conversation-${binding.bindingId}`,
            }, input, actor, hold ? { hold } : {});
            binding = await store.attachTask(binding.bindingId, result.taskId);
            await taskFactory.afterOpen?.(result.taskId, binding);
            ({ taskId, inputId, held } = result);
            taskCreated = !result.taskReplayed;
          } else {
            const state = await store.taskState(binding.taskId);
            const result = await temporal.submitInput(binding.taskId, input, actor, record.correlationId, hold && !state?.humanOwned ? { hold } : {});
            ({ inputId, held } = result);
            taskId = binding.taskId;
          }
          const humanOwned = (await store.taskState(taskId))?.humanOwned ?? false;
          const disposition = held && hold ? `held:${hold.reason}` : humanOwned ? 'human_owned' : hold ? `held:${hold.reason}` : 'autonomous';
          await store.touchBinding(binding.bindingId, record.occurredAt);
          await store.settleInbound(record.inboundId, { status: 'ingested', bindingId: binding.bindingId, taskId, inputId, disposition });
          emitTelemetry(logger, 'inbound.ingested', { channel: record.channel, inboundId: record.inboundId, taskId, inputId, taskCreated, disposition, correlationId: record.correlationId });
          return { kind: 'ingested', inboundId: record.inboundId, taskId, inputId, taskCreated, disposition };
        } catch (error) {
          // The task became terminal between the check and the submission: close the binding and open a new one once.
          if (attempt === 0 && error instanceof PlatformError && (error.code === 'task_not_accepting_input' || error.code === 'task_terminal') && binding.taskId) {
            await store.closeBinding(binding.bindingId, 'task_terminal_race');
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      // Deterministic refusals are poison for this event (a retry cannot fix them): settle as failed, visible in attention.
      if (error instanceof PlatformError && (error.kind === 'validation' || error.code === 'idempotency_key_reused')) {
        await store.settleInbound(record.inboundId, { status: 'failed', failureCode: error.code });
        emitTelemetry(logger, 'inbound.rejected', { channel: record.channel, inboundId: record.inboundId, reason: error.code });
        return { kind: 'failed', inboundId: record.inboundId, code: error.code };
      }
      // Infrastructure: stays `received`; the provider's retry or the resume sweep settles it.
      throw error;
    }
  }
}
