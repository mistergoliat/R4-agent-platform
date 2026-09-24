import { DEFAULT_ACTION_POLICY, type ActionPolicyConfigurationInput } from '@r4/policy-engine';
import type { ProductionProfile } from '@r4/live-ops';
import { WHATSAPP_CHANNEL_ID, WHATSAPP_CLOUD_CONTRACT_REF } from '@r4-adapters/whatsapp-cloud';
import { CAPABILITY_IDS } from '../ids.js';

/** The Sales pack's domains as its production profile names them. */
export const SALES_DOMAINS = { customer: 'customer', catalog: 'catalog', shipping: 'shipping', quote: 'quote', workspace: 'sales-workspace' } as const;

/**
 * Sales production profile, version 1 (R4-I canary). Intentionally
 * conservative and honest about what exists:
 *
 * - Customer, Catalog, Shipping, Quote: UNAVAILABLE. No documented contract,
 *   endpoint or credential for a live owner exists in R4 (R4-F/H finding,
 *   re-audited in R4-I); fixtures are never production bindings. Their
 *   capabilities are not registered, so the model never sees them and can
 *   never present fixture prices, stock, shipping or quotes to a customer.
 * - Sales workspace: INTERNAL (R4-owned working state; no business truth).
 * - Channel: WhatsApp Cloud API, REAL, canary number only.
 * - Writes: workspace updates ALLOW (reversible, internal); `quote.create`
 *   REQUIRE_APPROVAL (and unavailable anyway while Quote is UNAVAILABLE).
 * - Unsupported inbound content (media, reactions…): held for a human.
 *
 * Widening any of this (real owners, fewer approvals, larger cohorts) is R4-J.
 */
export const SALES_PRODUCTION_PROFILE: ProductionProfile = Object.freeze({
  profileId: 'sales-production',
  version: 1,
  description: 'Sales canary on a dedicated WhatsApp number: conversation only; every domain owner unavailable; quotes require approval.',
  domains: {
    [SALES_DOMAINS.customer]: { status: 'UNAVAILABLE', contractRef: null, note: 'no Customer contract/endpoint configured in R4; customers are anonymous/unknown' },
    [SALES_DOMAINS.catalog]: { status: 'UNAVAILABLE', contractRef: null, note: 'Catalog contract exists only second-hand outside R4; no endpoint/credential in R4' },
    [SALES_DOMAINS.shipping]: { status: 'UNAVAILABLE', contractRef: null, note: 'no Shipping contract configured in R4' },
    [SALES_DOMAINS.quote]: { status: 'UNAVAILABLE', contractRef: null, note: 'no documented Quote sandbox/production contract in R4' },
    [SALES_DOMAINS.workspace]: { status: 'INTERNAL', contractRef: null, note: 'Sales working state owned by the pack in R4 (schema sales); no domain truth' },
  },
  channel: { id: WHATSAPP_CHANNEL_ID, status: 'REAL', contractRef: WHATSAPP_CLOUD_CONTRACT_REF },
  capabilities: [
    { capabilityId: CAPABILITY_IDS.customerContext, domain: SALES_DOMAINS.customer, effect: 'read' },
    { capabilityId: CAPABILITY_IDS.catalogSearch, domain: SALES_DOMAINS.catalog, effect: 'read' },
    { capabilityId: CAPABILITY_IDS.productContext, domain: SALES_DOMAINS.catalog, effect: 'read' },
    { capabilityId: CAPABILITY_IDS.shippingQuote, domain: SALES_DOMAINS.shipping, effect: 'read' },
    { capabilityId: CAPABILITY_IDS.workspaceUpdate, domain: SALES_DOMAINS.workspace, effect: 'write', decision: 'ALLOW' },
    { capabilityId: CAPABILITY_IDS.quoteCreate, domain: SALES_DOMAINS.quote, effect: 'write', decision: 'REQUIRE_APPROVAL' },
  ],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

/**
 * The action policy enforcing the profile's write decisions (R4-D stays the
 * only authority over proposed actions). Differs from the reference
 * SALES_ACTION_POLICY only where production must be more conservative:
 * issuing a quote requires a human approval.
 */
export const SALES_PRODUCTION_ACTION_POLICY: ActionPolicyConfigurationInput = Object.freeze({
  policyId: 'sales-production-policy',
  version: 1,
  riskClasses: DEFAULT_ACTION_POLICY.riskClasses,
  capabilities: {
    [CAPABILITY_IDS.workspaceUpdate]: { autonomy: 'allow' },
    [CAPABILITY_IDS.quoteCreate]: { autonomy: 'require_approval', minimumIdentity: 'provisional', requireEvidence: true },
  },
} satisfies ActionPolicyConfigurationInput);
