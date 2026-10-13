import { DEFAULT_ACTION_POLICY, type ActionPolicyConfigurationInput } from '@r4/policy-engine';
import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import { AUTONOMOUS_QUOTE_LIMIT_ENV } from '../capabilities/autonomy-limits.js';
import type { SalesAgentDefinitionVersion } from '../definition.js';
import { AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS } from '../ids.js';
import { SALES_DOMAINS, SALES_PRODUCTION_ACTION_POLICY, SALES_PRODUCTION_PROFILE } from './profile.js';
import { SALES_PRODUCTION_PROFILE_V2_CANDIDATE } from './profile-v2.js';
import { SALES_PRODUCTION_PROFILE_V3 } from './profile-v3.js';
import { QUOTE_CONTRACT_REF, SALES_PRODUCTION_PROFILE_V4 } from './profile-v4.js';

/**
 * Sales production profile, version 5 (R4-J3E, ADR-034). NOT deployed and
 * NOT selected by any production worker in this slice.
 *
 * = sales-production@4 with AUTONOMOUS quote issuance: quote.create@3 (the
 * same Quote V2 port, request, idempotency and reconciliation as @2) is an
 * ALLOW write under its own action policy, gated by a deterministic
 * commercial decision and configured limits instead of a human approval;
 * quote.preview (READ) builds the commercial snapshot; the Sales workspace
 * update is version 2 (the customer's shipping choice and quote request).
 * Everything else is v4 verbatim (Catalog and Shipping REAL read-only,
 * Customer UNAVAILABLE, same channel). @1–@4, their fingerprints and
 * SALES_PRODUCTION_ACTION_POLICY are untouched: quote.create@2 keeps
 * requiring approval wherever it is registered.
 */
