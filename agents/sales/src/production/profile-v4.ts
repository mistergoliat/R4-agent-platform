import type { ProductionProfile } from '@r4/live-ops';
import { QUOTE_V2_TIMEOUT_MS } from '../capabilities/quote-v2.js';
import { CAPABILITY_IDS } from '../ids.js';
import { SALES_DOMAINS } from './profile.js';
import { SALES_PRODUCTION_PROFILE_V3 } from './profile-v3.js';

/**
 * Sales production profile, version 4 (R4-J3B). NOT deployed by this slice.
 *
 * = sales-production@3 + Quote REAL (Quote Service V2 over HTTP). Everything
 * else is v3 verbatim: Catalog and Shipping REAL read-only, Customer
 * UNAVAILABLE, same channel, same capability list and the same write
 * decisions — `quote.create` stays REQUIRE_APPROVAL (SALES_PRODUCTION_ACTION_POLICY,
 * unchanged). It runs the same Sales definition as v3 (v4); quote.create@2
 * is the only quote version registered.
 *
 * A deployment composes it only by selecting it explicitly
 * (R4_PROD_POLICY_PROFILE=sales-production@4) and providing the Catalog,
 * Shipping and Quote bindings (R4_CATALOG_*, R4_SHIPPING_*, R4_QUOTE_*);
 * v1–v3 stay selectable and their fingerprints are untouched.
 */
export const QUOTE_CONTRACT_REF = 'quote-service:docs/v2/openapi.yaml (Quote Service API 2.0.0, frozen R1.2; Model B)';

export const SALES_PRODUCTION_PROFILE_V4: ProductionProfile = Object.freeze({
  profileId: 'sales-production',
  version: 4,
  description: 'Sales canary on a dedicated WhatsApp number: Catalog and Shipping read-only; Quote V2 issuance through governed quote.create@2; customer unavailable; quotes require approval.',
  domains: {
    ...SALES_PRODUCTION_PROFILE_V3.domains,
    [SALES_DOMAINS.quote]: { status: 'REAL', contractRef: QUOTE_CONTRACT_REF, note: 'HTTP binding (create-and-issue, quote/operation/idempotency lookup, document read); R4 sends a verified, approved commercial snapshot with expectedTotals; no email, no PDF to the channel' },
  },
  channel: { ...SALES_PRODUCTION_PROFILE_V3.channel },
  capabilities: [...SALES_PRODUCTION_PROFILE_V3.capabilities],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

/** How the v4 Quote domain is bound. */
export const SALES_PRODUCTION_V4_QUOTE_BINDING = Object.freeze({
  domain: SALES_DOMAINS.quote,
  binding: 'http',
  adapter: '@r4-adapters/quote-http (QuoteV2HttpClient)',
  contractRef: QUOTE_CONTRACT_REF,
  endpoints: ['POST /v2/quotes', 'GET /v2/quotes/{quoteId}', 'GET /v2/operations/{operationId}', 'GET /v2/idempotency/current?operation=quote.create_and_issue', 'GET /v2/quotes/{quoteId}/document'],
  authority: {
    effect: 'write',
    modelCapabilities: [CAPABILITY_IDS.quoteCreate],
    writes: 'POST /v2/quotes only, through quote.create@2 (IRREVERSIBLE_WRITE, approvalPolicy=required, REQUIRE_APPROVAL in SALES_PRODUCTION_ACTION_POLICY); no draft, cancel, email or validity override route is reachable',
    policy: 'governed execution only: propose_action → policy → human approval → command → receipt; Idempotency-Key = platform execution key',
  },
  principalScopes: ['quotes:create', 'quotes:read', 'quotes:document:read'],
  requiredEnv: {
    R4_QUOTE_MODE: 'must be "real"',
    R4_QUOTE_BASE_URL: 'Quote Service base URL (EC2 integration: http://127.0.0.1:4020, same host only); non-loopback requires https and R4_PROD_ALLOW_NETWORK=true',
    R4_QUOTE_BEARER_TOKEN: 'the R4 principal token from the owner registry (secret; never printed or logged)',
    R4_QUOTE_TIMEOUT_MS: 'per-call deadline, 1000..30000 ms (recommended 20000)',
  },
  timeouts: { adapterDeadlineMs: 'R4_QUOTE_TIMEOUT_MS (recommended 20000)', capabilityTimeoutMs: QUOTE_V2_TIMEOUT_MS },
  failureSemantics: '201/202 settle from quote state (issuing → unknown, reconciled); 400/413/422 → rejected; 401/403 → failed (fail closed); 409 → rejected (idempotency vs lifecycle by owner code); 500/503/lost answer/deadline → unknown, reconciled by key; never a new key for the same command',
});

/** What must be true before v4 is deployed. */
export const SALES_PRODUCTION_PROFILE_V4_GATE = Object.freeze([
  { id: 'owner-deployed', blocking: true, requirement: 'Quote V2 healthy on the integration host (OpenAPI 2.0.0, schema head, Gmail disabled)' },
  { id: 'r4-principal', blocking: true, requirement: 'an R4-specific Quote principal with exactly quotes:create, quotes:read, quotes:document:read, provisioned through the owner registry rotation' },
  { id: 'sales-migration', blocking: true, requirement: 'Sales migration 0007_sales_quote_v2_issuance applied by production:sales:bootstrap before the worker starts' },
  { id: 'synthetic-e2e', blocking: true, requirement: 'a synthetic Sales→Quote E2E with the real adapter from an isolated runner (no customer, no channel send)' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit user authorization to deploy sales-production@4' },
] as const);

// The selectable profile registry (v1–v5) and the pinned definition versions live in profile-v5.ts (R4-J3E).
