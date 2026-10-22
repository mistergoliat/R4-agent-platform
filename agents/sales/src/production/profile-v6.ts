import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import { AUTONOMOUS_QUOTE_LIMIT_ENV_V6 } from '../capabilities/autonomy-limits.js';
import { SALES_DOMAINS } from './profile.js';
import { QUOTE_CONTRACT_REF } from './profile-v4.js';
import { SALES_PRODUCTION_PROFILE_V5 } from './profile-v5.js';

/**
 * Sales production profile, version 6 (R4-J3E-B, ADR-035). NOT deployed and
 * NOT selected by any production worker.
 *
 * = sales-production@5 with INDEPENDENT evidence of the customer's confirmation —
 * quote.create@4 issues only when the customer's own latest message, as the
 * platform recorded it (ProductionStore.thread), explicitly confirms the offer
 * message that presented the current snapshot; quote.preview@2 adds the
 * Sales-derived offer reference; limits add total units and the confirmation
 * window. Same domains, channel, capability list and autonomous action policy
 * as @5. @1–@5 are untouched.
 */
export const SALES_PRODUCTION_PROFILE_V6: ProductionProfile = Object.freeze({
  profileId: 'sales-production',
  version: 6,
  description: 'Sales canary on a dedicated WhatsApp number: Catalog and Shipping read-only; Quote V2 autonomous issuance (quote.create@4) only after the customer explicitly confirms the presented offer in the conversation, within configured limits; customer unavailable; no delivery of quotes.',
  domains: {
    ...SALES_PRODUCTION_PROFILE_V5.domains,
    [SALES_DOMAINS.quote]: { status: 'REAL', contractRef: QUOTE_CONTRACT_REF, note: 'HTTP binding as v4; issuance without a human once the customer confirmed the presented snapshot in the conversation, within configured limits (ADR-035); no email, no PDF to the channel' },
  },
  channel: { ...SALES_PRODUCTION_PROFILE_V5.channel },
  capabilities: [...SALES_PRODUCTION_PROFILE_V5.capabilities],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

/**
 * Profiles that issue only on a customer confirmation read from the conversation and need the v6 limits:
 * @6 (quote.create@4, quote.preview@2) and @7 (R4-J3E-C1: quote.create@5, quote.preview@3, the exact offer).
 */
export const SALES_CONFIRMED_INTENT_PROFILES: ReadonlySet<string> = new Set(['sales-production@6', 'sales-production@7', 'sales-production@8']);

export function isConfirmedIntentProfile(profile: ProductionProfile): boolean {
  return SALES_CONFIRMED_INTENT_PROFILES.has(profileLabel(profile));
}

/** What must be true before v6 is deployed (none of it is done by R4-J3E-B). */
export const SALES_PRODUCTION_PROFILE_V6_GATE = Object.freeze([
  { id: 'adr-035', blocking: true, requirement: 'ADR-035 accepted by the owner (customer intent read from the conversation through ProductionStore.thread)' },
  { id: 'limits-approved', blocking: true, requirement: `production values of ${Object.values(AUTONOMOUS_QUOTE_LIMIT_ENV_V6).join(', ')} decided and approved by the business owner` },
  { id: 'sales-migrations', blocking: true, requirement: 'Sales migrations 0008 and 0009 applied (sales:migrate) before any worker runs the new code' },
  { id: 'definition-v6-registered', blocking: true, requirement: 'Sales definition v6 registered by production:sales:bootstrap (v3–v5 unchanged)' },
  { id: 'single-input-producer', blocking: true, requirement: 'only the channel ingress submits inputs to channel-bound Sales tasks: no platform API with the input route runs against the production database (ProductionStore.thread does not expose the input actor; ADR-035 §Provenance)' },
  { id: 'confirmed-intent-canary', blocking: true, requirement: 'an isolated canary E2E of @6 with the real model, Catalog, Shipping and Quote V2 (no channel, no email) passed' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit user authorization to deploy and select sales-production@6' },
] as const);

// The selectable profile registry (v1–v8) and the pinned definition versions live in profile-v8.ts (R4-J4-R4).
