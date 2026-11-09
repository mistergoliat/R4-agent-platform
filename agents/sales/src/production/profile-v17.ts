import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V16 } from './profile-v16.js';

/**
 * Sales production profile, version 17 (O-2, 2026-11-09). A quote lane CANDIDATE, NOT deployed and NOT active.
 * @16 is not changed retroactively: @17 is exactly @16 (same capabilities, policy, P-1 guard, F1 ceilings and
 * definition v16) except that it binds catalog.get_product_context@2, whose variant options carry each variant's
 * sellability and reason as Catalog evaluates them for one unit (read from the owner's item context; the product
 * context has none). No quantity is exposed: the quantity is still confirmed only by quote.preview. A variant the
 * owner could not be read for is `unreadable` (unknown), never "not sellable".
 */
export const SALES_PRODUCTION_PROFILE_V17: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V16,
  version: 17,
  description: 'Sales E2 quote lane candidate (successor of @16): @16 plus the per-variant sellability for one unit in catalog.get_product_context@2 (never a quantity). Catalog V2 + Discover, Shipping, Quote V2 autonomous issuance of the confirmed Sales-rendered offer, parity-verified SKUs only, F1 limits, kill switch; definition v16. Customer, cart, Checkout and payments unavailable.',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V17_PROFILE_LABEL = 'sales-production@17';

/** Profiles that bind catalog.get_product_context@2 (per-variant sellability); every other profile keeps @1. */
export const SALES_VARIANT_AVAILABILITY_PROFILES: ReadonlySet<string> = new Set([SALES_QUOTE_LANE_V17_PROFILE_LABEL]);

/** What must be true before @17 replaces @16 as the quote lane candidate (none of it is done by this increment). */
export const SALES_PRODUCTION_PROFILE_V17_GATE = Object.freeze([
  { id: 'v16-gate', blocking: true, requirement: 'every blocking item of SALES_PRODUCTION_PROFILE_V16_GATE (@17 issues quotes exactly as @16)' },
  { id: 'o2-evaluation', blocking: true, requirement: 'catalog.get_product_context@2 evaluated with the real model and real Catalog V2 on the variant scenarios (O-1, O-2): no availability claim beyond what the owner reported' },
  { id: 'profile-17-registered', blocking: true, requirement: 'identifier @17 verified free, then registered with production:sales:bootstrap --lane (definition v16 is reused)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @17, by SHA' },
] as const);
