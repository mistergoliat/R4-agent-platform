import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V20, SALES_PRODUCTION_PROFILE_V20_GATE } from './profile-v20.js';

/**
 * Sales production profile, version 21 (owner feedback 2026-11-17 after testing @20 on WhatsApp). A quote lane
 * CANDIDATE, NOT active. @20 is not changed and stays the rollback: @21 is exactly @20 (and so @19: domains,
 * capabilities, F1-COMMERCIAL-POLICY-v2 and v3 switch, F1 limits, single-flight issuance, intent guard, the quote PDF,
 * F-ADV-2 notice, media perception eligibility) pinned to definition v21 = v20 plus:
 *   - thanks and goodbyes always get a brief warm reply; never complete after a customer message;
 *   - greetings as guidance (no literal greeting or thank-you example) and the tone examples never copied verbatim;
 *   - a use at or near a product's stated maximum capacity is at the limit with no margin, never presented as fitting;
 *   - an open need without budget or context is explored (or a simple option offered) before a high-priced machine;
 *   - no platform or policy terms shown to the customer.
 * The kernel and the commercial authority (Catalog V2, Quote V2, Shipping) are unchanged.
 */
export const SALES_PRODUCTION_PROFILE_V21: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V20,
  version: 21,
  description: 'Sales F1 quote lane candidate (successor of @20): @20 unchanged (delivery at the Shipping owner price, F1-COMMERCIAL-POLICY-v2, acceptance of the offer interpreted in natural language with quote.preview@4, quote.create@6 and the intent guard) pinned to definition v21 (v20 plus the owner feedback of 2026-11-17). Catalog V2 + Discover, Shipping, Quote V2 autonomous issuance, the quote PDF to the conversation, F1 limits, kill switch. Customer, cart, Checkout and payments unavailable.',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V21_PROFILE_LABEL = 'sales-production@21';

/** What must be true before @21 is activated on the lane: what @20 requires, plus the feedback cases with the real model. */
export const SALES_PRODUCTION_PROFILE_V21_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V20_GATE.filter((g) => g.id !== 'profile-20-registered' && g.id !== 'explicit-authorization'),
  { id: 'feedback-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHA, replaying the owner cases of 2026-11-17: "gracias" after an issued quote gets a brief warm reply and the task stays open (no complete); the greeting is not a fixed line and is not copied from the tone examples; a 150 kg customer is never offered a 150 kg-max bar as fitting; "algo para espalda" without budget is explored (or a simple option offered) before a high-priced machine; a promotion that cannot be quoted is explained in customer words without platform terms' },
  { id: 'profile-21-registered', blocking: true, requirement: 'identifier @21 registered with production:sales:bootstrap --lane (registers the candidate definition v21)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @21, by exact SHA, allowlist only; @20 kept as rollback' },
] as const);
