import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import { AUTONOMOUS_QUOTE_LIMIT_ENV_V6 } from '../capabilities/autonomy-limits.js';
import { SALES_DOMAINS } from './profile.js';
import { QUOTE_CONTRACT_REF } from './profile-v4.js';
import { SALES_PRODUCTION_PROFILE_V6 } from './profile-v6.js';

/**
 * Sales production profile, version 7 (R4-J3E-C1). NOT deployed and NOT
 * selected by any production worker.
 *
 * = sales-production@6 with the WHOLE offer deterministic: quote.preview@3
 * returns the offer message Sales renders from the snapshot (template
 * r4-sales-offer-es-v1), and quote.create@5 issues only when the message the
 * customer confirmed is byte-identical to that rendering of the snapshot
 * recomputed at issuance; the owner's answer is settled strictly; Quote V2
 * writes stop with the kill switch (checked at the call). Same domains,
 * channel, capability list, autonomous action policy and limits as @6.
 * @1–@6 are untouched.
 */
export const SALES_PRODUCTION_PROFILE_V7: ProductionProfile = Object.freeze({
  profileId: 'sales-production',
  version: 7,
  description: 'Sales canary on a dedicated WhatsApp number: Catalog and Shipping read-only; Quote V2 autonomous issuance (quote.create@5) only after the customer explicitly confirms the exact offer message Sales rendered, within configured limits; Quote V2 writes stop with the kill switch; customer unavailable; no delivery of quotes.',
  domains: {
    ...SALES_PRODUCTION_PROFILE_V6.domains,
    [SALES_DOMAINS.quote]: { status: 'REAL', contractRef: QUOTE_CONTRACT_REF, note: 'HTTP binding as v4; issuance without a human once the customer confirmed the exact Sales-rendered offer in the conversation, within configured limits; createAndIssue refused while the kill switch is engaged; no email, no PDF to the channel' },
  },
  channel: { ...SALES_PRODUCTION_PROFILE_V6.channel },
  capabilities: [...SALES_PRODUCTION_PROFILE_V6.capabilities],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

/** Profiles whose offer message is rendered by Sales and must be presented exactly (quote.preview@3, quote.create@5). */
export const SALES_DETERMINISTIC_OFFER_PROFILES: ReadonlySet<string> = new Set(['sales-production@7', 'sales-production@8', 'sales-production@9']);

export function isDeterministicOfferProfile(profile: ProductionProfile): boolean {
  return SALES_DETERMINISTIC_OFFER_PROFILES.has(profileLabel(profile));
}

/** What must be true before v7 is deployed (none of it is done by R4-J3E-C1). */
export const SALES_PRODUCTION_PROFILE_V7_GATE = Object.freeze([
  { id: 'deterministic-offer-review', blocking: true, requirement: 'R4-J3E-C1 implementation reviewed and accepted by the owner (Sales-rendered offer r4-sales-offer-es-v1, exact match, strict settlement, kill-switch write guard)' },
  { id: 'limits-approved', blocking: true, requirement: `production values of ${Object.values(AUTONOMOUS_QUOTE_LIMIT_ENV_V6).join(', ')} decided and approved by the business owner` },
  { id: 'sales-migrations', blocking: true, requirement: 'Sales migrations 0008 and 0009 applied (sales:migrate) before any worker runs the new code; v7 adds none' },
  { id: 'definition-v7-registered', blocking: true, requirement: 'Sales definition v7 registered by production:sales:bootstrap (v3–v6 unchanged)' },
  { id: 'input-provenance', blocking: true, requirement: 'contractual provenance of customer inputs (proposed ADR-036), or the single-input-producer topology accepted by the owner and verified on the host (no platform API with the input route against the production database)' },
  { id: 'copy-fidelity', blocking: true, requirement: 'model copy fidelity of the offer message measured and accepted by the owner (an exploratory figure is not a rollout approval)' },
  { id: 'rollback-runbook', blocking: true, requirement: 'rollback drain rehearsed: no quote.create execution left without its registered capability after returning to an earlier profile' },
  { id: 'deterministic-offer-canary', blocking: true, requirement: 'an isolated canary E2E of @7 with the real model, Catalog, Shipping and Quote V2 (no channel, no email) passed' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit user authorization to deploy and select sales-production@7' },
] as const);

// The selectable profile registry (v1–v9) and the pinned definition versions live in profile-v9.ts (R4-J5).
