import type { ProductionProfile } from '@r4/live-ops';
import { CAPABILITY_IDS } from '../ids.js';
import { SALES_PRODUCTION_PROFILE_V18, SALES_PRODUCTION_PROFILE_V18_GATE } from './profile-v18.js';

/**
 * Sales production profile, version 19 («F1 canary continuation and quote delivery» §D, UX). A quote lane CANDIDATE,
 * NOT deployed and NOT active. @18 is not changed: @19 is exactly @18 (domains, policy, F1 commercial policy and limits,
 * single-flight issuance, F-ADV-2 notice, the quote PDF to the conversation) except:
 *   - shipping.quote is not bound: F1 quotes are issued without delivery, so the agent cannot price or offer delivery
 *     (the Shipping domain stays REAL: the commercial snapshot still verifies a delivery the customer cannot select);
 *   - definition v18 = v17 with the F1 delivery rule (no delivery offers, prices, promotions, pickup or commune), the
 *     offer presented in the turn the customer asks for the quote, and the validity stated as 60 minutes, the exact
 *     expiry in Chile time being stated by the platform (the PDF caption) and never by the agent.
 * The kernel and the commercial authority (Catalog V2, Quote V2) are unchanged.
 */
export const SALES_PRODUCTION_PROFILE_V19: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V18,
  version: 19,
  description: 'Sales F1 quote lane candidate (successor of @18): @18 without shipping.quote (quotes without delivery) and with definition v18 (no delivery offers, the offer presented when the quote is asked, validity stated as 60 minutes). Catalog V2 + Discover, Quote V2 autonomous issuance of the confirmed Sales-rendered offer, the quote PDF to the conversation, F1 policy and limits, kill switch. Customer, cart, Checkout and payments unavailable.',
  capabilities: SALES_PRODUCTION_PROFILE_V18.capabilities.filter((c) => c.capabilityId !== CAPABILITY_IDS.shippingQuote),
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V19_PROFILE_LABEL = 'sales-production@19';

/**
 * (owner decision «Activación @18, cierre @19 y decisiones R4-L», 2026-11-10) Profiles whose quote issuance follows the
 * customer's intent as the agent interprets it (quote.preview@4 with offer template v2, quote.create@6 with the intent
 * guard) instead of the closed confirmation grammar. Every other control is unchanged. @17 and @18 keep the grammar.
 */
export const SALES_INTENT_ACCEPTANCE_PROFILES: ReadonlySet<string> = new Set([SALES_QUOTE_LANE_V19_PROFILE_LABEL]);

/** What must be true before @19 is activated on the lane: what @18 requires, plus the UX evaluation with the real model. */
export const SALES_PRODUCTION_PROFILE_V19_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V18_GATE.filter((g) => g.id !== 'profile-18-registered' && g.id !== 'explicit-authorization'),
  { id: 'ux-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHAs: no delivery offer, price, promotion or pickup and no commune asked; the offer presented in the turn the quote is asked (no extra confirmation round); the validity stated as 60 minutes without an expiry date or time from the agent; latency measured per component (scripts/r4-f1-latency.mjs) and compared with @17' },
  { id: 'profile-19-registered', blocking: true, requirement: 'identifier @19 verified free, then registered with production:sales:bootstrap --lane (registers the candidate definition v18)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @19, by exact SHA, allowlist only; @17 (or @18) kept as rollback' },
] as const);
