import { autonomyEnabledFor, type AutonomyControlsState } from './autonomy.js';

/**
 * Durable outbound delivery (R4-I). `AgentDecision.respond` means "R4
 * accepted this response" — nothing more. Delivery is a separate, owned
 * lifecycle whose states are never collapsed:
 *
 *   pending ──► dispatching ──► accepted ──► delivered ──► read
 *      │  ▲           │  │  │         │           │
 *      │  └── retry ──┘  │  └► unknown ┴─ (callback / operator) ─► accepted | delivered | read | failed
 *      │  (definitely    ▼
 *      │   not sent)   failed
 *      └──► cancelled (never submitted: superseded, human-owned, closed, stale, operator)
 *
 * - `accepted`  the provider acknowledged the submission (has a provider id).
 * - `delivered` / `read`  provider evidence (status callbacks); `read` only
 *   where the channel reports it.
 * - `unknown`   the submission may or may not have reached the provider
 *   (timeout, connection lost after sending, 5xx, crash mid-call). It is
 *   NEVER retried automatically: only provider evidence or an operator can
 *   settle it.
 * - `failed`    known not delivered (definitive rejection, retries of
 *   definitely-not-sent attempts exhausted, or a provider failure callback).
 */
export const OUTBOUND_STATUSES = ['pending', 'dispatching', 'accepted', 'delivered', 'read', 'failed', 'unknown', 'cancelled'] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];
export const OUTBOUND_ORIGINS = ['agent', 'operator'] as const;
export type OutboundOrigin = (typeof OUTBOUND_ORIGINS)[number];

/** Why a pending outbound was cancelled without being submitted. */
export const CANCEL_REASONS = {
  supersededByNewerInput: 'superseded_by_newer_input',
  supersededByOperator: 'superseded_by_operator',
  duplicateContent: 'duplicate_content',
  conversationClosed: 'conversation_closed',
  taskTerminal: 'task_cancelled',
  expired: 'expired',
  windowClosed: 'window_closed',
  operator: 'cancelled_by_operator',
} as const;
export type CancelReason = (typeof CANCEL_REASONS)[keyof typeof CANCEL_REASONS];

/** Why a pending outbound is held (stays pending, re-evaluated later). */
export const DISPATCH_HOLD_REASONS = {
  killSwitch: 'autonomy_disabled',
  denied: 'autonomy_denied',
  rolloutExcluded: 'rollout_excluded',
} as const;
export type DispatchHoldReason = (typeof DISPATCH_HOLD_REASONS)[keyof typeof DISPATCH_HOLD_REASONS];

/** Everything the gate needs, read in the same transaction that claims the row. */
export interface DispatchFacts {
  readonly origin: OutboundOrigin;
  readonly channel: string;
  readonly createdAt: string;
  readonly now: string;
  readonly controls: AutonomyControlsState;
  readonly binding: { readonly status: 'open' | 'closed'; readonly autonomous: boolean; readonly deniedNow: boolean };
  readonly task: { readonly status: string; readonly humanOwned: boolean };
  /** Agent output only: a contact input arrived that the context of this response never saw (causal, not clock-based). */
  readonly supersededByNewerInput: boolean;
  /** Whether the channel's contact-service window is open for free text (null = the channel has none). */
  readonly windowOpen: boolean | null;
}

export interface DispatchPolicy {
  /** Pending agent output older than this is cancelled `expired` instead of sent late. */
  readonly maxAgeMs: number;
}

export type DispatchDecision =
  | { readonly kind: 'dispatch' }
  | { readonly kind: 'hold'; readonly reason: DispatchHoldReason }
  | { readonly kind: 'cancel'; readonly reason: CancelReason };

/**
 * The delivery gate, evaluated in the claim transaction immediately before
 * a provider submission (so no concurrent takeover, input or control change
 * can slip between the check and the claim).
 *
 * Agent output:  kill switch > deny > rollout > human ownership > task
 * terminal / binding closed > superseded by newer input > age > window.
 * Operator output is a human act: autonomy controls, rollout, ownership and
 * staleness do not apply; only the channel window does.
 */
