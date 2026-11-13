import { PlatformError, sha256Hex, type CreateTaskRequestInput, type IdGenerator, type Principal } from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import type { TaskRuntime, TemporalRuntime } from '@r4/task-runtime';
import { decideInboundAutonomy, type InboundAutonomyDecision } from './autonomy.js';
import { canonicalInboundSchema, type CanonicalInbound, type HeaderBag, type InboundChannelAdapter } from './channel.js';
import type { AutonomyControls } from './controls.js';
import type { ProductionConfig, ProductionSecrets } from './mode.js';
import type { InboundInspector } from './inspection.js';
import { mediaRefContent, parseMediaRefContent, parseReactionRefContent, reactionRefContent, type MediaKind, type MediaPerception } from './media.js';
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

/**
 * (ADR-045) One extra profile the same gateway serves for an explicit, closed set of conversations (keyed
 * hashes, never addresses). The lane is decided only when a binding is OPENED and persisted on it
 * (`binding.profile`); everything after that follows the binding, never the current configuration. Every lane
 * conversation must also be allowlisted in the rollout: a lane never widens who gets autonomy.
 */
export interface ConversationLane {
  readonly conversationKeys: readonly string[];
  readonly profile: ProductionProfile;
  readonly taskFactory: ConversationTaskFactory;
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
  /** R4-I.1 (ADR-040): the single inspection point, by composition. Absent: ingress is exactly R4-I. */
  readonly inspector?: InboundInspector;
  /** ADR-045: absent, ingress is exactly R4-I (one profile per gateway). */
  readonly lane?: ConversationLane;
  /**
   * Notified (synchronously, after the input is durable) when an inbound starts AUTONOMOUS work, e.g. for the
   * gateway's cosmetic working signal. Must not throw or block; its failures are ignored. Absent: nothing.
   */
  readonly onAutonomousInput?: (input: { readonly channel: string; readonly accountRef: string; readonly providerEventId: string; readonly taskId: string }) => void;
  /**
   * (Inbound multimodal v1) Perception of images and voice notes. Absent — or with an inspector composed, whose ADR-040
   * guarantees cover text only — a media item is exactly an `unsupported` one (held per profile, never downloaded).
   * Present: a media item is acknowledged at once and processed right after (download + perception take seconds), and it
   * is downloaded ONLY when its input starts autonomous work, in a task no human owns, of a binding whose profile is one
   * of `profiles` (every other profile keeps holding media exactly as before).
   */
  readonly media?: { readonly perception: MediaPerception; readonly profiles: readonly string[] };
}

interface ServedProfile {
  readonly label: string;
  readonly fingerprint: string;
  readonly profile: ProductionProfile;
  readonly taskFactory: ConversationTaskFactory;
}

