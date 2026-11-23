import type { ProductionProfile } from '@r4/live-ops';
import { SALES_PRODUCTION_PROFILE_V23, SALES_PRODUCTION_PROFILE_V23_GATE } from './profile-v23.js';

/**
 * Sales production profile, version 24 (ADR-056 K3, owner authorization 2026-11-23). A quote lane CANDIDATE, NOT active.
 * @23 is not changed and stays the rollback: @24 is exactly @23 pinned to definition v24 = v23 with the consultation rule
 * changed: the agent consults the team without pausing (request_consultation with blocking=false, ADR-056 D1), tells the
 * customer it is confirming it with the team and keeps helping; the answer (or its expiry) wakes the conversation and the
 * agent relays it. Optional suggested answers (2 to 4) become the seller's buttons in the desk. Capabilities, the kernel
 * and the commercial authority are unchanged.
 */
export const SALES_PRODUCTION_PROFILE_V24: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V23,
  version: 24,
  description: 'Sales F1 quote lane candidate (successor of @23): @23 unchanged (F1-COMMERCIAL-POLICY-v2, quote.preview@4, quote.create@6, intent guard, quote recovery, units in stock capped at 20) pinned to definition v24 (v23 plus consultations to the team without pausing the conversation, ADR-056). Catalog V2 + Discover, Shipping, Quote V2 autonomous issuance, the quote PDF, F1 limits, kill switch. Customer, cart, Checkout and payments unavailable.',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_V24_PROFILE_LABEL = 'sales-production@24';

/**
 * Profiles whose worker makes every consultation non-pausing (ADR-056 D1), whatever the model wrote in `blocking`:
 * the L3 run 1 of @24 showed the model omitting it in 2 of 3 consultations (the conversation then paused).
 */
export const SALES_NON_PAUSING_CONSULTATION_PROFILES: ReadonlySet<string> = new Set([SALES_QUOTE_LANE_V24_PROFILE_LABEL]);

/**
 * When the model gives no expiry, a consultation of those profiles expires after this (ADR-056: the pack's SLA), so the
 * customer told «lo confirmo con el equipo» always hears back. 30 minutes = proposed, pending the owner's decision;
 * the desk marks it overdue at 10 and the console alert fires at 10 too.
 */
export const SALES_CONSULTATION_EXPIRY_MS = 30 * 60_000;

/** What must be true before @24 is activated on the lane: what @23 requires, plus the consultation cases with the real model. */
export const SALES_PRODUCTION_PROFILE_V24_GATE = Object.freeze([
  ...SALES_PRODUCTION_PROFILE_V23_GATE.filter((g) => g.id !== 'profile-23-registered' && g.id !== 'explicit-authorization'),
  { id: 'consultation-l3', blocking: true, requirement: 'L3 with the real model on the fixed SHA (ADR-056 K3 evaluation): it consults the team only for what no capability answers (should-ask set) and never for what the catalog answers, a discount or a special price (should-not-ask set, adversarial included); every consultation is without pause and the same turn tells the customer and keeps helping; the answer is relayed faithfully; an expiry is told honestly' },
  { id: 'profile-24-registered', blocking: true, requirement: 'identifier @24 registered with production:sales:bootstrap --lane (registers the candidate definition v24)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @24, by exact SHA; @23 kept as rollback' },
] as const);
