import { profileLabel, type ProductionProfile } from '@r4/live-ops';
import type { ActionPolicyConfigurationInput } from '@r4/policy-engine';
import { CHECKOUT_CAPABILITY_IDS } from '../ids.js';
import { SALES_DOMAINS } from './profile.js';
import { SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY } from './profile-v5.js';
import { SALES_PRODUCTION_PROFILE_V13 } from './profile-v13.js';
import { SALES_PRODUCTION_PROFILE_V14, SALES_QUOTE_LANE_PROFILE_LABEL } from './profile-v14.js';
import { SALES_PRODUCTION_PROFILE_V16, SALES_QUOTE_LANE_V16_PROFILE_LABEL } from './profile-v16.js';
import { SALES_PRODUCTION_PROFILE_V17, SALES_QUOTE_LANE_V17_PROFILE_LABEL } from './profile-v17.js';
import { SALES_PRODUCTION_PROFILE_V18, SALES_QUOTE_LANE_V18_PROFILE_LABEL } from './profile-v18.js';

/** The Checkout contract R4 consumes (Checkout side final as of SBX-2; still PROPOSED for R4, Quote and CIA). */
export const CHECKOUT_CONTRACT_REF = 'checkout: docs/reviews/R4_CHECKOUT_INTEGRATION_CONTRACT.md (owner commit d11e3c7, OpenAPI /v1 1.0.3-proposed, sandbox-purchase API listener only)';

/**
 * Sales production profile, version 15 (R4 Quote V2 + Checkout integration, 2026-11-06). The E3 CHECKOUT SANDBOX LANE
 * profile. NOT deployed and NOT activated. It composes only with a purchase-consent source: the sandbox one reads the
 * artifacts an operator obtained with Checkout's test-only tooling (R4_CHECKOUT_SBX_CONSENT_DIR); CIA has no purchase
 * grant (contract R-3) and R4 never signs consent.
 *
 * = sales-production@14 (Catalog V2 + Discover, Shipping, Quote V2 autonomous issuance of the confirmed Sales-rendered
 * offer, P-1, F1 ceilings, kill switch) plus Checkout, sandbox-purchase only:
 *   checkout.start_purchase@1          FINANCIAL, autonomous ONLY in this profile (R-5): issued quote of this
 *                                      conversation, explicit purchase request, consent artifact; Checkout decides
 *   checkout.request_payment_link@1    FINANCIAL, read first (§5.3); the link reaches the customer as a platform notice (R-4)
 *   checkout.purchase_status@1         READ, §6 mapping; the only basis for "paid"
 * Running definition v15 (v14 + the Checkout lines). A lane profile: allowlisted conversations only (ADR-045).
 */
export const SALES_PRODUCTION_PROFILE_V15: ProductionProfile = Object.freeze({
  profileId: 'sales-production',
  version: 15,
  description: 'Sales E3 checkout SANDBOX lane on the production number, allowlisted conversations only: @14 (Catalog V2 + Discover, Shipping, Quote V2 autonomous issuance of the confirmed offer) plus Checkout sandbox-purchase: start the purchase of an issued quote the customer asked to pay, a payment link sent by the platform, and the payment and order status as Checkout verified it. Test payments only.',
  domains: {
    ...SALES_PRODUCTION_PROFILE_V14.domains,
    [SALES_DOMAINS.checkout]: { status: 'REAL', contractRef: CHECKOUT_CONTRACT_REF, note: 'HTTP binding to the Checkout sandbox-purchase API (R4_CHECKOUT_MODE=sandbox only; no production mode exists); commands behind the kill switch; R4 never decides a payment, an order or an expiry' },
  },
  channel: { ...SALES_PRODUCTION_PROFILE_V14.channel },
  capabilities: [
    ...SALES_PRODUCTION_PROFILE_V14.capabilities,
    { capabilityId: CHECKOUT_CAPABILITY_IDS.startPurchase, domain: SALES_DOMAINS.checkout, effect: 'write', decision: 'ALLOW' },
    { capabilityId: CHECKOUT_CAPABILITY_IDS.requestPaymentLink, domain: SALES_DOMAINS.checkout, effect: 'write', decision: 'ALLOW' },
    { capabilityId: CHECKOUT_CAPABILITY_IDS.purchaseStatus, domain: SALES_DOMAINS.checkout, effect: 'read' },
  ],
  unsupportedContent: 'handoff',
} satisfies ProductionProfile);

export const SALES_CHECKOUT_LANE_PROFILE_LABEL = 'sales-production@15';

export function isCheckoutLaneProfile(profile: ProductionProfile): boolean {
  return profileLabel(profile) === SALES_CHECKOUT_LANE_PROFILE_LABEL;
}

/**
 * The @15 action policy (R-5; owner decision D7-6, 2026-11-06: SANDBOX ONLY): the autonomous quote policy plus exactly
 * the two Checkout commands as autonomous FINANCIAL writes with provisional identity and cited evidence. The FINANCIAL
 * class rule stays the platform default (approval + verified identity): no other financial write becomes autonomous.
 * The rest of D7-6 is enforced where the facts are, without kernel changes:
 *   - at most CHECKOUT_FINANCIAL_OPERATIONS_PER_TASK (2) Checkout operations per task, replays not counted (pack);
 *   - every Checkout command first proves sandbox isolation from Checkout's readiness, or nothing is sent (adapter);
 *   - R4 cannot change prices (Checkout charges Quote's frozen amount), issue consent, create orders or mark a payment:
 *     no capability exists for any of them, and "paid" comes only from checkout.purchase_status (§6).
 */
