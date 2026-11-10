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
export const SALES_VARIANT_AVAILABILITY_PROFILES: ReadonlySet<string> = new Set([SALES_QUOTE_LANE_V17_PROFILE_LABEL, 'sales-production@18']);

/**
 * (owner mandate «F1 WhatsApp quote canary release gates», 2026-11-09) @17 is the ONLY Sales F1 quote lane candidate; it
 * supersedes @16 (whose F-ADV-1 variant claim it removes). What must be true before @17 is activated on the lane.
 */
export const SALES_PRODUCTION_PROFILE_V17_GATE = Object.freeze([
  { id: 'quote-release', blocking: true, requirement: 'Quote V2 a79d33f deployed with 000010, a verified restore and a rehearsed rollback; joint A10 with R4 (the @14 gate items that concern Quote)' },
  { id: 'f1-commercial-policy', blocking: true, requirement: 'F1-COMMERCIAL-POLICY-v1 approved: Catalog V2 is the commercial authority (no static P-1 file); provenance, bounded validity, price and stock for the quantity, no promotional price until its owners authorize honoring it for 60 minutes, no shipping, the F1 limits' },
  { id: 'principal-60-minutes', blocking: true, requirement: 'Quote principal r4-sales-retail-session (cl-retail-session-60m-v1) authorized by the Quote owner for real F1 traffic; never the five-day r4-sales-integration, never an R4-side expiry' },
  { id: 'write-budget', blocking: true, requirement: 'the @17 lane worker runs R4_EXEC_MAX_WRITE_ACTIONS=6 (F-WA-2)' },
  { id: 'single-flight-issuance', blocking: true, requirement: 'at most one Quote V2 issuance in flight across every worker (shared PostgreSQL advisory lock)' },
  { id: 'human-request-notice', blocking: true, requirement: 'F-ADV-2: an agent-opened consultation or handoff sends the fixed platform notice in @17 conversations' },
  { id: 'l3', blocking: true, requirement: 'L3 on the fixed R4, Quote and Catalog SHAs: no incorrect, duplicated, unauthorized or insufficiently backed quote' },
  { id: 'alerts', blocking: true, requirement: 'operational alerts for the lane (worker, Quote calls, handoffs) verified before the first real write' },
  { id: 'profile-17-registered', blocking: true, requirement: 'identifier @17 verified free, then registered with production:sales:bootstrap --lane (definition v16 is reused)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @17, by exact SHA, allowlist only; @13 kept as rollback' },
] as const);
