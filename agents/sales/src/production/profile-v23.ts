import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V22, SALES_PRODUCTION_PROFILE_V22_GATE } from './profile-v22.js';

/**
 * Sales production profile, version 23 (owner decision 2026-11-23 on live @22). A quote lane CANDIDATE, NOT active.
 * @22 is not changed and stays the rollback: @23 is exactly @22 (and so @21/@19) pinned to definition v23 = v22 with the
 * quantity-availability rule changed: when the customer asks how many units there are, the agent says the units in stock
 * that catalog.get_product_context@3 reports, capped by Sales at 20 ("más de 20" above it). quote.preview stops showing
 * the model the uncapped available quantity. The kernel and the commercial authority are unchanged.
 */
export const SALES_PRODUCTION_PROFILE_V23: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V22,
  version: 23,
  description: 'Sales F1 quote lane candidate (successor of @22): @22 unchanged (F1-COMMERCIAL-POLICY-v2, quote.preview@4, quote.create@6, intent guard, quote recovery) pinned to definition v23 (v22 plus units in stock told on request, capped at 20) with catalog.get_product_context@3. Catalog V2 + Discover, Shipping, Quote V2 autonomous issuance, the quote PDF, F1 limits, kill switch. Customer, cart, Checkout and payments unavailable.',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V23_PROFILE_LABEL = 'sales-production@23';

/** Profiles whose product context carries capped units in stock and whose preview hides the uncapped quantity. */
export const SALES_STOCK_COUNT_PROFILES: ReadonlySet<string> = new Set([SALES_QUOTE_LANE_V23_PROFILE_LABEL, 'sales-production@24']);

/** What must be true before @23 is activated on the lane: what @22 requires, plus the units-in-stock cases with the real model. */
export const SALES_PRODUCTION_PROFILE_V23_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V22_GATE.filter((g) => g.id !== 'profile-22-registered' && g.id !== 'explicit-authorization'),
  { id: 'stock-count-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHA: asked how many units there are, the agent says the exact units up to 20 and "más de 20" above it (never a larger number); it does not volunteer units when not asked; no promise that the units stay available' },
  { id: 'profile-23-registered', blocking: true, requirement: 'identifier @23 registered with production:sales:bootstrap --lane (registers the candidate definition v23)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @23, by exact SHA; @22 kept as rollback' },
] as const);
