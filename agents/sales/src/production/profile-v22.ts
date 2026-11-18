import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V21, SALES_PRODUCTION_PROFILE_V21_GATE } from './profile-v21.js';

/**
 * Sales production profile, version 22 (owner feedback 2026-11-17 on live @21). A quote lane CANDIDATE, NOT active.
 * @21 is not changed and stays the rollback: @22 is exactly @21 (and so @19: domains, capabilities, F1-COMMERCIAL-POLICY-v2
 * and v3 switch, F1 limits, single-flight issuance, intent guard, the quote PDF, F-ADV-2 notice, media perception
 * eligibility) pinned to definition v22 = v21 plus:
 *   - facts stated earlier, including in earlier conversations shown in the context, apply to every recommendation;
 *   - the $1 delivery stated with its range, never with a defensive "not free" line to the customer;
 *   - a quote beyond the autonomous limits: a person offered, request_handoff only when the customer accepts.
 * The kernel and the commercial authority (Catalog V2, Quote V2, Shipping) are unchanged.
 */
export const SALES_PRODUCTION_PROFILE_V22: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V21,
  version: 22,
  description: 'Sales F1 quote lane candidate (successor of @21): @21 unchanged (delivery at the Shipping owner price, F1-COMMERCIAL-POLICY-v2, acceptance of the offer interpreted in natural language with quote.preview@4, quote.create@6 and the intent guard) pinned to definition v22 (v21 plus the owner feedback on live @21). Catalog V2 + Discover, Shipping, Quote V2 autonomous issuance, the quote PDF to the conversation, F1 limits, kill switch. Customer, cart, Checkout and payments unavailable.',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V22_PROFILE_LABEL = 'sales-production@22';

/** What must be true before @22 is activated on the lane: what @21 requires, plus the live-@21 cases with the real model. */
export const SALES_PRODUCTION_PROFILE_V22_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V21_GATE.filter((g) => g.id !== 'profile-21-registered' && g.id !== 'explicit-authorization'),
  { id: 'feedback-2-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHA, replaying the owner cases on live @21 of 2026-11-17: a 150 kg weight and a budget stated in an earlier conversation shown in the context are applied in a new task (no 150 kg-max bar offered as fitting without the customer repeating the weight); the $1 delivery stated with its range and no "no es despacho gratis" line; a quote beyond the autonomous limits explained in customer words with a person offered, request_handoff only after the customer accepts, and no claim that someone was notified before it' },
  { id: 'profile-22-registered', blocking: true, requirement: 'identifier @22 registered with production:sales:bootstrap --lane (registers the candidate definition v22)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @22, by exact SHA, allowlist only; @21 kept as rollback' },
] as const);
