import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import type { ActionPolicyConfigurationInput } from '@r4/policy-engine';
import { CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID } from '../capabilities/customer-v2.js';
import { IDENTITY_VERIFICATION_CAPABILITY_IDS } from '../capabilities/identity-verification.js';
import { CAPABILITY_IDS } from '../ids.js';
import { SALES_DOMAINS } from './profile.js';
import { SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY, salesProductionActionPolicy } from './profile-v5.js';
import { SALES_PRODUCTION_PROFILE_V7 } from './profile-v7.js';

export const CUSTOMER_PROFILE_CONTRACT_REF = 'customer-profile:docs/contracts/customer-sales-context-v1-rc2 (sales-context v1-rc2, candidate; owner commit bbd766e; pinned R4-J4-R3)';
export const CUSTOMER_IDENTITY_CONTRACT_REF = 'customer-identity-authority:contract/cia/v1-d2 (v1-d2-candidate, accepted for synthetic interoperability only; owner commit 7525395)';

/**
 * Sales production profile, version 8 (R4-J4-R4). NOT deployed and NOT selected by any
 * production worker.
 *
 * = sales-production@7 plus the Customer reads and the channel identity verification:
 *   customer.get_context@3, customer.get_purchase_history@2   (RR-1 revalidation, SEC-S6)
 *   identity.verification_status@1                           (read)
 *   identity.start_verification@1                            (write, autonomous: OA-05)
 * Catalog, Shipping, Quote, the channel and every @7 rule are unchanged. @1–@7 are untouched.
 *
 * Both new domains are REAL because a REAL domain is the only one whose reads are offered
 * (capabilityAvailability). REAL names the owners' services and contracts, not their data: the
 * adapters accept only R4_CUSTOMER_MODE=synthetic, `synthetic-` credentials and loopback URLs,
 * and refuse `real` (real customer data is J7).
 */
export const SALES_PRODUCTION_PROFILE_V8: ProductionProfile = Object.freeze({
  profileId: 'sales-production',
  version: 8,
  description: 'Sales canary: @7 (Catalog and Shipping read-only, Quote V2 autonomous issuance of the exact Sales-rendered offer, kill switch) plus Customer Profile reads behind CIA identity resolution and the autonomous e-mail verification start; synthetic owners only; no delivery of quotes.',
  domains: {
    ...SALES_PRODUCTION_PROFILE_V7.domains,
    [SALES_DOMAINS.customer]: { status: 'REAL', contractRef: CUSTOMER_PROFILE_CONTRACT_REF, note: 'HTTP binding, read-only, after CIA resolve and grant; R4_CUSTOMER_MODE=synthetic only (real refused by the adapter); optional for the sale: a failure never blocks Catalog, Shipping or a guest quote' },
    [SALES_DOMAINS.identity]: { status: 'REAL', contractRef: CUSTOMER_IDENTITY_CONTRACT_REF, note: 'CIA resolve and verification start with the agent credential (synthetic only); confirm runs in the gateway only, behind the inbound inspector in full mode (ADR-040)' },
  },
  channel: { ...SALES_PRODUCTION_PROFILE_V7.channel },
  capabilities: [
    ...SALES_PRODUCTION_PROFILE_V7.capabilities,
    { capabilityId: CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID, domain: SALES_DOMAINS.customer, effect: 'read' as const },
    { capabilityId: IDENTITY_VERIFICATION_CAPABILITY_IDS.status, domain: SALES_DOMAINS.identity, effect: 'read' as const },
    { capabilityId: IDENTITY_VERIFICATION_CAPABILITY_IDS.start, domain: SALES_DOMAINS.identity, effect: 'write' as const, decision: 'ALLOW' as const },
  ],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

/** The exact capability versions @8 composes; the profile itself carries no versions, so this map is pinned by contract tests. */
export const SALES_PRODUCTION_V8_CAPABILITY_VERSIONS = Object.freeze({
  [CAPABILITY_IDS.customerContext]: 3,
  [CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID]: 2,
  [IDENTITY_VERIFICATION_CAPABILITY_IDS.start]: 1,
  [IDENTITY_VERIFICATION_CAPABILITY_IDS.status]: 1,
} as const);

/**
 * The @8 action policy: the @7 autonomous policy plus the approved OA-05 rule, and nothing else.
 * Only identity.start_verification is allowed autonomously; every other EXTERNAL_COMMUNICATION
 * still requires approval, and the @7 rules are copied unchanged.
 */
export const SALES_PRODUCTION_V8_ACTION_POLICY: ActionPolicyConfigurationInput = Object.freeze({
  policyId: 'sales-production-autonomous-policy',
  version: 2,
  riskClasses: SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY.riskClasses,
  capabilities: {
    ...SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY.capabilities,
    [IDENTITY_VERIFICATION_CAPABILITY_IDS.start]: { autonomy: 'allow' },
  },
} satisfies ActionPolicyConfigurationInput);

/** Profiles that compose Customer and identity verification (J4-R4). */
export const SALES_CUSTOMER_IDENTITY_PROFILES: ReadonlySet<string> = new Set(['sales-production@8', 'sales-production@9']);

export function isCustomerIdentityProfile(profile: ProductionProfile): boolean {
  return SALES_CUSTOMER_IDENTITY_PROFILES.has(profileLabel(profile));
}

/** The action policy a profile runs: @8 its own; every earlier profile exactly what it ran before. */
export function salesActionPolicyFor(profile: ProductionProfile): ActionPolicyConfigurationInput {
  return isCustomerIdentityProfile(profile) ? SALES_PRODUCTION_V8_ACTION_POLICY : salesProductionActionPolicy(profile);
}

/** What must be true before v8 is deployed (none of it is done by R4-J4-R4). */
export const SALES_PRODUCTION_PROFILE_V8_GATE = Object.freeze([
  { id: 'v7-gate', blocking: true, requirement: 'every blocking item of SALES_PRODUCTION_PROFILE_V7_GATE (v8 keeps the whole @7 offer and issuance)' },
  { id: 'j4-r4-review', blocking: true, requirement: 'R4-J4-R4 implementation reviewed and accepted by the owner' },
  { id: 'identity-migrations', blocking: true, requirement: 'identity-verification migrations 0011–0014 applied before any worker or gateway runs @8 (the worker refuses to start otherwise)' },
  { id: 'gateway-inspector-full', blocking: true, requirement: 'every channel gateway composes the inbound inspector in full (ADR-040); a gateway without it refuses to start while the component mode is full; mixed replicas excluded by the deployment procedure (R3-04)' },
  { id: 'binding-immutability', blocking: true, requirement: 'RR-1 R-4: binding immutability enforced before J4-R5 (owner decision, 2026-10-22)' },
  { id: 'deployed-synthetic-owners', blocking: true, requirement: 'CIA and Customer Profile deployed as test services in synthetic mode, with CP enforce, the r4-sales principal and network containment (J4-R5)' },
  { id: 'canary-evidence-policy', blocking: true, requirement: 'the J4 canary worker runs R4_CONTEXT_EXPIRED_EVIDENCE=exclude, synthetic data only, isolated, with a verified purge (owner decision; production values unchanged)' },
  { id: 'real-data', blocking: true, requirement: 'real customer data is J7: G-16, AP-*, RR-1 R-1..R-3, RS-01..04, BA-01..06, OA-10, CP L-1 and the CIA DEP-* gates' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit user authorization to deploy and select sales-production@8' },
] as const);

// The selectable profile registry (v1–v9) and the pinned definition versions live in profile-v9.ts (R4-J5).
