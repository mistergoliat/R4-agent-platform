import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import { LANE_CAPABILITY_IDS } from '../ids.js';
import { SALES_DOMAINS } from './profile.js';
import { SALES_PRODUCTION_PROFILE_V12 } from './profile-v12.js';
import { SALES_PRODUCTION_PROFILE_V13 } from './profile-v13.js';

/**
 * Sales production profile, version 14 (R4 Quote V2 + Checkout E2E, 2026-11-06). The E2 QUOTE LANE profile. NOT
 * deployed and NOT active: a lane profile exactly like @13 (ADR-045: the existing gateway serves it only for the
 * conversations of its lane, through its own worker), selectable only by a production worker and as a gateway lane.
 *
 * = sales-production@12 — Shipping REAL read-only; Quote V2 autonomous issuance of the Sales-rendered offer the
 * customer explicitly confirmed (quote.preview@3, quote.create@5), only for parity-verified SKUs (P-1), within the
 * owner-approved F1 ceilings, Quote V2 writes behind the kill switch; Customer UNAVAILABLE — with Catalog bound
 * exactly as @13 (Catalog V2 only, plus catalog.discover), running definition v14 (v12 + the v13 Discover line).
 *
 * No customer identity, Customer Profile, cart, Checkout or payment capability: buyer identification needs the CIA
 * purchase grant (H3, a candidate), the cart needs H3 and Quote's cart gates, and a payment link needs Checkout /v1
 * and the financial gate F-1..F-7. None of that is composed here; E3 is another profile.
 */
export const SALES_PRODUCTION_PROFILE_V14: ProductionProfile = Object.freeze({
  profileId: 'sales-production',
  version: 14,
  description: 'Sales E2 quote lane on the production number, allowlisted conversations only: Catalog V2 read-only including Discover; Shipping read-only; Quote V2 autonomous issuance (quote.create@5) of the Sales-rendered offer the customer explicitly confirmed, only for parity-verified SKUs, within the owner-approved F1 limits; Quote V2 writes stop with the kill switch; customer, cart, Checkout and payments unavailable; no delivery of quotes.',
  domains: { ...SALES_PRODUCTION_PROFILE_V12.domains, [SALES_DOMAINS.catalog]: SALES_PRODUCTION_PROFILE_V13.domains[SALES_DOMAINS.catalog]! },
  channel: { ...SALES_PRODUCTION_PROFILE_V12.channel },
  capabilities: [...SALES_PRODUCTION_PROFILE_V12.capabilities, { capabilityId: LANE_CAPABILITY_IDS.catalogDiscover, domain: SALES_DOMAINS.catalog, effect: 'read' }],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

export const SALES_QUOTE_LANE_PROFILE_LABEL = 'sales-production@14';

export function isQuoteLaneProfile(profile: ProductionProfile): boolean {
  return profileLabel(profile) === SALES_QUOTE_LANE_PROFILE_LABEL;
}

/** Profiles a gateway may serve as its lane and a production worker may select; never a gateway's main profile. */
export const SALES_LANE_PROFILES: readonly ProductionProfile[] = Object.freeze([SALES_PRODUCTION_PROFILE_V13, SALES_PRODUCTION_PROFILE_V14]);

export function isSalesLaneProfile(profile: ProductionProfile): boolean {
  return SALES_LANE_PROFILES.some((p) => profileLabel(p) === profileLabel(profile));
}

/** The Catalog source a profile binds: V2 only for the lane profiles (decided by the profile, never by a variable). */
export function salesCatalogSourceOf(profile: ProductionProfile): 'v1' | 'v2' {
  return isSalesLaneProfile(profile) ? 'v2' : 'v1';
}

/** What must be true before @14 serves its first real conversation (none of it is done by this increment). */
export const SALES_PRODUCTION_PROFILE_V14_GATE = Object.freeze([
  { id: 'quote-r17', blocking: true, requirement: 'Quote R1.7 gate met on the chosen Quote SHA: restore rehearsed (G2-D02), host restart (G2-D03), disk headroom (G2-D01), synthetic canary, 7 stable days, owner acceptance' },
  { id: 'quote-candidate-sha', blocking: true, requirement: 'a Quote candidate SHA with A10 and the 60-minute session policy, migration 000010 approved for that deploy (cart flag off, H3 closed)' },
  { id: 'a10-lockstep', blocking: true, requirement: 'that Quote SHA and this R4 SHA deployed in lockstep (the deployed 6735352 predates A10: multi-line totals get 422), post-deploy A10 check passed' },
  { id: 'r4-principal', blocking: true, requirement: 'an R4 lane Quote principal with exactly quotes:create, quotes:read, quotes:document:read and the session commercial profile (60 min) or the owner choosing the standard 5-day one' },
  { id: 'parity-evidence', blocking: true, requirement: 'P-1: parity evidence of every SKU the lane may quote, verified against live PrestaShop by the Catalog owner (R4_QUOTE_PARITY_*)' },
  { id: 'ds1-evaluated', blocking: true, requirement: 'definition v14 (v12 + the Discover line) evaluated with the real model: DS-1 prevention and offer copy fidelity accepted by the owner' },
  { id: 'consultation-path', blocking: true, requirement: 'F-E1-1: a consultation does not leave a quoting conversation unanswered (answer path, notice or alerting decided by the owner)' },
  { id: 'definition-v14-registered', blocking: true, requirement: 'identifiers v14 and @14 verified free in the production registry, then registered with production:sales:bootstrap --lane' },
  { id: 'lane-worker-env', blocking: true, requirement: 'lane worker env: the @13 Catalog V2 and Discover variables plus R4_QUOTE_*, the autonomous limits (never looser than the F1 ceilings), the parity file and a write ceiling of 1..6' },
  { id: 'observability', blocking: true, requirement: 'GAP-11: unknown, needs_reconciliation and run_budget_exhausted handoffs counted and alerted' },
  { id: 'kill-switch', blocking: true, requirement: 'kill switch exercised end to end with the lane worker' },
  { id: 'l3', blocking: true, requirement: 'L3 on the exact R4 and Quote SHAs, no NOT_RUN' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @14 by SHA' },
] as const);
