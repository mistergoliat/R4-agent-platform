import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import { DISCOVER_CONTRACT_PIN } from '@r4-adapters/catalog-http';
import { LANE_CAPABILITY_IDS } from '../ids.js';
import { SALES_DOMAINS } from './profile.js';
import { SALES_PRODUCTION_PROFILE_V3 } from './profile-v3.js';

/**
 * Sales production profile, version 13 (R4 integrated E2E, ADR-045). The E1 LANE profile: served by the existing
 * production gateway and number, but only for the conversations named in its lane (R4_PROD_LANE_ALLOWLIST, each also
 * allowlisted in the rollout), by its own worker (servedAgents = definition v13).
 *
 * = sales-production@3 (Shipping REAL read-only, workspace INTERNAL, Customer and Quote UNAVAILABLE, same channel,
 * same writes and approvals) with Catalog bound to Catalog V2 — required, by the profile, never by configuration —
 * plus `catalog.discover` (Catalog V2 Discover, read-only), running definition v13 (v4 + the Discover guidance).
 * No Quote, Checkout, cart, payment or customer identity is reachable: E2 and E3 are other profiles.
 */
export const CATALOG_V2_CONTRACT_REF = 'catalog-service V2: /v2/catalog read contract schemaVersion 1 (same as v1; CAT_V2_R4_J45_HANDOFF), source v2 (R4_CATALOG_V2_*)';
export const CATALOG_DISCOVER_CONTRACT_REF = `catalog-service V2: POST /v2/catalog/discover ${DISCOVER_CONTRACT_PIN.contractVersion} (${DISCOVER_CONTRACT_PIN.status}, owner commit ${DISCOVER_CONTRACT_PIN.ownerCommit.slice(0, 7)})`;

export const SALES_PRODUCTION_PROFILE_V13: ProductionProfile = Object.freeze({
  profileId: 'sales-production',
  version: 13,
  description: 'Sales E1 lane on the production number, allowlisted conversations only: Catalog V2 read-only including Discover; Shipping read-only; workspace internal; Customer, Quote, Checkout and payments unavailable.',
  domains: {
    ...SALES_PRODUCTION_PROFILE_V3.domains,
    [SALES_DOMAINS.catalog]: { status: 'REAL', contractRef: `${CATALOG_V2_CONTRACT_REF}; ${CATALOG_DISCOVER_CONTRACT_REF}`, note: 'read-only HTTP binding to Catalog V2 only (no V1 fallback); Discover with its own key; owner freshness bounds evidence (ADR-030)' },
  },
  channel: { ...SALES_PRODUCTION_PROFILE_V3.channel },
  capabilities: [...SALES_PRODUCTION_PROFILE_V3.capabilities, { capabilityId: LANE_CAPABILITY_IDS.catalogDiscover, domain: SALES_DOMAINS.catalog, effect: 'read' }],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

export const SALES_LANE_PROFILE_LABEL = 'sales-production@13';

/** Profiles a gateway may serve as its lane and a production worker may select; never a gateway's main profile. */
export const SALES_LANE_PROFILES: readonly ProductionProfile[] = Object.freeze([SALES_PRODUCTION_PROFILE_V13]);

export function isSalesLaneProfile(profile: ProductionProfile): boolean {
  return SALES_LANE_PROFILES.some((p) => profileLabel(p) === profileLabel(profile));
}

/** The Catalog source a profile binds: V2 only for the lane profile (decided by the profile, never by a variable). */
export function salesCatalogSourceOf(profile: ProductionProfile): 'v1' | 'v2' {
  return isSalesLaneProfile(profile) ? 'v2' : 'v1';
}

/** What must be true before @13 serves its first real conversation. */
export const SALES_PRODUCTION_PROFILE_V13_GATE = Object.freeze([
  { id: 'discover-contract', blocking: true, requirement: 'Catalog Discover technical contract published (Catalog #56) and equal to the pin, or the owner explicitly accepts the pinned draft for E1' },
  { id: 'focused-review', blocking: true, requirement: 'ADR-045 lane change reviewed (focused review) and merged; SHA fixed for the deploy' },
  { id: 'registry-free', blocking: true, requirement: 'identifiers v13 and @13 verified free in the production registry, then registered with production:sales:bootstrap --lane' },
  { id: 'catalog-v2-env', blocking: true, requirement: 'lane worker env: R4_CATALOG_V2_* and R4_CATALOG_V2_DISCOVER_API_KEY; production worker env unchanged' },
  { id: 'rollback-rehearsed', blocking: true, requirement: 'activation and rollback rehearsed on a disposable database with the deploy SHA' },
  { id: 'owner-binding', blocking: true, requirement: 'the owner conversation has no open @3 task at activation (cancel it with tasks cancel): an open binding keeps its task, so the lane applies only from the next binding' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to activate the lane for the owner conversation' },
] as const);
