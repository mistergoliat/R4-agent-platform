import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V18, SALES_PRODUCTION_PROFILE_V18_GATE } from './profile-v18.js';

/**
 * Sales production profile, version 19. A quote lane CANDIDATE, NOT active (only temporarily on the lane for its L3).
 * @18 is not changed: @19 is @18 (domains, capabilities, F1 limits, single-flight issuance, F-ADV-2 notice, the quote PDF
 * to the conversation) except:
 *   - (owner decision 2026-11-10) the customer's acceptance of the offer is interpreted by the agent in natural language
 *     (quote.preview@4 with offer template v2, quote.create@6 with the deterministic intent guard), no literal phrase;
 *   - (owner decision 2026-11-10) F1-COMMERCIAL-POLICY-v2: delivery is allowed at the price the Shipping owner
 *     (pc-carrier) returns for the products and the commune; that price is current and is the one honored (re-quoted at
 *     issuance like every other fact). v1 (@17, @18) still issues quotes without delivery;
 *   - definition v19 = v17 (with its delivery rules) plus: the offer presented in the turn the customer asks for the
 *     quote, acceptance in natural language without asking for a phrase, and the validity stated as 60 minutes, the
 *     exact expiry in Chile time being stated by the platform (the PDF caption) and never by the agent.
 * Definition v18 (registered on 2026-11-10 when @19 was briefly on the lane without delivery) is no longer pinned by any
 * profile and is never changed. The kernel and the commercial authority (Catalog V2, Quote V2) are unchanged.
 */
export const SALES_PRODUCTION_PROFILE_V19: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V18,
  version: 19,
  description: 'Sales F1 quote lane candidate (successor of @18): delivery at the Shipping owner price (F1-COMMERCIAL-POLICY-v2); definition v19 (offer presented when asked, validity as 60 minutes); acceptance of the offer interpreted in natural language (quote.preview@4, quote.create@6, intent guard). Catalog V2 + Discover, Shipping, Quote V2 autonomous issuance, the quote PDF to the conversation, F1 limits, kill switch. Customer, cart, Checkout and payments unavailable.',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V19_PROFILE_LABEL = 'sales-production@19';

/**
 * (owner decision «Activación @18, cierre @19 y decisiones R4-L», 2026-11-10) Profiles whose quote issuance follows the
 * customer's intent as the agent interprets it (quote.preview@4 with offer template v2, quote.create@6 with the intent
 * guard) instead of the closed confirmation grammar. Every other control is unchanged. @17 and @18 keep the grammar.
 */
export const SALES_INTENT_ACCEPTANCE_PROFILES: ReadonlySet<string> = new Set([SALES_QUOTE_LANE_V19_PROFILE_LABEL]);

/** (owner decision 2026-11-10) Profiles under F1-COMMERCIAL-POLICY-v2: delivery at the Shipping owner's price. */
export const SALES_F1_SHIPPING_PROFILES: ReadonlySet<string> = new Set([SALES_QUOTE_LANE_V19_PROFILE_LABEL]);

/** What must be true before @19 is activated on the lane: what @18 requires, plus the UX evaluation with the real model. */
export const SALES_PRODUCTION_PROFILE_V19_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V18_GATE.filter((g) => g.id !== 'profile-18-registered' && g.id !== 'explicit-authorization'),
  { id: 'ux-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHAs: delivery quoted only at the Shipping owner price and only as offers the customer chooses (never pickup unless returned); the offer presented in the turn the quote is asked (no extra confirmation round); the validity stated as 60 minutes without an expiry date or time from the agent; latency measured per component (scripts/r4-f1-latency.mjs); and the acceptance judged by the real model on natural acceptances and on tricky non-acceptances (conditions, changes with an acceptance word, postponements such as "te confirmo", polite closings): false accepts and false refusals measured and reported before activation, since a false accept spends the single quote of the conversation and one of the deployment-wide hourly quotes' },
  { id: 'profile-19-registered', blocking: true, requirement: 'identifier @19 registered with production:sales:bootstrap --lane (registers the candidate definition v19)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @19, by exact SHA, allowlist only; @18 (or @17) kept as rollback' },
] as const);
