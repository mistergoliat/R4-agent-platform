import { z } from 'zod';
import { timestampSchema } from '@r4/contracts';
import { PROVIDER_STATUSES, type SubmissionResult } from './delivery.js';

/**
 * Channel-neutral contracts (R4-I). A concrete channel adapter (outside Core)
 * translates its provider's transport into these and back; it owns nothing
 * else — never a task, goal, decision or pack state. Core and packs see only
 * these shapes.
 */
const channelId = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const ref = z.string().min(1).max(256);

/** Only what R4 needs from an inbound provider event — never the raw provider payload. */
export const canonicalInboundSchema = z.strictObject({
  channel: channelId,
  /** The provider-side account the conversation happens on (e.g. a business number id). */
  accountRef: ref,
  /** The external conversation identity (the delivery address of replies). */
  conversationRef: ref,
  /** Who sent it on the provider side (usually equal to conversationRef in 1:1 channels). */
  senderRef: ref,
  /** The provider's identity of this event/message: the inbound dedupe key. */
  providerEventId: ref,
  occurredAt: timestampSchema,
  content: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text'), text: z.string().trim().min(1).max(8000) }),
    /** Content R4 does not represent (media, reactions, location…): classified, never silently dropped. */
    z.strictObject({ kind: z.literal('unsupported'), contentType: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/) }),
  ]),
  /** Small provider metadata useful for audit (ids, types); no personal data, no free text. */
  metadata: z.record(z.string().max(64), z.union([z.string().max(128), z.number(), z.boolean()])).default({}),
});
export type CanonicalInbound = z.output<typeof canonicalInboundSchema>;

/** Provider delivery evidence for an earlier submission. */
export const providerStatusEventSchema = z.strictObject({
  channel: channelId,
  providerMessageId: ref,
  status: z.enum(PROVIDER_STATUSES),
  occurredAt: timestampSchema,
  /** Dedupe identity of this evidence (providers may re-deliver it). */
  eventKey: z.string().min(1).max(512),
  /** Sanitized provider error code of a failure. */
  errorCode: z.string().max(64).nullable(),
});
export type ProviderStatusEvent = z.infer<typeof providerStatusEventSchema>;

/** An item of a genuine (authenticated) provider notification that cannot be canonicalized. */
export interface RejectedInbound {
  readonly providerEventId: string | null;
  readonly reason: string;
}

export interface ParsedNotification {
  readonly inbound: readonly CanonicalInbound[];
  readonly statuses: readonly ProviderStatusEvent[];
  readonly rejected: readonly RejectedInbound[];
}

export type HeaderBag = Readonly<Record<string, string | undefined>>;

export interface InboundChannelAdapter {
  readonly channel: string;
  /** Provider subscription handshake (if the provider has one). */
  verifySubscription(query: Readonly<Record<string, string | undefined>>): { readonly ok: true; readonly body: string } | { readonly ok: false; readonly status: number; readonly reason: string };
  /** Authenticity of a notification, on the raw body exactly as received. Fails closed. */
  authenticate(rawBody: string, headers: HeaderBag): { readonly ok: true } | { readonly ok: false; readonly reason: string };
  /** Canonicalization; never throws for a well-formed but unsupported item (it is `rejected` or `unsupported`). */
  parse(rawBody: string): ParsedNotification;
}

export interface OutboundSubmission {
  readonly outboundId: string;
  /** R4's durable idempotency key of this outbound (passed to the provider only if it documents one). */
  readonly idempotencyKey: string;
  readonly accountRef: string;
  readonly recipientRef: string;
  readonly text: string;
  readonly attempt: number;
}

export interface OutboundChannelAdapter {
  readonly channel: string;
  /** What this implementation is: a real provider, a documented sandbox, or a local fake (tests). */
  readonly bindingKind: 'real' | 'sandbox' | 'local-fake';
  /** The documented provider contract it follows. */
  readonly contractRef: string;
  /** Free-text window after the last contact message (e.g. 24 h); null = none. */
  readonly customerWindowMs: number | null;
  /**
   * One submission. Must classify honestly: `unknown` whenever the request
   * may have reached the provider without a definitive answer. Must never
   * retry by itself (the delivery owner decides).
   */
  submit(submission: OutboundSubmission, options: { readonly timeoutMs: number }): Promise<SubmissionResult>;
}
