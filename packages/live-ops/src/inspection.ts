import { createHash } from 'node:crypto';

/**
 * R4-I.1 (ADR-040): the single, versioned inspection point of ChannelIngress. It knows no channel,
 * provider or purpose: an inspector is plugged in by composition and decides, inside the inbound
 * transaction, which text may be persisted and hashed. With no inspector, ingress is exactly R4-I.
 *
 * Invariants the ingress guarantees to an inspector:
 *   - it runs after the per-conversation lock and the duplicate check, before any persistence or
 *     hashing of the content (a provider re-delivery is never inspected);
 *   - its context is built from the event the channel adapter authenticated and from platform state
 *     read in the same transaction (open binding, task state, database clock);
 *   - it may write only its own state, through the transaction it receives;
 *   - if it throws, nothing is persisted: the transaction aborts and the provider re-delivers.
 *     An inspector that has a protection obligation and cannot decide returns a replacement instead.
 * An inspector never calls the network, a model or a domain owner.
 */
export interface InboundInspector<Tx = unknown> {
  readonly version: 1;
  /** Composition label (telemetry only). */
  readonly id: string;
  inspect(content: InspectableContent, context: TrustedChannelContext, tx: Tx): Promise<InspectionDecision>;
  /** Whether it currently holds a protection obligation that forbids removing it from the composition (ADR-040 inv. 6). */
  protectionActive(tx: Tx): Promise<boolean>;
}

/** Only text is inspected; unsupported content is persisted as its platform marker. */
export type InspectableContent = { readonly kind: 'text'; readonly text: string };

export interface TrustedChannelContext {
  /** Authenticated by the channel adapter. */
  readonly channel: string;
  readonly accountRef: string;
  readonly conversationRef: string;
  readonly senderRef: string;
  /** The adapter attests a one-to-one conversation AND the sender is the conversation subject. */
  readonly direct: boolean;
  /** Keyed hash of the conversation (rollout.ts). */
  readonly conversationKey: string;
  readonly providerEventId: string;
  readonly occurredAt: string;
  /** Database clock inside the inbound transaction. */
  readonly now: string;
  /** The open binding of the conversation and its task, read in the transaction (null: none yet). */
  readonly binding: {
    readonly bindingId: string;
    readonly recipientRef: string;
    readonly taskId: string | null;
    /** The task exists, is not terminal and has no terminal intent. */
    readonly taskAcceptsInput: boolean;
    /** A handoff is requested or active. */
    readonly humanOwned: boolean;
  } | null;
}

export type InspectionDecision =
  | { readonly kind: 'pass' }
  /** The ONLY text that will be persisted and hashed. */
  | { readonly kind: 'replace'; readonly text: string };

/**
 * The 64-bit advisory-lock key that serializes, per conversation, every transaction deciding what
 * of it may be persisted: the inbound transaction and any inspector state transition use this key.
 */
export function conversationLockKey(channel: string, conversationKey: string): string {
  return createHash('sha256').update(`r4.conversation\u0000${channel}\u0000${conversationKey}`, 'utf8').digest().readBigInt64BE(0).toString();
}
