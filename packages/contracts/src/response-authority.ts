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
 *   REVALIDATION_REQUIRED   the draft relies on expired evidence: the kernel
 *                           issues these READs itself (durable, origin
 *                           `platform`, token-free), then validates the SAME
 *                           draft again — unchanged truth keeps the draft
 *   REJECT                  the draft contradicts evidence (or evidence could
 *                           not be revalidated): recorded `refused` with the
 *                           structured feedback, never sent; the model gets
 *                           exactly one correction cycle, after which the
 *                           validator's safe degradation is recorded instead
 *
 * This is authority enforcement, not quality evaluation (ADR-025 still
 * forbids generic guards, arbitrary retries and LLM judging in the loop).
 */
export type ResponseAuthorityVerdict =
  | { readonly kind: 'allow'; readonly claims?: readonly JsonObject[] }
  | { readonly kind: 'revalidation_required'; readonly reads: readonly { readonly capabilityId: string; readonly arguments: JsonObject }[]; readonly claims?: readonly JsonObject[] }
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
/** Correction cycles per outbound candidate: one model rewrite, then safe degradation. */
export const MAX_AUTHORITY_CORRECTIONS = 1;