export const SALES_PRODUCTION_PROFILE_V5: ProductionProfile = Object.freeze({
  profileId: 'sales-production',
  version: 5,
  description: 'Sales canary on a dedicated WhatsApp number: Catalog and Shipping read-only; Quote V2 autonomous issuance of eligible quotes (quote.create@3) within configured limits; customer unavailable; no delivery of quotes.',
  domains: {
    ...SALES_PRODUCTION_PROFILE_V4.domains,
    [SALES_DOMAINS.quote]: { status: 'REAL', contractRef: QUOTE_CONTRACT_REF, note: 'HTTP binding as v4; issuance without a human for a recomputed, customer-requested commercial snapshot within configured limits (ADR-034); no email, no PDF to the channel' },
  },
  channel: { ...SALES_PRODUCTION_PROFILE_V4.channel },
  capabilities: [
    ...SALES_PRODUCTION_PROFILE_V4.capabilities.map((c) => (c.capabilityId === CAPABILITY_IDS.quoteCreate ? { capabilityId: CAPABILITY_IDS.quoteCreate, domain: SALES_DOMAINS.quote, effect: 'write' as const, decision: 'ALLOW' as const } : c)),
    { capabilityId: AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview, domain: SALES_DOMAINS.quote, effect: 'read' as const },
  ],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

/**
 * The action policy of sales-production@5 (ADR-034). It differs from
 * SALES_PRODUCTION_ACTION_POLICY in exactly one rule: `quote.create` is
 * autonomous (still provisional identity and cited evidence). Every risk class
 * keeps the platform default, so no other write — financial, external
 * communication, privileged, or any future irreversible write — becomes
 * autonomous. The Policy Engine also keeps enforcing each capability's own
 * approvalPolicy: quote.create@2 (approvalPolicy=required) would still need a
 * human under this policy; only quote.create@3 (approvalPolicy=none) runs
 * without one, and only after its commercial decision.
 */
export const SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY: ActionPolicyConfigurationInput = Object.freeze({
  policyId: 'sales-production-autonomous-policy',
  version: 1,
  riskClasses: DEFAULT_ACTION_POLICY.riskClasses,
  capabilities: {
    [CAPABILITY_IDS.workspaceUpdate]: { autonomy: 'allow' },
    [CAPABILITY_IDS.quoteCreate]: { autonomy: 'allow', minimumIdentity: 'provisional', requireEvidence: true },
  },
} satisfies ActionPolicyConfigurationInput);

/** Profiles whose quote issuance is autonomous (they compose quote.preview, quote.create@3 and workspace.update@2). */
export const SALES_AUTONOMOUS_QUOTE_PROFILES: ReadonlySet<string> = new Set(['sales-production@5']);

export function isAutonomousQuoteProfile(profile: ProductionProfile): boolean {
  return SALES_AUTONOMOUS_QUOTE_PROFILES.has(profileLabel(profile));
}

/** The action policy a profile runs: the autonomous one only for @5; every earlier profile keeps SALES_PRODUCTION_ACTION_POLICY (same object, same hash). */
export function salesProductionActionPolicy(profile: ProductionProfile): ActionPolicyConfigurationInput {
  return isAutonomousQuoteProfile(profile) ? SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY : SALES_PRODUCTION_ACTION_POLICY;
}

/** What must be true before v5 is deployed (none of it is done by R4-J3E). */
export const SALES_PRODUCTION_PROFILE_V5_GATE = Object.freeze([
  { id: 'adr-034', blocking: true, requirement: 'ADR-034 accepted by the owner (autonomous issuance supersedes ADR-029 REQUIRE_APPROVAL for quote.create in @5 only)' },
  { id: 'limits-approved', blocking: true, requirement: `production values of ${Object.values(AUTONOMOUS_QUOTE_LIMIT_ENV).join(', ')} decided and approved by the business owner` },
  { id: 'sales-migration', blocking: true, requirement: 'Sales migration 0008_sales_autonomous_quote_decisions applied (sales:migrate) before any worker runs the new code' },
  { id: 'definition-v5-registered', blocking: true, requirement: 'Sales definition v5 registered by production:sales:bootstrap (v3 and v4 unchanged)' },
  { id: 'autonomous-canary', blocking: true, requirement: 'an isolated autonomous canary E2E with the real model, Catalog, Shipping and Quote V2 (no channel, no email) passed' },
  { id: 'intent-attestation', blocking: true, requirement: 'owner decision on the customer-intent evidence: the quote request is recorded by the agent (model-attested) because no platform seam exposes the customer inbound text to the pack (ADR-034 §Limits)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit user authorization to deploy and select sales-production@5' },
] as const);

/** The Sales production profiles a deployment may select with R4_PROD_POLICY_PROFILE. */
export const SALES_PRODUCTION_PROFILES: readonly ProductionProfile[] = Object.freeze([SALES_PRODUCTION_PROFILE, SALES_PRODUCTION_PROFILE_V2_CANDIDATE, SALES_PRODUCTION_PROFILE_V3, SALES_PRODUCTION_PROFILE_V4, SALES_PRODUCTION_PROFILE_V5]);

/** The Sales production profile declared by `label` (`sales-production@1..5`), or null. */
export function salesProductionProfile(label: string): ProductionProfile | null {
  return SALES_PRODUCTION_PROFILES.find((profile) => profileLabel(profile) === label) ?? null;
}

/**
 * The Sales definition version each production profile runs. Production
 * pins it: a conversation task is created for exactly this version, so
 * registering a newer definition never switches an existing profile (the
 * registry otherwise resolves the latest). Kept outside the profile objects
 * so the deployed fingerprints are unchanged.
 */
export const SALES_PRODUCTION_AGENT_VERSIONS: Readonly<Record<string, SalesAgentDefinitionVersion>> = Object.freeze({
  'sales-production@1': 3,
  'sales-production@2': 3,
  'sales-production@3': 4,
  'sales-production@4': 4,
  'sales-production@5': 5,
});

export function salesProductionAgentVersion(profile: ProductionProfile): SalesAgentDefinitionVersion {
  const version = SALES_PRODUCTION_AGENT_VERSIONS[profileLabel(profile)];
  if (version === undefined) throw new Error(`no Sales definition version is pinned for ${profileLabel(profile)}`);
  return version;
}
