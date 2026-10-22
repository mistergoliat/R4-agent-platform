import { createHash } from 'node:crypto';

/**
 * Deterministic identities of SEC-OTP (decision rev. 02 §6.4, plan §4.4).
 *
 * `conversationLockKey` is the generic live-ops helper (SEC-S3, S3-DEP-01): the inbound transaction
 * and every transition of this package take the SAME advisory-lock key (pinned by a test vector).
 */
export { conversationLockKey } from '@r4/live-ops';

/** CIA `idempotency-key` of a confirm, derived from the authenticated provider event (contract §4: 16–128 of [A-Za-z0-9._:-]). */
export function confirmIdempotencyKey(channel: string, providerEventId: string): string {
  return `vr.${createHash('sha256').update(`${channel}\u0000${providerEventId}`, 'utf8').digest('hex').slice(0, 64)}`;
}
