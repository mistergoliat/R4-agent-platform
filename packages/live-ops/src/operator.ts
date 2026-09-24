import { PlatformError, trustedHumanContextSchema, type HumanScope, type IdGenerator, type TrustedHumanContext } from '@r4/contracts';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import type { TemporalRuntime } from '@r4/task-runtime';
import type { AutonomyControls } from './controls.js';
import { CANCEL_REASONS } from './delivery.js';
import type { ProductionStore, ThreadEntry } from './ports.js';

function requireScope(human: TrustedHumanContext, scope: HumanScope): void {
  if (!human.scopes.includes(scope)) throw new PlatformError('precondition', 'human_scope_denied', `operator lacks the ${scope} scope`);
}

/**
 * Operator plane of production conversations (R4-I), API-only. It ports the
 * proven operator semantics of the existing channel operation (thread
 * visibility with incremental polling, takeover that atomically supersedes
 * pending agent sends, manual reply, delivery/read/failed visibility) onto
 * R4's owners: ownership stays with the Temporal Runtime (R4-E), delivery
 * with the delivery owner, conversation text with the task's durable records.
 * Identity always comes from a TrustedHumanContext.
 */
export class ProductionOperator {
  readonly #store: ProductionStore;
  readonly #temporal: TemporalRuntime;
  readonly #controls: AutonomyControls;
  readonly #ids: IdGenerator;
  readonly #logger: StructuredLogger;

  constructor(options: { store: ProductionStore; temporal: TemporalRuntime; controls: AutonomyControls; ids: IdGenerator; logger: StructuredLogger }) {
    this.#store = options.store;
    this.#temporal = options.temporal;
    this.#controls = options.controls;
    this.#ids = options.ids;
    this.#logger = options.logger;
  }

  /** The conversation as operators see it: contact, agent, operator and system entries with delivery state. `after` = cursor of the last entry seen (incremental polling). */
  async thread(taskId: string, after?: string): Promise<{ entries: ThreadEntry[]; cursor: string | null }> {
    const all = await this.#store.thread(taskId);
    const entries = after ? all.filter((e) => e.cursor > after) : all;
    return { entries, cursor: all.at(-1)?.cursor ?? after ?? null };
  }

  conversations(limit = 100) {
    return this.#store.conversations(Math.min(Math.max(limit, 1), 500));
  }

  /** Production attention (unknown/held/failed outbound, failed/rejected inbound, unmatched evidence) next to R4-E's task attention. */
  async attention() {
    return { production: await this.#store.attention(), tasks: await this.#temporal.attention() };
  }

  /** Outbound inspection: lifecycle, attempts and provider evidence — no secrets, no reasoning. */
  async outbound(outboundId: string) {
    const outbound = await this.#store.outbound(outboundId);
    if (!outbound) throw new PlatformError('not_found', 'outbound_not_found', 'outbound message not found');
    const text = (await this.#store.thread(outbound.taskId)).find((e) => e.delivery?.outboundId === outboundId)?.text ?? null;
    return { outbound, text, attempts: await this.#store.attempts(outboundId), events: await this.#store.deliveryEvents(outboundId) };
  }

  outboundForTask(taskId: string) {
    return this.#store.outboundForTask(taskId);
  }

  /**
   * Manual reply (ported semantics): the operator takes human ownership of
   * the task if it does not already hold it (R4-E takeover: the run is
   * suspended, no autonomous claim until release), every pending agent
   * outbound of the task is cancelled `superseded_by_operator`, and the
   * operator's text becomes a durable outbound of origin `operator` owned by
   * the same delivery lifecycle (idempotent by `responseKey`).
   */
  async manualReply(taskId: string, body: { responseKey: string; text: string }, context: TrustedHumanContext) {
    const human = trustedHumanContextSchema.parse(context);
    requireScope(human, 'handoff.manage');
    const text = body.text.trim();
    if (text.length === 0 || text.length > 4096) throw new PlatformError('validation', 'validation_failed', 'a manual reply needs 1–4096 characters');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.responseKey)) throw new PlatformError('validation', 'validation_failed', 'responseKey must be 1-128 characters of [A-Za-z0-9._:-]');
    const binding = await this.#store.bindingByTask(taskId);
    if (!binding) throw new PlatformError('precondition', 'task_not_channel_bound', 'the task is not bound to a channel conversation');
    const { ownership } = await this.#temporal.inspect(taskId);
    if (ownership.owner !== 'human' || ownership.humanRef !== human.humanRef) {
      await this.#temporal.takeOver(taskId, { responseKey: `manual-reply:${body.responseKey}`, note: 'The operator took over the conversation to reply manually.' }, human);
    }
    const superseded = await this.#store.cancelPendingAgentOutbound(taskId, CANCEL_REASONS.supersededByOperator);
    const { record, replayed } = await this.#store.createOperatorOutbound({ outboundId: this.#ids.next(), taskId, text, humanRef: human.humanRef, responseKey: body.responseKey, correlationId: human.correlationId });
    if (!replayed) emitTelemetry(this.#logger, 'outbound.created', { outboundId: record.outboundId, taskId, channel: record.channel, origin: 'operator', status: record.status, supersededAgentOutbound: superseded, correlationId: human.correlationId });
    return { outbound: record, replayed, supersededAgentOutbound: superseded };
  }

  /** Settles an unknown outcome with evidence the operator obtained out of band (never a retry). */
  async resolveOutbound(outboundId: string, body: { outcome: 'delivered' | 'failed'; note: string }, context: TrustedHumanContext) {
    const human = trustedHumanContextSchema.parse(context);
    requireScope(human, 'reconciliation.manage');
    if (body.note.trim().length === 0) throw new PlatformError('validation', 'validation_failed', 'an operator resolution needs a note with the evidence');
    const outbound = await this.#store.resolveOutbound({ outboundId, outcome: body.outcome, humanRef: human.humanRef, note: body.note, correlationId: human.correlationId });
    emitTelemetry(this.#logger, 'outbound.resolved', { outboundId, taskId: outbound.taskId, outcome: body.outcome, humanRef: human.humanRef });
    return outbound;
  }

  /** Cancels a pending (or held) outbound before it is submitted. Never touches submitted ones. */
  async cancelOutbound(outboundId: string, context: TrustedHumanContext) {
    const human = trustedHumanContextSchema.parse(context);
    requireScope(human, 'handoff.manage');
    const outbound = await this.#store.cancelOutbound({ outboundId, humanRef: human.humanRef, reason: CANCEL_REASONS.operator, correlationId: human.correlationId });
    emitTelemetry(this.#logger, 'outbound.cancelled', { outboundId, taskId: outbound.taskId, reason: CANCEL_REASONS.operator, humanRef: human.humanRef });
    return outbound;
  }

  async controls() {
    return { state: await this.#controls.state(), records: await this.#controls.records() };
  }

  async setControl(body: { scope: string; autonomyEnabled: boolean; reason: string }, context: TrustedHumanContext) {
    const human = trustedHumanContextSchema.parse(context);
    requireScope(human, 'autonomy.control');
    return this.#controls.set({ ...body, changedBy: human.humanRef, correlationId: human.correlationId });
  }

  metrics() {
    return this.#store.metrics();
  }
}
