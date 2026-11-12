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
    /** Content R4 does not represent (video, documents, reactions, location…): classified, never silently dropped. */
    z.strictObject({ kind: z.literal('unsupported'), contentType: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/) }),
    /** A reaction to an earlier message: the emoji (null = the reaction was removed) and the provider id of that message. */
    z.strictObject({ kind: z.literal('reaction'), emoji: z.string().min(1).max(16).nullable(), targetProviderMessageId: ref }),
    /**
     * (Inbound multimodal v1) An image or audio the contact sent: only the provider's REFERENCE, never the bytes. It is
     * downloaded and perceived only for autonomous work (media.ts); otherwise it is held exactly like `unsupported`.
     */
    z.strictObject({
      kind: z.literal('media'),
      mediaKind: z.enum(['image', 'audio', 'sticker']),
      mediaId: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/),
      mimeType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+(; ?[a-z0-9=._ -]+)*$/i).max(128),
      /** The provider's SHA-256 of the file (hex), when it states one. */
      sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
      /** The contact's own text sent with an image. */
      caption: z.string().trim().min(1).max(1024).nullable(),
      /** A recorded voice note, as opposed to a forwarded audio file. */
      voice: z.boolean(),
    }),
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
  /**
   * R4-I.1: the adapter attests that every inbound it canonicalizes belongs to a one-to-one
   * conversation whose subject is the conversation reference. Absent means not attested: an
   * inspector then never takes `senderRef === conversationRef` as proof of a direct sender.
   */
  readonly directConversations?: boolean;
  /** Provider subscription handshake (if the provider has one). */
  verifySubscription(query: Readonly<Record<string, string | undefined>>): { readonly ok: true; readonly body: string } | { readonly ok: false; readonly status: number; readonly reason: string };
  /** Authenticity of a notification, on the raw body exactly as received. Fails closed. */
  authenticate(rawBody: string, headers: HeaderBag): { readonly ok: true } | { readonly ok: false; readonly reason: string };
  /** Canonicalization; never throws for a well-formed but unsupported item (it is `rejected` or `unsupported`). */
  parse(rawBody: string): ParsedNotification;
}

/**
 * (Platform notice document) One file sent with a platform notice: the owner's own bytes, staged by the agent pack
 * after verifying them against the owner's SHA-256 (never regenerated by R4). Never logged.
 */
export interface OutboundDocument {
  readonly contentType: 'application/pdf';
  /** `^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`, shown to the contact. */
  readonly filename: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface OutboundSubmission {
  readonly outboundId: string;
  /** R4's durable idempotency key of this outbound (passed to the provider only if it documents one). */
  readonly idempotencyKey: string;
  readonly accountRef: string;
  readonly recipientRef: string;
  /** The message text; with a document, its caption. */
  readonly text: string;
  readonly attempt: number;
  /** Present only for a platform notice that carries a document (sent only by adapters with `supportsDocuments`). */
  readonly document?: OutboundDocument;
}

export interface OutboundChannelAdapter {
  readonly channel: string;
  /** What this implementation is: a real provider, a documented sandbox, or a local fake (tests). */
  readonly bindingKind: 'real' | 'sandbox' | 'local-fake';
  /** The documented provider contract it follows. */
  readonly contractRef: string;
  /** Free-text window after the last contact message (e.g. 24 h); null = none. */
  readonly customerWindowMs: number | null;
  /** True when `submit` sends `submission.document`; otherwise such an outbound is refused before any provider call. */
  readonly supportsDocuments?: boolean;
  /**
   * One submission. Must classify honestly: `unknown` whenever the request
   * may have reached the provider without a definitive answer. Must never
   * retry by itself (the delivery owner decides).
   */
  submit(submission: OutboundSubmission, options: { readonly timeoutMs: number }): Promise<SubmissionResult>;
  /**
   * Working signal (optional, cosmetic, best effort): tells the contact that the platform is working on this inbound
   * (for example a read receipt and a typing indicator). It is never a message, never part of delivery state, never retried
   * by the platform. Resolves false on any failure; must not throw.
   */
  signalWorking?(signal: { readonly accountRef: string; readonly providerEventId: string }, options: { readonly timeoutMs: number }): Promise<boolean>;
}
