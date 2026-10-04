import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import { SHIPPING_FRESHNESS_TTL_MS } from '../capabilities/shipping.js';
import type { SalesAgentDefinitionVersion } from '../definition.js';
import { CAPABILITY_IDS } from '../ids.js';
import { SALES_DOMAINS, SALES_PRODUCTION_PROFILE } from './profile.js';
import { SALES_PRODUCTION_PROFILE_V2_CANDIDATE } from './profile-v2.js';

/**
 * Sales production profile, version 3 (R4-J2D).
 *
 * = sales-production@2 + Shipping REAL (read-only, pc-carrier) + Sales
 * definition v4. Everything else is v2 verbatim: Catalog REAL,
 * Customer/Quote UNAVAILABLE, same channel, same capability list (shipping.quote
 * was always declared as a READ; it becomes available because its domain is
 * now REAL), same writes and approvals.
 *
 * A deployment composes it only by selecting it explicitly
 * (R4_PROD_POLICY_PROFILE=sales-production@3) and providing both the Catalog
 * binding (R4_CATALOG_*) and the Shipping binding (R4_SHIPPING_*); v1 and v2
 * stay selectable and their fingerprints are untouched.
 */
export const SHIPPING_CONTRACT_REF = 'pc-carrier:PC Carrier API 1.2.0 (GET /location, GET /carrier/v1/all; audited R4-J2A, ADR-032)';

export const SALES_PRODUCTION_PROFILE_V3: ProductionProfile = Object.freeze({
  profileId: 'sales-production',
  version: 3,
  description: 'Sales canary on a dedicated WhatsApp number: Catalog read-only from catalog-service v2; Shipping read-only from pc-carrier; other owners unavailable; quotes require approval.',
  domains: {
    ...SALES_PRODUCTION_PROFILE_V2_CANDIDATE.domains,
    [SALES_DOMAINS.shipping]: { status: 'REAL', contractRef: SHIPPING_CONTRACT_REF, note: 'read-only HTTP binding (commune catalog, quote); owner NET kept, customer gross derived by R4 (ADR-032); no owner validity' },
  },
  channel: { ...SALES_PRODUCTION_PROFILE_V2_CANDIDATE.channel },
  capabilities: [...SALES_PRODUCTION_PROFILE_V2_CANDIDATE.capabilities],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

/** How the v3 Shipping domain is bound. */
export const SALES_PRODUCTION_V3_SHIPPING_BINDING = Object.freeze({
  domain: SALES_DOMAINS.shipping,
  binding: 'http',
  adapter: '@r4-adapters/shipping-http (ProductionShippingAdapter over PcCarrierClient)',
  contractRef: SHIPPING_CONTRACT_REF,
  endpoints: ['GET /location', 'GET /carrier/v1/all'],
  authority: {
    effect: 'read',
    modelCapabilities: [CAPABILITY_IDS.shippingQuote],
    internalOperations: ['getLocations (commune resolution)', 'quoteAll'],
    writes: 'none — the client exposes only getLocations and quoteAll; no owner emission, SAP or shipping-method route is reachable',
    policy: 'READ capability executed through the CapabilityInvoker only; no governed action involves Shipping',
  },
  authentication: 'none (the owner quote endpoints require no credential)',
  requiredEnv: {
    R4_SHIPPING_MODE: 'must be "real"',
    R4_SHIPPING_BASE_URL: 'pc-carrier base URL (production: https://ms.pesaschile.cl/api/pc-carrier); non-loopback requires https and R4_PROD_ALLOW_NETWORK=true; no credentials/query/fragment',
    R4_SHIPPING_TIMEOUT_MS: 'per-owner-call deadline, 100..10000 ms (recommended 5000); a quote makes two owner calls (plus Catalog reads for basis=order) inside the 10 s capability timeout',
  },
  timeouts: { adapterDeadlineMs: 'R4_SHIPPING_TIMEOUT_MS (recommended 5000)', capabilityTimeoutMs: 10_000 },
  freshness: {
    owner: 'none: pc-carrier publishes no quote id, TTL or validity (ownerValidUntil = null)',
    r4UpperBoundMs: SHIPPING_FRESHNESS_TTL_MS,
    recorded: 'Observation.validUntil = observedAt + 15 min (R4 runtime bound only, ADR-030); never a checkout commitment',
  },
  failureSemantics: 'unresolved commune / invalid weight or declared value → validation before any call; 400→validation; 401/403→unauthorized; 429/5xx/network→temporarily_unavailable; deadline→timeout; other status/unparseable/invalid→contract_violation; resolved commune with no options → serviceable=false',
});

/** What must be true before v3 is deployed. */
export const SALES_PRODUCTION_PROFILE_V3_GATE = Object.freeze([
  { id: 'owner-audit', blocking: true, requirement: 'pc-carrier audited read-only (R4-J2A) and owner semantics confirmed (NET, $1 incentive, total_boleta, reference basis)' },
  { id: 'adapter-merged', blocking: true, requirement: 'J2B/J2C adapter and shipping.quote merged (PR #4)' },
  { id: 'definition-v4-registered', blocking: true, requirement: 'Sales definition v4 registered by production:sales:bootstrap (v3 stays registered and unchanged)' },
  { id: 'shipping-env', blocking: true, requirement: 'R4_SHIPPING_MODE=real, R4_SHIPPING_BASE_URL, R4_SHIPPING_TIMEOUT_MS set on the worker; the gateway and worker both select sales-production@3' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit user authorization to deploy sales-production@3' },
] as const);

/** The Sales production profiles a deployment may select with R4_PROD_POLICY_PROFILE. */
export const SALES_PRODUCTION_PROFILES: readonly ProductionProfile[] = Object.freeze([SALES_PRODUCTION_PROFILE, SALES_PRODUCTION_PROFILE_V2_CANDIDATE, SALES_PRODUCTION_PROFILE_V3]);

/** The Sales production profile declared by `label` (`sales-production@1|2|3`), or null. */
export function salesProductionProfile(label: string): ProductionProfile | null {
  return SALES_PRODUCTION_PROFILES.find((profile) => profileLabel(profile) === label) ?? null;
}

/**
 * The Sales definition version each production profile runs. Production
 * pins it: a conversation task is created for exactly this version, so
 * registering a newer definition never switches an existing profile (the
 * registry otherwise resolves the latest). Kept outside the profile objects
 * so the deployed v1/v2 fingerprints are unchanged.
 */
export const SALES_PRODUCTION_AGENT_VERSIONS: Readonly<Record<string, SalesAgentDefinitionVersion>> = Object.freeze({
  'sales-production@1': 3,
  'sales-production@2': 3,
  'sales-production@3': 4,
});

export function salesProductionAgentVersion(profile: ProductionProfile): SalesAgentDefinitionVersion {
  const version = SALES_PRODUCTION_AGENT_VERSIONS[profileLabel(profile)];
  if (version === undefined) throw new Error(`no Sales definition version is pinned for ${profileLabel(profile)}`);
  return version;
}
