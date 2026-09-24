import { z } from 'zod';
import { ShadowExecutionPolicy, ShadowViolation, outboundBindingDescriptorSchema, type OutboundBindingDescriptor } from './bindings.js';
import type { ShadowExecutionConfig } from './mode.js';
import { pseudonymousRef, redactPersonalData, sha256 } from './sanitize.js';

/**
 * Shadow outbound (R4-H). `respond` keeps its R4 meaning — a durable
 * decision in the step log, observable, never "delivered" by the runtime.
 * What a channel adapter would later do with it (deliver to a person) is,
 * in shadow, done by the ShadowOutboundSink: it records what WOULD have been
 * sent and to whom (pseudonymously), with `actualDelivery = false`.
 *
 * There is no delivering implementation of `OutboundDelivery` in R4-H; the
 * factory refuses any binding other than the shadow sink, so a real
 * delivery is not a configuration away.
 */
export const shadowOutboundSchema = z.strictObject({
  outboundId: z.string(),
  bindingId: z.string(),
  /** Opaque task reference (the R4 task id). */
  taskRef: z.string(),
  turnIndex: z.int().positive().nullable(),
  /** The run step that recorded the `respond` decision. */
  responseRef: z.string(),
  recipientRef: z.string(),
  /** Channel-neutral message text, with personal data redacted. */
  message: z.string(),
  messageSha256: z.string().regex(/^[0-9a-f]{64}$/),
  redactions: z.record(z.string(), z.int().nonnegative()),
  respondedAt: z.string(),
  recordedAt: z.string(),
  wouldDeliver: z.literal(true),
  actualDelivery: z.literal(false),
});
export type ShadowOutbound = z.infer<typeof shadowOutboundSchema>;

export interface OutboundMessage {
  readonly taskRef: string;
  readonly turnIndex: number | null;
  readonly responseRef: string;
  /** The recipient as the ingress knows it (never stored as-is). */
  readonly recipient: string | null;
  readonly text: string;
  readonly respondedAt: string;
}

export interface OutboundDelivery {
  readonly descriptor: OutboundBindingDescriptor;
  deliver(message: OutboundMessage): ShadowOutbound;
  readonly delivered: readonly ShadowOutbound[];
}

export class ShadowOutboundSink implements OutboundDelivery {
  readonly descriptor: OutboundBindingDescriptor;
  readonly #records: ShadowOutbound[] = [];
  readonly #salt: string;
  readonly #now: () => Date;

  constructor(options: { salt: string; bindingId?: string; now?: () => Date }) {
    this.descriptor = { bindingId: options.bindingId ?? 'shadow-outbound-sink', kind: 'shadow-sink', version: 1 };
    this.#salt = options.salt;
    this.#now = options.now ?? (() => new Date());
  }

  get delivered(): readonly ShadowOutbound[] {
    return [...this.#records];
  }

  /** Records one response exactly once (idempotent by response ref). */
  deliver(message: OutboundMessage): ShadowOutbound {
    const existing = this.#records.find((r) => r.responseRef === message.responseRef);
    if (existing) return existing;
    const sanitized = redactPersonalData(message.text);
    const record = shadowOutboundSchema.parse({
      outboundId: `out_${sha256(`${message.taskRef}:${message.responseRef}`).slice(0, 20)}`,
      bindingId: this.descriptor.bindingId,
      taskRef: message.taskRef,
      turnIndex: message.turnIndex,
      responseRef: message.responseRef,
      recipientRef: pseudonymousRef(message.recipient, this.#salt),
      message: sanitized.text,
      messageSha256: sha256(message.text),
      redactions: sanitized.redactions,
      respondedAt: message.respondedAt,
      recordedAt: this.#now().toISOString(),
      wouldDeliver: true,
      actualDelivery: false,
    });
    this.#records.push(record);
    return record;
  }
}

/** The only way a shadow composition obtains an outbound binding. */
export function createOutboundDelivery(config: ShadowExecutionConfig, descriptor: OutboundBindingDescriptor, options: { salt: string; now?: () => Date }): OutboundDelivery {
  const parsed = outboundBindingDescriptorSchema.parse(descriptor);
  const c = new ShadowExecutionPolicy(config).classifyOutbound(parsed);
  if (c.classification === 'BLOCKED') throw new ShadowViolation('outbound_delivery_refused', `refusing outbound binding: ${c.reason}`);
  return new ShadowOutboundSink({ salt: options.salt, bindingId: parsed.bindingId, ...(options.now ? { now: options.now } : {}) });
}
