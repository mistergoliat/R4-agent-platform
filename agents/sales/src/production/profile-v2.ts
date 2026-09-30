import type { ProductionProfile } from '@r4/live-ops';
import { WHATSAPP_CHANNEL_ID, WHATSAPP_CLOUD_CONTRACT_REF } from '@r4-adapters/whatsapp-cloud';
import { CATALOG_FRESHNESS_TTL_MS } from '../capabilities/catalog.js';
import { CAPABILITY_IDS } from '../ids.js';
import { SALES_DOMAINS, SALES_PRODUCTION_PROFILE } from './profile.js';

/**
 * Sales production profile, version 2 — CANDIDATE, NOT ENABLED (R4-J1C).
 *
 * The only change from v1: Catalog becomes a REAL, read-only owner bound over
 * HTTP to catalog-service's converged v2 contract. Everything else is v1
 * verbatim (Customer/Shipping/Quote UNAVAILABLE, same channel, same writes).
 *
 * Nothing composes this profile: `composeSalesProductionWorker`, the
 * bootstrap and the control CLI accept only SALES_PRODUCTION_PROFILE (v1),
 * whose fingerprint is part of the deployed execution contract and is left
 * untouched. Enabling v2 is a later, explicitly authorized step that must
 * first clear every blocker in SALES_PRODUCTION_PROFILE_V2_GATE.
 */
export const CATALOG_CONTRACT_REF = 'catalog-service:contracts/catalog/v2 (catalog-commercial-v2, schemaVersion 1; converged R4-J1C)';

export const SALES_PRODUCTION_PROFILE_V2_CANDIDATE: ProductionProfile = Object.freeze({
  profileId: 'sales-production',
  version: 2,
  description: 'Sales canary on a dedicated WhatsApp number: Catalog read-only from catalog-service v2; other owners unavailable; quotes require approval.',
  domains: {
    ...SALES_PRODUCTION_PROFILE.domains,
    [SALES_DOMAINS.catalog]: { status: 'REAL', contractRef: CATALOG_CONTRACT_REF, note: 'read-only HTTP binding (search, product context, item context); owner freshness bounds evidence (ADR-030)' },
  },
  channel: { id: WHATSAPP_CHANNEL_ID, status: 'REAL', contractRef: WHATSAPP_CLOUD_CONTRACT_REF },
  capabilities: [...SALES_PRODUCTION_PROFILE.capabilities],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

/**
 * How the v2 Catalog domain is bound. Declarative: composing it is not
 * implemented until enablement is authorized.
 */
export const SALES_PRODUCTION_V2_CATALOG_BINDING = Object.freeze({
  domain: SALES_DOMAINS.catalog,
  binding: 'http',
  adapter: '@r4-adapters/catalog-http (HttpCatalogAdapter)',
  contractRef: CATALOG_CONTRACT_REF,
  endpoints: ['POST /v2/catalog/search', 'GET /v2/catalog/products/{productKey}/context', 'GET /v2/catalog/items/{itemKey}/context?quantity=1..99'],
  authority: {
    effect: 'read',
    /** Catalog capabilities offered to the model; the item context stays a domain primitive (workspace key verification). */
    modelCapabilities: [CAPABILITY_IDS.catalogSearch, CAPABILITY_IDS.productContext],
    internalOperations: ['getItemContext (sales.workspace.update verifies new item keys)'],
    writes: 'none — the port has no write operation',
    policy: 'READ capabilities execute through the CapabilityInvoker only; no governed action involves Catalog',
  },
  requiredEnv: {
    R4_CATALOG_BASE_URL: 'catalog-service base URL; non-loopback requires https and R4_PROD_ALLOW_NETWORK=true; no credentials/query/fragment',
    R4_CATALOG_API_KEY: 'API key dedicated to R4 (>= 16 chars); redacted from artifacts; never logged',
    R4_CATALOG_TIMEOUT_MS: 'per-call deadline, 100..10000 ms; must stay below the capability timeout',
  },
  timeouts: {
    adapterDeadlineMs: 'R4_CATALOG_TIMEOUT_MS (recommended 2500)',
    capabilityTimeoutMs: 10_000,
    ownerDbQueryTimeoutMs: 'catalog-service DB_QUERY_TIMEOUT_MS (owner side)',
  },
  freshness: {
    owner: 'freshness.validUntil = asOf + 15 s, earlier at the first scheduled price change (promotion end or start; catalog-service v2, OD-3)',
    r4UpperBoundMs: CATALOG_FRESHNESS_TTL_MS,
    recorded: 'Observation.validUntil = min(observedAt + 5 min, owner validUntil) — ADR-030; expired evidence stays historical',
  },
  failureSemantics: '400→validation; 401/403→unauthorized (fail closed); 429/5xx/network→temporarily_unavailable (retryable); deadline→timeout; unparseable/invalid/other schemaVersion/key mismatch→contract_violation',
});

/**
 * What must be true before v2 may be enabled. Every item is open in J1C;
 * evidence for each belongs in docs/architecture/R4-J1C_CATALOG_CONTRACT_CONVERGENCE.md §12.
 */
export const SALES_PRODUCTION_PROFILE_V2_GATE = Object.freeze([
  { id: 'owner-commit', blocking: true, requirement: 'catalog-service J1C changes committed/deployed; R4 fixtures re-synced from that commit (SOURCE.json ownerContractFilesUncommitted=false)' },
  { id: 'prod-unknowns', blocking: true, requirement: 'BLOCKING read-only production queries answered (tax rules, specific prices, backorder config, feature_value schema, datetime timezone, max combinations)' },
  { id: 'owner-decisions', blocking: true, requirement: 'owner decisions OD-1..OD-3 recorded (from-price basis, promotion amount basis, freshness window)' },
  { id: 'live-read-only-smoke', blocking: true, requirement: 'authorized read-only smoke of the three v2 endpoints against the deployed catalog-service with the R4 key' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit user authorization to compose profile v2 (J1 CLOSED is a separate decision)' },
] as const);
