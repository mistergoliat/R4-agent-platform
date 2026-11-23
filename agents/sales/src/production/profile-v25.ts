import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V24, SALES_PRODUCTION_PROFILE_V24_GATE } from './profile-v24.js';

/**
 * Sales production profile, version 25 (owner feedback on the live @24 relay test, 2026-11-23). A quote lane CANDIDATE,
 * NOT active. @24 is not changed and stays the rollback: @25 is exactly @24 pinned to definition v25 = v24 with the
 * consultation rule sharpened (a follow-up consultation when the customer answers what the team asked; no own
 * technical or safety judgment; no invented services; never "ask PesasChile", the customer is already talking to it)
 * and the official store contacts from pesaschile.cl. Capabilities, the kernel, the non-pausing consultations and their
 * expiry, and the commercial authority are unchanged.
 */
export const SALES_PRODUCTION_PROFILE_V25: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V24,
  version: 25,
  description: 'Sales F1 quote lane candidate (successor of @24): @24 unchanged (consultations without pause, F1-COMMERCIAL-POLICY-v2, quote.preview@4, quote.create@6, intent guard, quote recovery, units capped at 20) pinned to definition v25 (v24 plus follow-up consultations, no own technical judgment or invented services, and the official store contacts). Catalog V2 + Discover, Shipping, Quote V2, the quote PDF, F1 limits, kill switch.',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V25_PROFILE_LABEL = 'sales-production@25';

/** What must be true before @25 is activated on the lane: what @24 requires, plus the relay-test cases with the real model. */
export const SALES_PRODUCTION_PROFILE_V25_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V24_GATE.filter((g) => g.id !== 'profile-24-registered' && g.id !== 'explicit-authorization'),
  { id: 'relay-followup-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHA replaying the owner\'s @24 relay test: in the isolated canary, a consultation (not an own judgment) for a safety question, no invented service, never "ask PesasChile", the official contacts when asked, and the @24 should-ask / should-not-ask cases; live on the owner\'s number (the canary cannot answer a consultation), the follow-up consultation with the customer\'s new facts after a team answer' },
  { id: 'profile-25-registered', blocking: true, requirement: 'identifier @25 registered with production:sales:bootstrap --lane (registers the candidate definition v25)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @25, by exact SHA; @24 kept as rollback' },
] as const);
