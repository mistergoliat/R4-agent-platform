import type { JsonObject } from './primitives.js';
import type { Observation } from './observation.js';

/**
 * ADR-031 — the pre-respond authority boundary.
 *
 * Immediately before a proposed `respond` becomes durable (and therefore
 * outbound), the kernel asks the pack's validator whether the draft is
 * compatible with the owner evidence the task holds. The validator is
 * deterministic (no model, no judge) and domain-owned; the kernel knows only
 * the verdicts and enforces their bounds:
 *
 *   ALLOW                   record the draft as is
 *   REVALIDATION_REQUIRED   the draft relies on evidence that is expired or
 *                           about to expire: the kernel issues these READs
 *                           itself (durable, origin `platform`, token-free),
 *                           then validates the SAME draft again — unchanged
 *                           truth keeps the draft. With `notBefore` (evidence
 *                           still inside the owner's validity window, so a
 *                           refresh now would return that same window) the
 *                           draft is deferred durably: recorded `refused`
 *                           (`response_authority_deferred`, never sent) and
 *                           the run waits (platform WAIT_UNTIL) until
 *                           `notBefore`; the run woken from that wait issues
 *                           the READs and validates the draft first, without
 *                           a model call. A draft is deferred at most once.
 *   REJECT                  the draft contradicts evidence (or evidence could
 *                           not be revalidated): recorded `refused` with the
 *                           structured feedback, never sent. Recovery budget
 *                           per RUN (not per draft): one model correction
 *                           cycle, then ONE safe degradation (recorded as a
 *                           platform `respond`); a later invalid draft of the
 *                           same run is refused without any further outbound.
 *                           Safe degradation exhausts response-authority
 *                           recovery for authoritative claims for the
 *                           remainder of that Run (R4-J1E-R2.1): once degraded,
 *                           a draft with one or more claims is refused
 *                           (`response_authority_suppressed`) even when the
 *                           validator ALLOWs it, and REVALIDATION_REQUIRED opens
 *                           no new recovery (no deferral, wait or platform
 *                           READ). A draft with no claims keeps the normal
 *                           semantics (conversational continuity).
 *                           A run woken from a revalidation wait continues the
 *                           budget of the run that deferred.
 *
 * This is authority enforcement, not quality evaluation (ADR-025 still
 * forbids generic guards, arbitrary retries and LLM judging in the loop).
 */
export type ResponseAuthorityVerdict =
  | { readonly kind: 'allow'; readonly claims?: readonly JsonObject[] }
  | {
      readonly kind: 'revalidation_required';
      readonly reads: readonly { readonly capabilityId: string; readonly arguments: JsonObject }[];
      /** ISO instant before which the READs cannot yield a new owner validity window: defer until then (durably, never a sleep). */
      readonly notBefore?: string;
      readonly claims?: readonly JsonObject[];
    }
  | { readonly kind: 'reject'; readonly code: string; readonly feedback: string; readonly claims?: readonly JsonObject[] };

export interface ResponseAuthorityInput {
  readonly content: string;
  /** Every observation of the task, in order (the latest per subject is the current evidence). */
  readonly observations: readonly Observation[];
}

export interface ResponseAuthorityValidator {
  validate(input: ResponseAuthorityInput): ResponseAuthorityVerdict | Promise<ResponseAuthorityVerdict>;
  /** The safe response recorded when a corrected draft is still not acceptable. Must carry no unvalidated claim. */
  degraded(input: ResponseAuthorityInput & { readonly verdict: ResponseAuthorityVerdict }): string;
}

/** At most this many revalidation READs per draft (bounded, never a loop). */
export const MAX_REVALIDATION_READS = 6;
/** Correction cycles per run: one model rewrite, then (once per run) the safe degradation. */
export const MAX_AUTHORITY_CORRECTIONS = 1;
/** A `respond` deferred until its evidence can be revalidated: refused (never sent) but not a rejection — it uses no correction. */
export const RESPONSE_AUTHORITY_DEFERRED = 'response_authority_deferred';
/** The invalid draft that the run's one safe degradation replaced. */
export const RESPONSE_AUTHORITY_DEGRADED = 'response_authority_degraded';
/** A draft with authority claims after the run's safe degradation: refused even if allowed (R4-J1E-R2.1). */
export const RESPONSE_AUTHORITY_SUPPRESSED = 'response_authority_suppressed';