export type IngestOutcome =
  | { readonly kind: 'duplicate'; readonly inboundId: string }
  /** (media) Durable and acknowledged; processed right after the response (or by the resume sweep after a crash). */
  | { readonly kind: 'deferred'; readonly inboundId: string }
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
  readonly #main: ServedProfile;
  readonly #lane: (ServedProfile & { readonly keys: ReadonlySet<string> }) | null;
  readonly #rolloutFingerprint: string;
  /** Media inbound being processed in this process right now (the resume sweep never takes them twice). */
  readonly #inFlight = new Set<string>();

  constructor(options: ChannelIngressOptions) {
    this.#o = options;
    this.#adapters = new Map(options.adapters.map((a) => [a.channel, a]));
    this.#main = { label: profileLabel(options.profile), fingerprint: profileFingerprint(options.profile), profile: options.profile, taskFactory: options.taskFactory };
    const lane = options.lane;
    this.#lane = lane ? { label: profileLabel(lane.profile), fingerprint: profileFingerprint(lane.profile), profile: lane.profile, taskFactory: lane.taskFactory, keys: new Set(lane.conversationKeys) } : null;
    if (options.media && options.media.profiles.length === 0) throw new PlatformError('precondition', 'media_perception_refused', 'media perception needs at least one profile');
    if (this.#lane) {
      const { rollout } = options.config;
      const problems: string[] = [];
      if (this.#lane.label === this.#main.label) problems.push(`the lane profile ${this.#lane.label} is the gateway profile`);
      if (this.#lane.profile.channel.id !== options.profile.channel.id) problems.push(`the lane profile serves channel ${this.#lane.profile.channel.id}, not ${options.profile.channel.id}`);
      if (this.#lane.keys.size === 0) problems.push('the lane has no conversations');
      for (const key of this.#lane.keys) {
        if (!rollout.allowlist.includes(key) || rollout.denylist.includes(key)) problems.push(`lane conversation ${key.slice(0, 12)}… is not allowlisted (or is denied) in the rollout`);
      }
      if (problems.length > 0) throw new PlatformError('precondition', 'conversation_lane_refused', `refusing the conversation lane:\n- ${problems.join('\n- ')}`);
    }
    this.#rolloutFingerprint = rolloutFingerprint(options.config.rollout);
  }

  /** The profile a NEW binding of this conversation is opened with. */
  #assign(key: string): ServedProfile {
    return this.#lane?.keys.has(key) ? this.#lane : this.#main;
  }

  /** The composed profile an existing binding was opened with (null: none of this gateway's). */
  #servedBy(binding: ConversationBindingRecord): ServedProfile | null {
    if (binding.profile === this.#main.label) return this.#main;
    if (this.#lane && binding.profile === this.#lane.label) return this.#lane;
    return null;
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
    const results = { ingested: 0, deferred: 0, duplicates: 0, failed: 0, rejected: 0, statuses: 0 };
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
      else if (outcome.kind === 'deferred') results.deferred += 1;
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
    // Without perception, a media item is recorded exactly as before multimodal v1 (`unsupported`, its type only).
    // A reaction is kept (emoji + target) only where media perception is composed; elsewhere it is unsupported, as before.
    const ec = event.content;
    const c = ec.kind === 'media' && !this.#perceivesMedia(undefined, ec.mediaKind) ? { kind: 'unsupported' as const, contentType: ec.mediaKind }
      : ec.kind === 'reaction' && !this.#perceivesMedia() ? { kind: 'unsupported' as const, contentType: 'reaction' }
      : ec;
    // A media item keeps only its provider reference until it is perceived (or held as unsupported); never bytes.
    // A contact's text never starts with a platform header: "[r4:…" written by the contact is neutralized, so it can
    // never pose as a perceived file or a reaction.
    const text = c.kind === 'text' ? c.text.replace(/^(\s*)\[\s*r4\s*:/i, '$1[r4 :') : c.kind === 'reaction' ? reactionRefContent({ emoji: c.emoji, targetProviderMessageId: c.targetProviderMessageId }) : c.kind === 'media'
      ? mediaRefContent({ kind: c.mediaKind, mediaId: c.mediaId, mimeType: c.mimeType, sha256: c.sha256, caption: c.caption, voice: c.voice })
      : unsupportedContentMarker(c.contentType);
    const inbound = {
      inboundId: this.#o.ids.next(),
      channel: event.channel,
      providerEventId: event.providerEventId,
      contentKind: c.kind === 'reaction' ? ('unsupported' as const) : c.kind,
      contentType: c.kind === 'unsupported' ? c.contentType : c.kind === 'media' ? c.mediaKind : c.kind === 'reaction' ? 'reaction' : 'text',
      content: text,
      contentSha256: sha256Hex(text),
      conversationKey: key,
      accountRef: event.accountRef,
      conversationRef: event.conversationRef,
      occurredAt: event.occurredAt,
      status: 'received',
      failureCode: null,
      correlationId,
    } as const;
    const { inspector } = this.#o;
    // With an inspector, the content is decided (and hashed) only inside the locked inbound transaction.
    const { record, created } = inspector
      ? await this.#o.store.recordInboundInspected(inbound, {
          inspector,
          inspectable: c.kind === 'text',
          senderRef: event.senderRef,
          direct: this.#adapters.get(event.channel)?.directConversations === true && event.senderRef === event.conversationRef,
        })
      : await this.#o.store.recordInbound(inbound);
    if (!created) {
      emitTelemetry(this.#o.logger, 'inbound.duplicate', { channel: event.channel, inboundId: record.inboundId, status: record.status, correlationId });
      return { kind: 'duplicate', inboundId: record.inboundId };
    }
    emitTelemetry(this.#o.logger, 'inbound.received', { channel: event.channel, inboundId: record.inboundId, contentKind: c.kind, correlationId });
    if (record.contentKind === 'media' && this.#perceivesMedia()) {
      // Acknowledged now (the row is durable); download and perception run after the response. A crash leaves the row
      // `received` and the resume sweep processes it.
      this.#inFlight.add(record.inboundId);
      void this.#process(record)
        .catch((error: unknown) => emitTelemetry(this.#o.logger, 'inbound.media.deferred_failed', { channel: record.channel, inboundId: record.inboundId, error: error instanceof PlatformError ? error.code : 'infrastructure' }))
        .finally(() => this.#inFlight.delete(record.inboundId));
      return { kind: 'deferred', inboundId: record.inboundId };
    }
    return this.#process(record);
  }

  /** Crash recovery: inbound persisted but never settled (the process died between persistence and ingestion). */
  async resumeUnsettled(olderThanMs = 30_000, limit = 50): Promise<IngestOutcome[]> {
    const pending = await this.#o.store.unsettledInbound(olderThanMs, limit);
    const out: IngestOutcome[] = [];
    for (const record of pending) {
      if (this.#inFlight.has(record.inboundId)) continue;
      this.#inFlight.add(record.inboundId);
      try {
        out.push(await this.#process(record));
      } finally {
        this.#inFlight.delete(record.inboundId);
      }
    }
    return out;
  }

  /**
   * Media is perceived only when perception is composed, no inspector is (its guarantees cover text only) and, for a
   * given binding, its profile is one perception was enabled for. Without a label: for any profile of this gateway.
   */
  #perceivesMedia(profileLabel?: string, kind?: string | null): boolean {
    const m = this.#o.media;
    return m !== undefined && this.#o.inspector === undefined && (profileLabel === undefined || m.profiles.includes(profileLabel))
      && (kind === undefined || (kind !== null && m.perception.kinds.has(kind as MediaKind)));
  }

  /**
   * The input text of a media inbound, decided once. Held, human-owned or not perceivable: the unsupported marker, and
   * nothing is downloaded. Otherwise it is perceived and the framed text is made durable on the inbound row BEFORE it
   * becomes an input, so a crash after this point never perceives (or downloads) the same message again.
   */
  async #mediaText(record: InboundEventRecord, binding: ConversationBindingRecord, held: boolean, profileLabel: string): Promise<string> {
    const ref = record.contentKind === 'media' ? parseMediaRefContent(record.content ?? '') : null;
    const humanOwned = binding.taskId ? ((await this.#o.store.taskState(binding.taskId))?.humanOwned ?? false) : false;
    let text = unsupportedContentMarker(record.contentType ?? 'media');
    const reaction = record.contentKind === 'unsupported' ? parseReactionRefContent(record.content ?? '') : null;
    if (!held && !humanOwned && reaction && this.#perceivesMedia(profileLabel)) {
      // (Reactions) The agent learns which of its messages was reacted to, and whether it is its latest one (the offer).
      const target = await this.#o.store.reactionTarget(record.channel, reaction.targetProviderMessageId);
      const own = target && target.taskId === binding.taskId ? target : null;
      text = this.#o.media!.perception.frameReaction({ emoji: reaction.emoji, target: own ? { text: own.text, latest: own.latest, stepId: own.stepId } : null });
      emitTelemetry(this.#o.logger, 'inbound.media.perceived', { channel: record.channel, inboundId: record.inboundId, outcome: 'reaction', reason: own ? (own.latest ? 'latest_agent_message' : 'earlier_message') : 'unknown_message' });
    } else if (!held && !humanOwned && !(ref && this.#perceivesMedia(profileLabel, ref.kind)) && this.#perceivesMedia(profileLabel)) {
      // Not representable here (an album, a sticker, a kind without a provider…): the agent answers, nothing is downloaded.
      text = this.#o.media!.perception.frameUnsupported(record.contentType ?? 'unsupported');
      emitTelemetry(this.#o.logger, 'inbound.media.perceived', { channel: record.channel, inboundId: record.inboundId, outcome: 'not_representable', reason: record.contentType ?? null });
    } else if (!held && !humanOwned && ref && this.#perceivesMedia(profileLabel, ref.kind)) {
      try {
        const result = await this.#o.media!.perception.perceive(ref, { accountRef: record.accountRef! });
        emitTelemetry(this.#o.logger, 'inbound.media.perceived', { channel: record.channel, inboundId: record.inboundId, outcome: result.outcome, reason: result.reason, ...result.evidence });
        text = result.text;
      } catch {
        // The port never throws; if an implementation does, the input is the marker (never a retry loop of downloads).
        emitTelemetry(this.#o.logger, 'inbound.media.perceived', { channel: record.channel, inboundId: record.inboundId, outcome: 'degraded', reason: 'perception_threw' });
      }
    }
    // Durable BEFORE it becomes an input (also the marker): a resume submits exactly what may already be submitted.
    await this.#o.store.recordInboundPerception(record.inboundId, text);
    return text;
  }

  async #process(stale: InboundEventRecord): Promise<IngestOutcome> {
    const { store, controls, config, temporal, tasks, logger } = this.#o;
    // A snapshot (resume sweep) may be older than the row: a media or unsupported row is processed only while still received.
    const record = stale.contentKind === 'media' || stale.contentKind === 'unsupported' ? await store.inboundEvent(stale.inboundId) : stale;
    if (!record || record.status !== 'received') return { kind: 'duplicate', inboundId: stale.inboundId };
    if (record.conversationKey === null || record.accountRef === null || record.conversationRef === null || record.content === null || record.occurredAt === null) {
      await store.settleInbound(record.inboundId, { status: 'failed', failureCode: 'incomplete_inbound_record' });
      return { kind: 'failed', inboundId: record.inboundId, code: 'incomplete_inbound_record' };
    }
    const media = record.contentKind === 'media';
    const unsupportedRow = record.contentKind === 'unsupported';
    /** The text of a media or unsupported input: the stored decision (after a crash: exactly what may already be submitted), or decided below. */
    let mediaText: string | null = media && parseMediaRefContent(record.content) === null ? record.content
      : unsupportedRow && record.content !== unsupportedContentMarker(record.contentType ?? '') && parseReactionRefContent(record.content) === null ? record.content : null;
    let decidedHere = false;
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
        // A taskless binding opened for a profile this gateway no longer composes (a crash between opening and attaching).
        // If its task was already created, the binding follows that task (never a second task for the same input; a
        // terminal one is handled by the submission's terminal race below). Otherwise reopen under the current assignment.
        if (binding && !binding.taskId && !this.#servedBy(binding)) {
          const created = await store.taskByCreationKey(`conversation-${binding.bindingId}`);
          if (created) {
            binding = await store.attachTask(binding.bindingId, created);
            // The crash came before the open hook ran; hooks are idempotent (the pack's hook, not the profile's).
            await this.#main.taskFactory.afterOpen?.(created, binding);
          } else {
            await store.closeBinding(binding.bindingId, 'profile_not_served');
            emitTelemetry(logger, 'conversation.binding.closed', { channel: record.channel, bindingId: binding.bindingId, taskId: null, reason: 'profile_not_served' });
            binding = null;
          }
        }
        if (!binding) {
          const eligibility = rolloutEligibility(config.rollout, record.conversationKey);
          const assigned = this.#assign(record.conversationKey);
          binding = await store.openBinding({
            bindingId: this.#o.ids.next(), channel: record.channel, conversationKey: record.conversationKey, accountRef: record.accountRef, recipientRef: record.conversationRef,
            autonomy: eligibility.eligible ? 'autonomous' : 'excluded', eligibilityReason: eligibility.reason, rolloutFingerprint: this.#rolloutFingerprint,
            profile: assigned.label, profileFingerprint: assigned.fingerprint,
          });
          emitTelemetry(logger, 'conversation.binding.opened', { channel: record.channel, bindingId: binding.bindingId, autonomy: binding.autonomy, eligibilityReason: binding.eligibilityReason, rolloutBucketed: eligibility.reason === 'cohort', profile: binding.profile });
        }
        // Everything after the opening follows the binding (ADR-045): its profile, never the current lane configuration.
        const served = this.#servedBy(binding) ?? this.#main;
        const { taskFactory } = served;
        // Media is unsupported content (held per profile, never downloaded) unless perceived for this binding's profile.
        // With perception composed for this profile, content it cannot represent is answered by the agent (no hand-off);
        // without it, such content is held per profile exactly as before.
        const unsupported = (unsupportedRow || (media && !this.#perceivesMedia(served.label, record.contentType))) && !this.#perceivesMedia(served.label);
        const decision: InboundAutonomyDecision = decideInboundAutonomy({
          controls: await controls.state(),
          channel: record.channel,
          deniedNow: config.rollout.denylist.includes(record.conversationKey),
          bindingAutonomous: binding.autonomy === 'autonomous',
          unsupportedContent: unsupported,
          unsupportedContentPolicy: served.profile.unsupportedContent,
        });
        const hold = decision.kind === 'hold' ? { reason: decision.reason, summary: decision.summary } : undefined;
        // Decided once; again only after a terminal race (nothing was submitted, and the new task may decide otherwise).
        if ((media || unsupportedRow) && (mediaText === null || (attempt > 0 && decidedHere))) {
          mediaText = await this.#mediaText(record, binding, hold !== undefined, served.label);
          decidedHere = true;
        }
        const input = { externalKey: record.providerEventId, content: mediaText ?? record.content, sourceRef: `channel:${record.channel}`, occurredAt: record.occurredAt };
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
          if (disposition === 'autonomous' && this.#o.onAutonomousInput) {
            try {
              this.#o.onAutonomousInput({ channel: record.channel, accountRef: record.accountRef, providerEventId: record.providerEventId, taskId });
            } catch {
              // Cosmetic hook: it never changes the outcome of an ingested input.
            }
          }
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
