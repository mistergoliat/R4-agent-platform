import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import type { AutonomousQuoteLimitsV6 } from '../capabilities/autonomy-limits.js';
import { SALES_PRODUCTION_PROFILE_V7 } from './profile-v7.js';

/**
 * Sales production profile, version 12 (R4-J5 F1, owner decision 2026-11-05). The F1 quote CANARY profile. NOT
 * deployed; NOT selectable by a production worker (absent from SALES_PRODUCTION_PROFILES): only the isolated canary
 * runtime composes it.
 *
 * = sales-production@7 (Catalog and Shipping REAL, Quote V2 autonomous issuance of the Sales-rendered offer the
 * customer confirmed, kill switch), running definition v12 — functionally derived from v7 as an explicit owner
 * exception to cumulative versioning: plus the evaluated shipping promotion clause and the extended DS-1 prevention;
 * without Customer Profile, CIA, Checkout, cart or the unadjudicated G-sem block. Its composition additionally
 * REQUIRES the P-1 parity guard and refuses autonomous limits looser than the owner-approved canary values.
 */
export const SALES_PRODUCTION_PROFILE_V12: ProductionProfile = Object.freeze({
  profileId: 'sales-production',
  version: 12,
  description: 'Sales F1 quote canary (isolated): Catalog and Shipping read-only; Quote V2 autonomous issuance (quote.create@5) of the Sales-rendered offer the customer explicitly confirmed, only for parity-verified SKUs, within the owner-approved canary limits; Quote V2 writes stop with the kill switch; customer unavailable; no delivery of quotes.',
  domains: { ...SALES_PRODUCTION_PROFILE_V7.domains },
  channel: { ...SALES_PRODUCTION_PROFILE_V7.channel },
  capabilities: [...SALES_PRODUCTION_PROFILE_V7.capabilities],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

export const SALES_F1_CANARY_PROFILE_LABEL = 'sales-production@12';

/** Profiles only the isolated canary runtime composes: never in SALES_PRODUCTION_PROFILES, never selectable by a production worker. */
export const SALES_CANARY_ONLY_PROFILES: readonly ProductionProfile[] = Object.freeze([SALES_PRODUCTION_PROFILE_V12]);

export function isF1CanaryProfile(profile: ProductionProfile): boolean {
  return profileLabel(profile) === SALES_F1_CANARY_PROFILE_LABEL;
}

/**
 * The owner-approved limits of the FIRST authorized F1 canary (decision C, 2026-11-05; the J3E owner values). They
 * are ceilings for that canary only — never production defaults: the configuration may be stricter, never looser.
 */
export const SALES_F1_CANARY_LIMITS: Readonly<AutonomousQuoteLimitsV6> = Object.freeze({
  maxGrossClp: 250_000,
  maxLines: 3,
  maxUnitsPerLine: 5,
  maxTotalUnits: 5,
  maxQuotesPerConversation: 1,
  maxQuotesPerHour: 2,
  confirmationWindowSeconds: 900,
});

/** The owner-approved write ceiling per task for the first F1 canary (D7-5; J3E ran @5 with 6). */
export const SALES_F1_CANARY_MAX_WRITE_ACTIONS = 6;

/** Throws when a configured autonomous limit is looser than the approved canary ceiling. */
export function assertF1CanaryLimits(limits: AutonomousQuoteLimitsV6, label: string = SALES_F1_CANARY_PROFILE_LABEL): void {
  const looser = (Object.keys(SALES_F1_CANARY_LIMITS) as (keyof AutonomousQuoteLimitsV6)[]).filter((k) => limits[k] > SALES_F1_CANARY_LIMITS[k]);
  if (looser.length > 0) {
    throw new Error(`refusing production composition: ${label} runs within the owner-approved canary limits; looser: ${looser.map((k) => `${k}=${limits[k]} > ${SALES_F1_CANARY_LIMITS[k]}`).join(', ')}`);
  }
}

/** Throws when the worker's write ceiling is outside 1..the approved canary ceiling (0 cannot issue a quote). */
export function assertF1CanaryWriteCeiling(maxWriteActions: number, label: string = SALES_F1_CANARY_PROFILE_LABEL): void {
  if (!Number.isSafeInteger(maxWriteActions) || maxWriteActions < 1 || maxWriteActions > SALES_F1_CANARY_MAX_WRITE_ACTIONS) {
    throw new Error(`refusing the worker: ${label} runs with maxWriteActions between 1 and ${SALES_F1_CANARY_MAX_WRITE_ACTIONS} (configured ${maxWriteActions})`);
  }
}

/** What must be true before the F1 canary runs on a real channel (none of it is done by this increment). */
export const SALES_PRODUCTION_PROFILE_V12_GATE = Object.freeze([
  { id: 'parity-evidence', blocking: true, requirement: 'parity evidence of every scenario SKU verified against live PrestaShop by the Catalog owner, current (R4_QUOTE_PARITY_*), and re-checked before each real issuance (P-1)' },
  { id: 'quote-r17', blocking: true, requirement: 'Quote R1.7 gate met (backup/restore, host restart, disk, 7 days stable) on the chosen Quote SHA' },
  { id: 'a10-lockstep', blocking: true, requirement: 'Quote A10 and R4 #32 deployed in lockstep, post-deploy A10 check passed' },
  { id: 'validity-60', blocking: true, requirement: 'the 60-minute session validity profile verified and authorized for the R4 principal by the Quote owner' },
  { id: 'ds1-evaluated', blocking: true, requirement: 'DS-1 prevention of definition v12 evaluated with the real model and accepted by the owner (not on the absence of handoffs alone)' },
  { id: 'definition-v12-registered', blocking: true, requirement: 'identifiers v12 and @12 verified free in the production registry (D5), then definition v12 registered' },
  { id: 'observability', blocking: true, requirement: 'GAP-11: unknown, needs_reconciliation and run_budget_exhausted handoffs counted and alerted' },
  { id: 'input-provenance', blocking: true, requirement: 'ADR-036, or the single-input-producer topology accepted by the owner and verified on the host' },
  { id: 'kill-switch', blocking: true, requirement: 'kill switch exercised end to end on the canary host' },
  { id: 'l3', blocking: true, requirement: 'L3 on the exact R4 and Quote SHAs, no NOT_RUN' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to deploy and run the F1 canary by SHA' },
] as const);
