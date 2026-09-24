import { createHmac } from 'node:crypto';
import { fingerprint } from '@r4/contracts';
import type { ProductionConfig } from './mode.js';

/**
 * Conversation identity and rollout (R4-I).
 *
 * A channel conversation is known to R4 by a KEYED hash of (channel, account,
 * conversation ref): stable per conversation, meaningless without the key,
 * and the only form in which identities appear in configuration (allowlist,
 * denylist) — plain addresses never do. The delivery address itself is kept
 * only on the conversation binding, where delivery needs it.
 */
export function conversationKey(identityHashKey: string, channel: string, accountRef: string, conversationRef: string): string {
  return createHmac('sha256', identityHashKey).update(`${channel}\u0000${accountRef}\u0000${conversationRef}`, 'utf8').digest('hex');
}

/** Stable bucket in [0, 10000) derived from the conversation key (never from a request or a clock). */
export function rolloutBucket(key: string): number {
  return Number.parseInt(key.slice(0, 8), 16) % 10_000;
}

export type RolloutConfig = ProductionConfig['rollout'];

export interface RolloutEligibility {
  readonly eligible: boolean;
  /** allowlisted | cohort | denied | not_in_cohort */
  readonly reason: 'allowlisted' | 'cohort' | 'denied' | 'not_in_cohort';
  readonly bucket: number;
}

/**
 * Deterministic eligibility of one conversation. Precedence inside the
 * rollout: explicit deny > allowlist > percentage cohort. With the default
 * (0 %, empty allowlist) nobody is eligible.
 */
export function rolloutEligibility(rollout: RolloutConfig, key: string): RolloutEligibility {
  const bucket = rolloutBucket(key);
  if (rollout.denylist.includes(key)) return { eligible: false, reason: 'denied', bucket };
  if (rollout.allowlist.includes(key)) return { eligible: true, reason: 'allowlisted', bucket };
  if (bucket < Math.round(rollout.percent * 100)) return { eligible: true, reason: 'cohort', bucket };
  return { eligible: false, reason: 'not_in_cohort', bucket };
}

/** Identity of the rollout rules; lists are fingerprinted, never echoed. */
export function rolloutFingerprint(rollout: RolloutConfig): string {
  return fingerprint({ percent: rollout.percent, allowlist: [...rollout.allowlist].sort(), denylist: [...rollout.denylist].sort() });
}
