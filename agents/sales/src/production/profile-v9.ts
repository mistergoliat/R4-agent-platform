import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import type { SalesAgentDefinitionVersion } from '../definition.js';
import { SALES_PRODUCTION_PROFILE } from './profile.js';
import { SALES_PRODUCTION_PROFILE_V2_CANDIDATE } from './profile-v2.js';
import { SALES_PRODUCTION_PROFILE_V3 } from './profile-v3.js';
import { SALES_PRODUCTION_PROFILE_V4 } from './profile-v4.js';
import { SALES_PRODUCTION_PROFILE_V5 } from './profile-v5.js';
import { SALES_PRODUCTION_PROFILE_V6 } from './profile-v6.js';
import { SALES_PRODUCTION_PROFILE_V7 } from './profile-v7.js';
import { SALES_PRODUCTION_PROFILE_V8 } from './profile-v8.js';

/**
 * Sales production profile, version 9 (R4-J5). NOT deployed and NOT selected by any
 * production worker.
 *
 * = sales-production@8 in every respect (domains, channel, capabilities and their versions,
 * action policy, limits, composition) except the definition it runs: v9 = v8 plus the
 * commercial guidance of the authorized $1 shipping promotion. Eligibility and price stay with
 * the Shipping owner: no R4 code decides them.
 */
export const SALES_PRODUCTION_PROFILE_V9: ProductionProfile = Object.freeze({
  ...SALES_PRODUCTION_PROFILE_V8,
  version: 9,
  description: 'Sales canary: @8 unchanged (Catalog and Shipping read-only, Quote V2 autonomous issuance of the exact Sales-rendered offer, kill switch, Customer Profile reads behind CIA identity resolution, autonomous e-mail verification start; synthetic owners only) running definition v9 (guidance of the $1 shipping promotion, decided by Shipping); no delivery of quotes.',
} satisfies ProductionProfile);

/** What must be true before v9 is deployed (none of it is done by R4-J5). */
export const SALES_PRODUCTION_PROFILE_V9_GATE = Object.freeze([
  { id: 'v8-gate', blocking: true, requirement: 'every blocking item of SALES_PRODUCTION_PROFILE_V8_GATE (v9 composes exactly what v8 composes)' },
  { id: 'j5-review', blocking: true, requirement: 'R4-J5 guidance reviewed and accepted by the owner' },
  { id: 'promotion-terms', blocking: true, requirement: 'the commercial/Shipping owner confirms the promotion terms the guidance states (approved commune list and exact monetary basis: net or gross, before or after discounts)' },
  { id: 'real-model-compatibility', blocking: true, requirement: 'a real-model compatibility check of @9 against @8 (no regression; the $1 offer explained, never promised)' },
  { id: 'canary-evidence', blocking: true, requirement: 'an isolated canary of @9 against the real Shipping owner, synthetic customer, with eligible and ineligible orders' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit user authorization to deploy and select sales-production@9' },
] as const);

/** The Sales production profiles a deployment may select with R4_PROD_POLICY_PROFILE. */
export const SALES_PRODUCTION_PROFILES: readonly ProductionProfile[] = Object.freeze([
  SALES_PRODUCTION_PROFILE,
  SALES_PRODUCTION_PROFILE_V2_CANDIDATE,
  SALES_PRODUCTION_PROFILE_V3,
  SALES_PRODUCTION_PROFILE_V4,
  SALES_PRODUCTION_PROFILE_V5,
  SALES_PRODUCTION_PROFILE_V6,
  SALES_PRODUCTION_PROFILE_V7,
  SALES_PRODUCTION_PROFILE_V8,
  SALES_PRODUCTION_PROFILE_V9,
]);

/** The Sales production profile declared by `label` (`sales-production@1..9`), or null. */
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
  'sales-production@6': 6,
  'sales-production@7': 7,
  'sales-production@8': 8,
  'sales-production@9': 9,
});

export function salesProductionAgentVersion(profile: ProductionProfile): SalesAgentDefinitionVersion {
  const version = SALES_PRODUCTION_AGENT_VERSIONS[profileLabel(profile)];
  if (version === undefined) throw new Error(`no Sales definition version is pinned for ${profileLabel(profile)}`);
  return version;
}