export const SALES_PRODUCTION_V15_ACTION_POLICY: ActionPolicyConfigurationInput = Object.freeze({
  policyId: 'sales-production-checkout-sandbox-policy',
  version: 1,
  riskClasses: SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY.riskClasses,
  capabilities: {
    ...SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY.capabilities,
    [CHECKOUT_CAPABILITY_IDS.startPurchase]: { autonomy: 'allow', minimumIdentity: 'provisional', requireEvidence: true },
    [CHECKOUT_CAPABILITY_IDS.requestPaymentLink]: { autonomy: 'allow', minimumIdentity: 'provisional', requireEvidence: true },
  },
} satisfies ActionPolicyConfigurationInput);

/** Profiles a gateway may serve as its lane and a production worker may select; never a gateway's main profile. */
export const SALES_LANE_PROFILES: readonly ProductionProfile[] = Object.freeze([SALES_PRODUCTION_PROFILE_V13, SALES_PRODUCTION_PROFILE_V14, SALES_PRODUCTION_PROFILE_V15, SALES_PRODUCTION_PROFILE_V16, SALES_PRODUCTION_PROFILE_V17, SALES_PRODUCTION_PROFILE_V18]);

export function isSalesLaneProfile(profile: ProductionProfile): boolean {
  return SALES_LANE_PROFILES.some((p) => profileLabel(p) === profileLabel(profile));
}

/** Lane profiles that issue quotes (@14, @15, @16, @17, @18): F1 ceilings, parity, write ceiling 1..6. */
export function isQuoteLaneProfile(profile: ProductionProfile): boolean {
  return [SALES_QUOTE_LANE_PROFILE_LABEL, SALES_CHECKOUT_LANE_PROFILE_LABEL, SALES_QUOTE_LANE_V16_PROFILE_LABEL, SALES_QUOTE_LANE_V17_PROFILE_LABEL, SALES_QUOTE_LANE_V18_PROFILE_LABEL].includes(profileLabel(profile));
}

/** The Catalog source a profile binds: V2 only for the lane profiles (decided by the profile, never by a variable). */
export function salesCatalogSourceOf(profile: ProductionProfile): 'v1' | 'v2' {
  return isSalesLaneProfile(profile) ? 'v2' : 'v1';
}

/** What must be true before @15 serves a real (sandbox) purchase. */
export const SALES_PRODUCTION_PROFILE_V15_GATE = Object.freeze([
  { id: 'v14-gate', blocking: true, requirement: 'every blocking item of SALES_PRODUCTION_PROFILE_V14_GATE (@15 issues quotes as @14)' },
  { id: 'contract-accepted', blocking: true, requirement: 'R4_CHECKOUT_INTEGRATION_CONTRACT accepted by the R4 owner (and Quote/CIA owners for H3)' },
  { id: 'consent-source', blocking: true, requirement: 'R-3: the sandbox consent directory (R4_CHECKOUT_SBX_CONSENT_DIR) fed by an operator with Checkout sign-test-consent for the test buyer, after issuance and within the artifact TTL; R4 never signs consent. Production: the CIA purpose purchase grant' },
  { id: 'same-quote-instance', blocking: true, requirement: 'the Quote instance R4 issues against is the one Checkout sandbox-purchase reads and prepares carts from (SBX-2 used an isolated Quote runner)' },
  { id: 'checkout-runtime', blocking: true, requirement: 'Checkout sandbox-purchase runtime running at the API listener with R4\'s service token and scopes, readiness profile sandbox-purchase / MERCADOPAGO_SANDBOX_TEST_ONLY, a financial grant in force, test credential within its authorization' },
  { id: 'financial-policy', blocking: true, requirement: 'D7-6 (decided 2026-11-06, sandbox only): policy sales-production-checkout-sandbox-policy@1, at most 2 Checkout financial operations per task, sandbox isolation proven by Checkout readiness before every command; any non-sandbox use needs a new decision' },
  { id: 'migrations', blocking: true, requirement: 'Sales migration 0010 and platform migration 0014 (platform notices) applied before any process runs the new code' },
  { id: 'definition-v15-registered', blocking: true, requirement: 'identifiers v15 and @15 verified free, then registered with production:sales:bootstrap --lane' },
  { id: 'payment-claims-evaluated', blocking: true, requirement: 'definition v15 evaluated with the real model: no URL, amount or accreditation written by the model (R4-CK-05, R4-CK-11)' },
  { id: 'l3', blocking: true, requirement: 'L3 on the exact R4 SHA, plus the sandbox E2E R4-CK-01..12 against the Checkout runtime' },
  { id: 'explicit-authorization', blocking: true, requirement: 'explicit owner authorization to switch the lane to @15 for the test buyer, by SHA' },
] as const);
