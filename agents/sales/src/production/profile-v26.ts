import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V25, SALES_PRODUCTION_PROFILE_V25_GATE } from './profile-v25.js';

/**
 * Sales production profile, version 26 (owner decisions of 2026-11-23 after the live @24/@25 tests and the review of the
 * web QA conversations). A quote lane CANDIDATE, NOT active. @25 is not changed and stays the rollback: @26 is exactly
 * @25 pinned to definition v26 = v25 with an asymmetric safety rule (warn from general knowledge, never confirm safety
 * without catalog data or the team), options written by the agent on every consultation, brief help with small general
 * requests, and a thanks answered only once. Capabilities, the kernel, the non-pausing consultations and their expiry,
 * and the commercial authority are unchanged.
 */
export const SALES_PRODUCTION_PROFILE_V26: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V25,
  version: 26,
  description: 'Sales F1 quote lane candidate (successor of @25): @25 unchanged (consultations without pause, follow-up consultations, official contacts, F1-COMMERCIAL-POLICY-v2, quote.preview@4, quote.create@6, intent guard, quote recovery, units capped at 20) pinned to definition v26 (v25 plus asymmetric safety guidance, options on every consultation and brief general help). Catalog V2 + Discover, Shipping, Quote V2, the quote PDF, F1 limits, kill switch.',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V26_PROFILE_LABEL = 'sales-production@26';

/** What must be true before @26 is activated on the lane: what @25 requires, plus the v26 cases with the real model. */
export const SALES_PRODUCTION_PROFILE_V26_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V25_GATE.filter((g) => g.id !== 'profile-25-registered' && g.id !== 'explicit-authorization'),
  { id: 'general-guidance-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHA: general safety guidance without consulting when it answers the question, a consultation only for a product-specific confirmation, never a statement that something is safe without data, options on every consultation, brief help with small general requests, consistent declines, no "answer only yes" adoption, a thanks answered once' },
  { id: 'profile-26-registered', blocking: true, requirement: 'identifier @26 registered with production:sales:bootstrap --lane (registers the candidate definition v26)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @26, by exact SHA; @25 kept as rollback' },
] as const);
