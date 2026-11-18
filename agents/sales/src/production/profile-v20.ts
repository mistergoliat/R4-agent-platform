import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V19, SALES_PRODUCTION_PROFILE_V19_GATE } from './profile-v19.js';

/**
 * Sales production profile, version 20 (owner decision 2026-11-17: the agent sounds too serious; the most human voice).
 * A quote lane CANDIDATE, NOT active. @19 is not changed and stays the rollback: @20 is exactly @19 (domains,
 * capabilities, F1-COMMERCIAL-POLICY-v2 and v3 switch, F1 limits, single-flight issuance, intent guard, the quote PDF,
 * F-ADV-2 notice, media perception eligibility) pinned to definition v20 = v19 plus:
 *   - the Don Pesín voice section placed first (the winner of the tone replays);
 *   - one product may be recommended as the agent's pick with its reason from verified data, never as objectively best;
 *   - the PDF announced as arriving right here in the chat ("el PDF te llega acá mismo"), still only when queued;
 *   - when items change on a selection whose previous quote was without delivery, ask whether it stays without
 *     delivery before asking for a commune.
 * The kernel and the commercial authority (Catalog V2, Quote V2, Shipping) are unchanged.
 */
export const SALES_PRODUCTION_PROFILE_V20: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V19,
  version: 20,
  description: 'Sales F1 quote lane candidate (successor of @19): @19 unchanged (delivery at the Shipping owner price, F1-COMMERCIAL-POLICY-v2, acceptance of the offer interpreted in natural language with quote.preview@4, quote.create@6 and the intent guard) pinned to definition v20 (v19 plus the Don Pesín voice). Catalog V2 + Discover, Shipping, Quote V2 autonomous issuance, the quote PDF to the conversation, F1 limits, kill switch. Customer, cart, Checkout and payments unavailable.',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V20_PROFILE_LABEL = 'sales-production@20';

/** What must be true before @20 is activated on the lane: what @19 requires, plus the voice evaluation with the real model. */
export const SALES_PRODUCTION_PROFILE_V20_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V19_GATE.filter((g) => g.id !== 'profile-19-registered' && g.id !== 'explicit-authorization'),
  { id: 'voice-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHA: the Don Pesín voice (short, warm, Chilean Spanish, no call-center phrases, no source talk such as "el catálogo confirma") without any product, price, stock or delivery fact outside current observations; the offer message still presented exactly as rendered and accepted in natural language; the PDF announced as arriving in the chat only when document.delivery = queued; a changed selection whose previous quote was without delivery asked whether it stays without delivery before any commune' },
  { id: 'profile-20-registered', blocking: true, requirement: 'identifier @20 registered with production:sales:bootstrap --lane (registers the candidate definition v20)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @20, by exact SHA, allowlist only; @19 kept as rollback' },
] as const);
