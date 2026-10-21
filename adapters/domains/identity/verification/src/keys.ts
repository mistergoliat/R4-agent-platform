import { createHash } from 'node:crypto';

/**
 * Deterministic identities of SEC-S2 (decision rev. 02 §6.4, plan §4.4).
 *
 * `conversationLockKey` is the 64-bit advisory-lock key that serializes, per conversation, every
 * transaction deciding protection or persistible content (expectation transitions, capture, outcome).
 * SEC-S3 must take the SAME key in the inbound transaction: when the generic helper moves to
 * live-ops, this package must use it (the algorithm is pinned by a test vector).
 */
export function conversationLockKey(channel: string, conversationKey: string): string {
  return createHash('sha256').update(`r4.conversation\u0000${channel}\u0000${conversationKey}`, 'utf8').digest().readBigInt64BE(0).toString();
}

/** CIA `idempotency-key` of a confirm, derived from the authenticated provider event (contract §4: 16–128 of [A-Za-z0-9._:-]). */
export function confirmIdempotencyKey(channel: string, providerEventId: string): string {
  return `vr.${createHash('sha256').update(`${channel}\u0000${providerEventId}`, 'utf8').digest('hex').slice(0, 64)}`;
}
