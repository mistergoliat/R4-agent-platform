import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V28, SALES_PRODUCTION_PROFILE_V28_GATE } from './profile-v28.js';

/**
 * (Owner 2026-11-25, the sales-web@22 exam) Sales production profile, version 29: a quote lane CANDIDATE, NOT active.
 * @28 is not changed and stays the rollback: @29 is @28 pinned to definition v29 = v28 with four instruction changes:
 * company, wholesale, institutional and project needs handed to a person (request_handoff) and recorded with
 * trigger=traspaso; the closing line only after the second insistence; a new record when real buying intent follows a
 * sin_intencion record; off-topic replies in at most two short sentences and one card. Same capabilities (desk.opportunity.record@2).
 */
export const SALES_PRODUCTION_PROFILE_V29: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V28,
  version: 29,
  description: 'Sales F1 quote lane candidate (successor of @28): @28 unchanged, pinned to definition v29 (v28 plus: B2B and project needs handed to a person and recorded as traspaso, the closing line only after two insistences, a new record when real buying intent follows a joke, off-topic replies in two short sentences).',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V29_PROFILE_LABEL = 'sales-production@29';

/** What must be true before @29 is activated on the lane: what @28 requires, plus the B2B handoff L3. */
export const SALES_PRODUCTION_PROFILE_V29_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V28_GATE.filter((g) => g.id !== 'profile-28-registered' && g.id !== 'explicit-authorization'),
  { id: 'b2b-handoff-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHA: company, wholesale, institutional and project conversations are handed to a person and recorded with trigger=traspaso (evaluations/opportunity.ts, the handoff cases of evaluations/adversarial.ts); a buying turn after a joke records again' },
  { id: 'profile-29-registered', blocking: true, requirement: 'identifier @29 registered with production:sales:bootstrap --lane (registers the candidate definition v29)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @29, by exact SHA; @28 kept as rollback' },
] as const);
