import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V14 } from './profile-v14.js';

/**
 * Sales production profile, version 16 (F-WA-1, 2026-11-09). The successor CANDIDATE of the quote lane @14, NOT
 * deployed and NOT active. @14 is not changed retroactively: @16 is exactly @14 (Catalog V2 + Discover, Shipping,
 * Quote V2 autonomous issuance of the Sales-rendered offer the customer explicitly confirmed, P-1, F1 ceilings,
 * kill switch; no customer, cart, Checkout or payment) running definition v16 = v14 plus one rule:
 *
 *   quantity availability is never asserted from the product-level availability that catalog.search and
 *   catalog.get_product_context return; it is confirmed only by quote.preview for that quantity (the existing,
 *   deterministic stock check), which reports insufficient_stock with the available quantity.
 *
 * Found by the isolated @14 canary (scenario 5): the model told the buyer "there is stock for 2" from a product that
 * was only "sellable / in stock" with 1 unit; quote.preview blocked the quote. No capability, tool or validation
 * engine is added: the item quantity stays Quote's input (catalog.ts), the rule only stops the unsupported claim.
 */
export const SALES_PRODUCTION_PROFILE_V16: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V14,
  version: 16,
  description: 'Sales E2 quote lane candidate (successor of @14, identical capabilities): Catalog V2 + Discover, Shipping, Quote V2 autonomous issuance of the confirmed Sales-rendered offer, parity-verified SKUs only, F1 limits, kill switch; definition v16 claims a quantity as available only from quote.preview (F-WA-1). Customer, cart, Checkout and payments unavailable.',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V16_PROFILE_LABEL = 'sales-production@16';

/** What must be true before @16 replaces @14 as the quote lane candidate (none of it is done by this increment). */
export const SALES_PRODUCTION_PROFILE_V16_GATE = Object.freeze([
  { id: 'v14-gate', blocking: true, requirement: 'every blocking item of SALES_PRODUCTION_PROFILE_V14_GATE (@16 issues quotes exactly as @14: R1.7, Quote SHA, A10 lockstep, R4 principal, P-1, F-E1-1, L3, authorization)' },
  { id: 'fwa1-evaluation', blocking: true, requirement: 'definition v16 evaluated with the real model on the availability scenarios: no incorrect availability claim and no quote above confirmed stock' },
  { id: 'definition-v16-registered', blocking: true, requirement: 'identifiers v16 and @16 verified free, then registered with production:sales:bootstrap --lane' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @16, by SHA' },
] as const);
