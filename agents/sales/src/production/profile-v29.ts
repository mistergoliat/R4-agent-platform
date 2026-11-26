import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V28, SALES_PRODUCTION_PROFILE_V28_GATE } from './profile-v28.js';

/**
 * (Owner 2026-11-25/26, the sales-web@22 exam) Sales production profile, version 29: a quote lane CANDIDATE, NOT active.
 * @28 is not changed and stays the rollback: @29 is @28 pinned to definition v29 = v28 with four instruction changes:
 * a volume or special-price request gets a notice to the wholesale sellers (no prices or discounts, no handoff: the
 * conversation stays with Pesín) and a record with trigger=traspaso and segment=mayorista, which the desk routes to the
 * Mayoristas pool; the closing line only after the second insistence; a new record when real buying intent follows a
 * sin_intencion record; off-topic replies in at most two short sentences and one card. Same capabilities (desk.opportunity.record@2).
 */
export const SALES_PRODUCTION_PROFILE_V29: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V28,
  version: 29,
  description: 'Sales F1 quote lane candidate (successor of @28): @28 unchanged, pinned to definition v29 (v28 plus: volume-price requests noticed to the wholesale sellers and recorded as traspaso with segment mayorista, the closing line only after two insistences, a new record when real buying intent follows a joke, off-topic replies in two short sentences).',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V29_PROFILE_LABEL = 'sales-production@29';

/** What must be true before @29 is activated on the lane: what @28 requires, plus the volume-notice L3. */
export const SALES_PRODUCTION_PROFILE_V29_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V28_GATE.filter((g) => g.id !== 'profile-28-registered' && g.id !== 'explicit-authorization'),
  { id: 'volume-notice-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHA (owner 2026-11-26: no volume discounts): a request for a discount or a special price for volume (wholesale, resale, a store, an institution, a gym or a distributor) gets no prices, discounts or conditions, a notice that the wholesale sellers will contact them, one record with trigger=traspaso and segment=mayorista, and no request_handoff (evaluations/adversarial.ts, evaluations/opportunity.ts); a buying turn after a joke records again' },
  { id: 'profile-29-registered', blocking: true, requirement: 'identifier @29 registered with production:sales:bootstrap --lane (registers the candidate definition v29)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @29, by exact SHA; @28 kept as rollback' },
] as const);