export function decideDispatch(f: DispatchFacts, policy: DispatchPolicy): DispatchDecision {
  if (f.origin === 'operator') return f.windowOpen === false ? { kind: 'cancel', reason: CANCEL_REASONS.windowClosed } : { kind: 'dispatch' };
  if (!autonomyEnabledFor(f.controls, f.channel).enabled) return { kind: 'hold', reason: DISPATCH_HOLD_REASONS.killSwitch };
  if (f.binding.deniedNow) return { kind: 'hold', reason: DISPATCH_HOLD_REASONS.denied };
  if (!f.binding.autonomous) return { kind: 'hold', reason: DISPATCH_HOLD_REASONS.rolloutExcluded };
  if (f.task.humanOwned) return { kind: 'cancel', reason: CANCEL_REASONS.supersededByOperator };
  if (f.task.status === 'cancelled' || f.task.status === 'failed') return { kind: 'cancel', reason: CANCEL_REASONS.taskTerminal };
  if (f.binding.status === 'closed' && f.task.status !== 'completed') return { kind: 'cancel', reason: CANCEL_REASONS.conversationClosed };
  if (f.supersededByNewerInput) return { kind: 'cancel', reason: CANCEL_REASONS.supersededByNewerInput };
  if (Date.parse(f.now) - Date.parse(f.createdAt) > policy.maxAgeMs) return { kind: 'cancel', reason: CANCEL_REASONS.expired };
  if (f.windowOpen === false) return { kind: 'cancel', reason: CANCEL_REASONS.windowClosed };
  return { kind: 'dispatch' };
}

/**
 * What one provider submission established, as classified by the channel
 * adapter. `not_sent` means DEFINITELY not sent (the request never left, or
 * the provider refused it before accepting anything, e.g. 429): only these
 * are candidates for an automatic retry.
 */
export const SUBMISSION_OUTCOMES = ['accepted', 'not_sent', 'rejected', 'unknown'] as const;
export type SubmissionOutcome = (typeof SUBMISSION_OUTCOMES)[number];

export interface SubmissionResult {
  readonly outcome: SubmissionOutcome;
  readonly providerMessageId: string | null;
  readonly httpStatus: number | null;
  /** Coarse classification: timeout | network_before_send | network_after_send | rate_limited | provider_5xx | invalid_recipient | auth | policy | window_closed | protocol | adapter_exception … */
  readonly errorClass: string | null;
  /** Provider error code (sanitized), when the provider gave one. */
  readonly errorCode: string | null;
  readonly retryAfterMs: number | null;
  readonly latencyMs: number;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
}

export type SubmissionDisposition =
  | { readonly status: 'accepted' }
  | { readonly status: 'pending'; readonly retryInMs: number }
  | { readonly status: 'failed' }
  | { readonly status: 'unknown' };

/** Delivery retry budget, separate from ADR-028's run-failure recovery budget. */
export function dispositionAfterSubmission(result: SubmissionResult, attempt: number, policy: RetryPolicy): SubmissionDisposition {
  switch (result.outcome) {
    case 'accepted':
      return result.providerMessageId ? { status: 'accepted' } : { status: 'unknown' };
    case 'unknown':
      return { status: 'unknown' };
    case 'rejected':
      return { status: 'failed' };
    case 'not_sent':
      return attempt < policy.maxAttempts ? { status: 'pending', retryInMs: result.retryAfterMs ?? Math.min(1000 * 2 ** attempt, 60_000) } : { status: 'failed' };
  }
}

/** Provider-neutral status evidence (the channel adapter maps provider statuses onto these). */
export const PROVIDER_STATUSES = ['accepted', 'delivered', 'read', 'failed'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

const RANK: Readonly<Record<OutboundStatus, number>> = { pending: 0, dispatching: 1, unknown: 2, failed: 2, accepted: 3, delivered: 4, read: 5, cancelled: -1 };

/**
 * Monotonic reconciliation by provider evidence. Returns the new status, or
 * null when the evidence is stale, duplicate or out of order (recorded, not
 * applied). Delivered evidence outranks an earlier failure (it is proof the
 * contact got it); a failure never overrides delivered/read; nothing moves
 * a status backwards (e.g. delivered → accepted). A cancelled outbound was
 * never submitted: provider evidence for it is anomalous and not applied.
 */
export function statusAfterEvidence(current: OutboundStatus, evidence: ProviderStatus): OutboundStatus | null {
  if (current === 'cancelled' || current === 'pending') return null;
  if (evidence === 'failed') return current === 'dispatching' || current === 'unknown' || current === 'accepted' ? 'failed' : null;
  return RANK[evidence] > RANK[current] ? evidence : null;
}

/** Operator settlement of an unknown outcome (only evidence the operator obtained out of band). */
export function statusAfterOperatorResolution(current: OutboundStatus, outcome: 'delivered' | 'failed'): OutboundStatus | null {
  return current === 'unknown' ? outcome : null;
}
