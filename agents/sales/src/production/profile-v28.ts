import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V27, SALES_PRODUCTION_PROFILE_V27_GATE } from './profile-v27.js';

/**
 * (ADR-062, owner 2026-11-25: an opportunity only with a concrete buying signal) Sales production profile, version 28:
 * a quote lane CANDIDATE, NOT active. @27 is not changed and stays the rollback: @28 is @27 with
 * desk.opportunity.record@2 instead of @1 (the no-intent classification, the platform's buying signals from the task's
 * observations and the opaque contactRef), pinned to definition v28 = v27 with the opportunity block changed and the
 * owner rules of 2026-11-25 (Spanish only, health questions to a professional, absurd questions in one sentence, a closing
 * line after two off-scope insistences, no consultations for small talk).
 */
export const SALES_PRODUCTION_PROFILE_V28: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V27,
  version: 28,
  description: 'Sales F1 quote lane candidate (successor of @27): @27 unchanged except desk.opportunity.record@2 (no-intent classification with a closed reason; buying signals computed by the platform from the conversation; opaque contact reference), pinned to definition v28 (v27 with the opportunity block changed and the owner rules of 2026-11-25: Spanish only, health, scope, insistence).',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V28_PROFILE_LABEL = 'sales-production@28';

/** (ADR-062) Profiles that compose desk.opportunity.record@2 (signals and contactRef); every other recording profile keeps @1. */
export const SALES_DESK_SIGNALS_PROFILES: ReadonlySet<string> = new Set(['sales-web@22', SALES_QUOTE_LANE_V28_PROFILE_LABEL]);

/** What must be true before @28 is activated on the lane: what @27 requires, plus the desk accepting v2, the no-intent and adversarial L3. */
export const SALES_PRODUCTION_PROFILE_V28_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V27_GATE.filter((g) => g.id !== 'profile-27-registered' && g.id !== 'explicit-authorization')
    // (Owner 2026-11-25) The write budget is decided: the F1 ceiling, so the record never starves quote.create.
    .map((g) => (g.id === 'write-budget' ? { ...g, requirement: 'the lane worker runs R4_EXEC_MAX_WRITE_ACTIONS=200 (owner decision 2026-11-25; SALES_F1_CANARY_MAX_WRITE_ACTIONS): the opportunity record never starves the workspace updates or quote.create' } : g)),
  { id: 'desk-v2', blocking: true, requirement: 'the sales desk accepts v2 bodies (version, noIntentReason, signals, contactRef) and creates an opportunity only with a signal and an intent other than sin_intencion' },
  { id: 'no-intent-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHA: jokes, spam, tests, small talk, out-of-scope and pure technical doubts recorded as sin_intencion with their reason, never as a purchase; real buying conversations keep their signals (evaluations/opportunity.ts)' },
  { id: 'adversarial-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHA of the real-traffic adversarial set (evaluations/adversarial.ts): every case passes (Spanish only, at most two short sentences, no catalog reads, no consultation, no generated text, health to a professional, always a reply)' },
  { id: 'profile-28-registered', blocking: true, requirement: 'identifier @28 registered with production:sales:bootstrap --lane (registers the candidate definition v28)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @28, by exact SHA; @27 kept as rollback' },
] as const);
