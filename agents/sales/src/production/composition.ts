import type pg from 'pg';
import type { Logger } from 'pino';
import { DomainError, type CatalogPort, type CheckoutConsentSource, type CheckoutService, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import { identityVerificationSchemaIsCurrent } from '@r4-adapters/identity-verification';
import { WhatsAppInboundAdapter, WhatsAppMediaDownloader, WhatsAppOutboundAdapter, describeWhatsAppConfig, loadWhatsAppCloudConfig, type FetchLike, type WhatsAppCloudConfig } from '@r4-adapters/whatsapp-cloud';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { systemClock, type Clock, type Principal } from '@r4/contracts';
import type { ModelProvider } from '@r4/model-gateway';
import {
  AutonomyControls,
  DeliveryStateContextSource,
  PriorConversationContextSource,
  assertProductionComposition,
  assertProductionMode,
  capabilityAvailability,
  guardProductionWrites,
  profileLabel,
  type ConversationLane,
  type ConversationTaskFactory,
  type MediaPerception,
  type ProductionCompositionReport,
  type ProductionProfile,
  type ProductionConfig,
  type ProductionSecrets,
  type ProductionStore,
} from '@r4/live-ops';
import type { WorkerBindings } from '@r4/worker';
import type { GatewayBindings } from '@r4/channel-gateway';
import { workspaceCapability } from '../capabilities/workspace.js';
import { SALES_AGENT_ID, SALES_TASK_TYPE, AUTONOMOUS_QUOTE_CAPABILITY_IDS, CAPABILITY_IDS } from '../ids.js';
import { SALES_ROOT_GOAL } from '../goal.js';
import { SalesWorkspaceContextSource } from '../workspace/context-source.js';
import { PostgresSalesStore } from '../workspace/store.js';
import { SALES_DOMAINS } from './profile.js';
import { isAutonomousQuoteProfile } from './profile-v5.js';
import { isConfirmedIntentProfile } from './profile-v6.js';
import { isDeterministicOfferProfile } from './profile-v7.js';
import { SALES_PRODUCTION_PROFILES, isCustomerIdentityProfile, salesActionPolicyFor, salesProductionAgentVersion, salesProductionProfile } from './profile-v8.js';
import { composeSyntheticCustomerCapabilities, composeSyntheticIdentityVerificationCapabilities } from '../capabilities/customer-synthetic.js';
import { GATEWAY_ONLY_ENV, salesGatewayInspection } from './gateway-identity.js';
import { SALES_IMAGE_PERCEPTION_INSTRUCTIONS, SALES_TRANSCRIPTION_PROMPT, SalesMediaPerceiver } from './media-perception.js';
import { configuredMediaPerception } from '../model.js';
import { catalogCapabilities } from '../capabilities/catalog.js';
import { F1_COMMERCIAL_POLICY_V2_VERSION, F1_COMMERCIAL_POLICY_VERSION, type CommercialEligibility } from '../capabilities/commercial-snapshot.js';
import { shippingCapability } from '../capabilities/shipping.js';
import { quoteCreateV2Capability } from '../capabilities/quote-v2.js';
import { quoteCreateV3Capability } from '../capabilities/quote-v3.js';
import { quotePreviewCapability, quotePreviewV2Capability, quotePreviewV3Capability } from '../capabilities/quote-preview.js';
import { quoteCreateV4Capability } from '../capabilities/quote-v4.js';
import { quoteCreateV5Capability, quoteWritesBlockedError } from '../capabilities/quote-v5.js';
import { workspaceCapabilityV2 } from '../capabilities/workspace-v2.js';
import type { AutonomousQuoteLimits, AutonomousQuoteLimitsV6 } from '../capabilities/autonomy-limits.js';
import { assertQuoteParityConfigured, type QuoteParityGuard } from '../capabilities/parity-guard.js';
import { SALES_CANARY_ONLY_PROFILES, assertF1CanaryLimits, isF1CanaryProfile } from './profile-v12.js';
import { SALES_LANE_PROFILES, isCheckoutLaneProfile, isQuoteLaneProfile, isSalesLaneProfile } from './profile-v15.js';
import { SALES_QUOTE_LANE_V17_PROFILE_LABEL, SALES_VARIANT_AVAILABILITY_PROFILES } from './profile-v17.js';
import { SALES_QUOTE_DOCUMENT_PROFILES, SALES_QUOTE_LANE_V18_PROFILE_LABEL } from './profile-v18.js';
import { SALES_F1_SHIPPING_PROFILES, SALES_INTENT_ACCEPTANCE_PROFILES } from './profile-v19.js';
import { quoteDocumentDelivery } from '../capabilities/quote-document.js';
import { catalogDiscoverCapability } from '../capabilities/catalog-discover.js';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { checkoutPurchaseStatusCapability, checkoutRequestLinkCapability, checkoutStartPurchaseCapability } from '../capabilities/checkout.js';

/** Who opens production Sales conversations: the channel ingress (a platform service, never the model). */
export const SALES_CHANNEL_INGRESS: Principal = { kind: 'service', ref: 'sales-channel-ingress' };

/**
 * A Catalog port for a deployment where Catalog is UNAVAILABLE: every call is
 * refused before any effect, classified like an owner outage. It exists only
 * because the (internal) workspace capability validates product ids against
 * Catalog; with it, selections are refused honestly instead of accepted
 * against fixture data.
 */
export const UNAVAILABLE_CATALOG: CatalogPort & { readonly bindingKind: 'unavailable' } = Object.freeze({
  bindingKind: 'unavailable' as const,
  search: unavailableCatalog,
  getProductContext: unavailableCatalog,
  getItemContext: unavailableCatalog,
});

function unavailableCatalog(): Promise<never> {
  return Promise.reject(new DomainError('temporarily_unavailable', 'catalog_unavailable', 'the catalog is not available in this deployment'));
}

export interface SalesProductionWorkerOptions {
  readonly pool: pg.Pool;
  /** The durable production store (autonomy controls, delivery state), composed by the deployment. */
  readonly store: ProductionStore;
  readonly production: { readonly config: ProductionConfig };
  readonly modelProvider: ModelProvider;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** The catalog-service binding; required when the selected profile makes Catalog REAL (v2). */
  readonly catalog?: CatalogPort & { readonly bindingKind: string };
  /** (ADR-045) Catalog V2 Discover; required when the selected profile is a lane profile (@13), ignored otherwise. */
  readonly catalogDiscover?: CatalogDiscoverPort;
  /** The pc-carrier binding (ProductionShippingAdapter); required when the selected profile makes Shipping REAL (v3). */
  readonly shipping?: ShippingService & { readonly bindingKind: string };
  /** The Quote V2 binding (QuoteV2HttpClient); required when the selected profile makes Quote REAL (v4). */
  readonly quotes?: QuoteV2Service & { readonly bindingKind: string };
  /** (R4-J3E) The configured limits of autonomous issuance; required when the selected profile issues quotes autonomously (v5; v6 also needs the total-units limit and the confirmation window). */
  readonly autonomousQuoteLimits?: AutonomousQuoteLimits | AutonomousQuoteLimitsV6;
  /** (R4-J5 F1, P-1) The parity-verified SKU set for autonomous quotes (R4_QUOTE_PARITY_*); applied to the deterministic-offer path (v7 lineage) when given. The F1 profile gate must require it. */
  readonly quoteParity?: QuoteParityGuard | null;
  /** (R4-J5 F1) Set only by the isolated canary runtime: it may also compose canary-only profiles (@12). A production worker never sets it. */
  readonly canary?: boolean;
  /** (R4 Checkout, R-1) The Checkout sandbox-purchase binding (CheckoutHttpClient); required when the selected profile composes Checkout (@15). */
  readonly checkout?: CheckoutService & { readonly bindingKind: string };
  /** (R4 Checkout, R-3) Where the purchase-consent artifact comes from; required by @15. Sandbox only: SandboxConsentDirectory (R4 never signs). */
  readonly checkoutConsent?: CheckoutConsentSource;
  /** (R4-J4-R4) The R4_CUSTOMER_* configuration of the worker; required when the selected profile composes Customer and identity verification (v8). */
  readonly customer?: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
    /** (R4-J4-R5 preparation) The isolated canary's closed test-host allowlist. The production CLI never sets it. */
    readonly allowedHosts?: readonly string[];
  };
}

/** The Sales production profile the deployment declared, or a refusal (nothing is defaulted). */
export function selectedSalesProductionProfile(config: ProductionConfig, options: { readonly canary?: boolean; readonly lane?: boolean } = {}): ProductionProfile {
  const profile =
    salesProductionProfile(config.policyProfile) ??
    (options.canary ? (SALES_CANARY_ONLY_PROFILES.find((p) => profileLabel(p) === config.policyProfile) ?? null) : null) ??
    // (ADR-045) A lane profile is selected only by a production worker; a gateway serves it as its lane, never as its main profile.
    (options.lane ? (SALES_LANE_PROFILES.find((p) => profileLabel(p) === config.policyProfile) ?? null) : null);
  if (!profile) throw new Error(`refusing production composition: R4_PROD_POLICY_PROFILE=${config.policyProfile} is not a Sales production profile (${SALES_PRODUCTION_PROFILES.map(profileLabel).join(', ')})`);
  return profile;
}

export interface SalesProductionWorker {
  readonly bindings: WorkerBindings;
  readonly report: ProductionCompositionReport;
  readonly controls: AutonomyControls;
}

/**
 * Production composition of the Sales worker (R4-I). Same pack, same
 * instructions, same kernel/runtimes as F–H: production only changes what is
 * plugged into the worker's public seams —
 *   capabilities  only those the profile makes AVAILABLE (UNAVAILABLE owners' capabilities are not registered)
 *   actionPolicy  SALES_PRODUCTION_ACTION_POLICY (R4-D governs every proposal); v5–v7:
 *                 SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY (ADR-034)
 *   quote writes  v7 only: Quote V2 createAndIssue behind the kill switch (killSwitchGuardedQuotes)
 *   admission     the durable kill switch, asked before every claim
 *   context       + the delivery state of earlier responses (honest: sent ≠ received)
 *   presence      production mode + the profile version (execution-contract compatibility)
 * and refuses to compose unless production is proven, the profile is the
 * declared one, and every registered capability is available.
 */
export function composeSalesProductionWorker(options: SalesProductionWorkerOptions): SalesProductionWorker {
  const config = assertProductionMode(options.production.config);
  const profile = selectedSalesProductionProfile(config, { canary: options.canary === true, lane: true });
  const clock = options.clock ?? systemClock;
  const sales = new PostgresSalesStore(options.pool);
  const controls = new AutonomyControls({ store: options.store, logger: options.logger });
  const capabilities = new CapabilityRegistry();
  // Catalog is bound only when the profile makes it REAL (v2); otherwise every call is refused honestly.
  const catalogReal = profile.domains[SALES_DOMAINS.catalog]?.status === 'REAL';
  if (catalogReal && (!options.catalog || options.catalog.bindingKind === UNAVAILABLE_CATALOG.bindingKind)) {
    throw new Error(`refusing production composition: ${profileLabel(profile)} binds Catalog REAL but no catalog-service binding was provided (R4_CATALOG_*)`);
  }
  const catalog: CatalogPort = catalogReal ? options.catalog! : UNAVAILABLE_CATALOG;
  // (R4-J3E) v5 records the customer's shipping choice and quote request (workspace.update@2, which re-quotes Shipping); v1–v4 keep version 1.
  const autonomousQuotes = isAutonomousQuoteProfile(profile);
  if (capabilityAvailability(profile, CAPABILITY_IDS.workspaceUpdate).available && !autonomousQuotes) {
    capabilities.registerWrite(workspaceCapability({ store: sales, catalog, clock }));
  }
  if (catalogReal) {
    // READ capabilities offered to the model; they execute through the CapabilityInvoker only.
    const [catalogSearch, productContext] = catalogCapabilities(catalog, { variantAvailability: SALES_VARIANT_AVAILABILITY_PROFILES.has(profileLabel(profile)) });
    capabilities.register(catalogSearch);
    capabilities.register(productContext);
  }
  // (ADR-045) The lane profile reads Catalog V2 Discover; it never composes without it.
  if (isSalesLaneProfile(profile)) {
    // A port whose Discover key (or V2 source) is missing would compose and then fail every call: refuse at start.
    if (!catalogReal || !options.catalogDiscover?.discoverConfigured) throw new Error(`refusing production composition: ${profileLabel(profile)} requires Catalog V2 Discover (R4_CATALOG_V2_* and R4_CATALOG_V2_DISCOVER_API_KEY)`);
    capabilities.register(catalogDiscoverCapability(options.catalogDiscover));
  }
  // Shipping is bound only when the profile makes it REAL (v3): the pc-carrier HTTP adapter, never a fixture.
  // Its order basis reads Catalog, so a REAL Shipping without a REAL Catalog is refused too.
  const shippingReal = profile.domains[SALES_DOMAINS.shipping]?.status === 'REAL';
  if (shippingReal) {
    if (!options.shipping || options.shipping.bindingKind !== 'http') {
      throw new Error(`refusing production composition: ${profileLabel(profile)} binds Shipping REAL but no pc-carrier binding was provided (R4_SHIPPING_*)`);
    }
    if (!catalogReal) throw new Error(`refusing production composition: ${profileLabel(profile)} binds Shipping REAL without a REAL Catalog (the order basis reads Catalog)`);
    if (capabilityAvailability(profile, CAPABILITY_IDS.shippingQuote).available) capabilities.register(shippingCapability(options.shipping, catalog));
  }
  // Quote is bound only when the profile makes it REAL (v4): the Quote V2 HTTP adapter, never a fixture.
  // quote.create@2 verifies the approved snapshot against Catalog and Shipping, so both must be REAL too.
  const quoteReal = profile.domains[SALES_DOMAINS.quote]?.status === 'REAL';
  if (quoteReal) {
    if (!options.quotes || options.quotes.bindingKind !== 'http') {
      throw new Error(`refusing production composition: ${profileLabel(profile)} binds Quote REAL but no Quote V2 binding was provided (R4_QUOTE_*)`);
    }
    if (!catalogReal || !shippingReal || !options.shipping) throw new Error(`refusing production composition: ${profileLabel(profile)} binds Quote REAL without REAL Catalog and Shipping (the commercial snapshot is verified against both)`);
    if (autonomousQuotes) {
      // (R4-J3E, ADR-034) Autonomous issuance: the commercial snapshot (READ) and quote.create@3, gated by configured limits.
      const limits = options.autonomousQuoteLimits;
      if (!limits) throw new Error(`refusing production composition: ${profileLabel(profile)} issues quotes autonomously but no autonomous quote limits were configured (R4_AUTONOMOUS_QUOTE_*)`);
      capabilities.registerWrite(workspaceCapabilityV2({ store: sales, catalog, shipping: options.shipping, clock }));
      if (isConfirmedIntentProfile(profile)) {
        // (R4-J3E-B, ADR-035) v6: the customer's confirmation is read from the conversation the platform recorded (ProductionStore.thread).
        if (!isV6Limits(limits)) throw new Error(`refusing production composition: ${profileLabel(profile)} needs the total-units limit and the confirmation window (R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS, R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS)`);
        if (isDeterministicOfferProfile(profile)) {
          // (R4-J3E-C1) v7: the offer message is rendered by Sales and must be presented exactly; Quote V2 writes stop with the kill switch.
          // (F1 concurrency) At most ONE Quote V2 issuance in flight across every worker of the deployment: the shared
          // PostgreSQL advisory lock wraps the kill-switch guard, so the switch is re-read after the wait.
          const quotes = salesQuotePort(profile, options.quotes, controls, options.pool, options.logger);
          // (R4-J5 F1, P-1) A profile that requires the parity-verified set never composes quote.create without it; the evidence in use is logged.
          assertQuoteParityConfigured(profileLabel(profile), options.quoteParity);
          // (R4-J5 F1) The F1 canary, and the quote lane @14, run within the owner-approved canary limits, never looser.
          if (isF1CanaryProfile(profile) || isQuoteLaneProfile(profile)) assertF1CanaryLimits(limits, profileLabel(profile));
          if (options.quoteParity) options.logger.info({ quoteParity: { profile: profileLabel(profile), fingerprint: options.quoteParity.fingerprint, items: options.quoteParity.items, maxAgeSeconds: options.quoteParity.maxAgeSeconds } }, 'sales quote parity evidence configured');
          if (capabilityAvailability(profile, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).available) capabilities.register(quotePreviewV3Capability({ store: sales, catalog, shipping: options.shipping, limits, now: () => clock.now(), parity: options.quoteParity ?? null, eligibility: salesCommercialEligibility(profile), naturalAcceptance: SALES_INTENT_ACCEPTANCE_PROFILES.has(profileLabel(profile)) }));
          if (capabilityAvailability(profile, CAPABILITY_IDS.quoteCreate).available) capabilities.registerWrite(quoteCreateV5Capability({ store: sales, quotes, catalog, shipping: options.shipping, limits, conversation: options.store, admission: controls, now: () => clock.now(), parity: options.quoteParity ?? null, eligibility: salesCommercialEligibility(profile), documents: SALES_QUOTE_DOCUMENT_PROFILES.has(profileLabel(profile)) ? quoteDocumentDelivery(options.store, options.logger) : null, naturalAcceptance: SALES_INTENT_ACCEPTANCE_PROFILES.has(profileLabel(profile)) }));
        } else {
          if (capabilityAvailability(profile, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).available) capabilities.register(quotePreviewV2Capability({ store: sales, catalog, shipping: options.shipping, limits, now: () => clock.now() }));
          if (capabilityAvailability(profile, CAPABILITY_IDS.quoteCreate).available) capabilities.registerWrite(quoteCreateV4Capability({ store: sales, quotes: options.quotes, catalog, shipping: options.shipping, limits, conversation: options.store, now: () => clock.now() }));
        }
      } else {
        if (capabilityAvailability(profile, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).available) capabilities.register(quotePreviewCapability({ store: sales, catalog, shipping: options.shipping, limits, now: () => clock.now() }));
        if (capabilityAvailability(profile, CAPABILITY_IDS.quoteCreate).available) capabilities.registerWrite(quoteCreateV3Capability({ store: sales, quotes: options.quotes, catalog, shipping: options.shipping, limits, now: () => clock.now() }));
      }
    } else if (capabilityAvailability(profile, CAPABILITY_IDS.quoteCreate).available) {
      capabilities.registerWrite(quoteCreateV2Capability({ store: sales, quotes: options.quotes, catalog, shipping: options.shipping, now: () => clock.now() }));
    }
  } else if (autonomousQuotes) {
    throw new Error(`refusing production composition: ${profileLabel(profile)} issues quotes autonomously without a REAL Quote domain`);
  }
  // (R4 Checkout, contract R-2/R-4) @15: Checkout sandbox-purchase; its commands behind the kill switch; the link goes out as a platform notice.
  const checkoutReal = isCheckoutLaneProfile(profile);
  if (checkoutReal) {
    if (!options.checkout || options.checkout.bindingKind !== 'http') throw new Error(`refusing production composition: ${profileLabel(profile)} binds Checkout but no Checkout binding was provided (R4_CHECKOUT_*)`);
    if (!options.checkoutConsent) throw new Error(`refusing production composition: ${profileLabel(profile)} requires a purchase-consent source (contract R-3: R4_CHECKOUT_SBX_CONSENT_DIR, artifacts from Checkout's test tooling); R4 never signs consent`);
    if (!quoteReal || !options.quotes) throw new Error(`refusing production composition: ${profileLabel(profile)} binds Checkout without a REAL Quote domain`);
    const deps = { store: sales, checkout: killSwitchGuardedCheckout(options.checkout, controls, options.logger), quotes: options.quotes, consent: options.checkoutConsent, conversation: options.store, notices: options.store, now: () => clock.now() };
    capabilities.registerWrite(checkoutStartPurchaseCapability(deps));
    capabilities.registerWrite(checkoutRequestLinkCapability(deps));
    capabilities.register(checkoutPurchaseStatusCapability(deps));
  }
  // (R4-J4-R4) v8: the Customer reads and the identity verification; every other profile leaves Customer UNAVAILABLE.
  const customerIdentity = isCustomerIdentityProfile(profile);
  if (customerIdentity) composeCustomerIdentity(profile, options, capabilities);
  // Customer (before v8, and Catalog under v1, Shipping under v1/v2, Quote under v1–v3) are UNAVAILABLE: their capabilities are deliberately not registered.
  const report = assertProductionComposition(
    profile,
    [
      { domain: SALES_DOMAINS.workspace, bindingKind: 'internal' },
      { domain: SALES_DOMAINS.catalog, bindingKind: catalogReal ? 'real' : UNAVAILABLE_CATALOG.bindingKind },
      ...(shippingReal ? [{ domain: SALES_DOMAINS.shipping, bindingKind: 'real' as const }] : []),
      ...(quoteReal ? [{ domain: SALES_DOMAINS.quote, bindingKind: 'real' as const }] : []),
      ...(customerIdentity ? [{ domain: SALES_DOMAINS.customer, bindingKind: 'real' as const }, { domain: SALES_DOMAINS.identity, bindingKind: 'real' as const }] : []),
      ...(checkoutReal ? [{ domain: SALES_DOMAINS.checkout, bindingKind: 'real' as const }] : []),
    ],
    capabilities.list().map((c) => c.capabilityId),
  );
  return {
    report,
    controls,
    bindings: {
      modelProvider: options.modelProvider,
      capabilities,
      contextSources: [new SalesWorkspaceContextSource(sales), new DeliveryStateContextSource(options.store), new PriorConversationContextSource(options.store, { windowDays: config.priorConversationDays })],
      actionPolicy: salesActionPolicyFor(profile),
      admission: controls,
      presence: { executionMode: 'production', runtimeProfile: profileLabel(profile) },
      // R4-J4-R6 EV-2: only tasks pinned to this profile's definition; after a rollback, tasks of another
      // definition wait (durable, visible) instead of running with this profile's capabilities.
      servedAgents: [{ agentId: SALES_AGENT_ID, version: salesProductionAgentVersion(profile) }],
    },
  };
}

/**
 * (R4-J4-R4) The v8 Customer and identity capabilities, through the same compositions the synthetic campaigns
 * run: R4_CUSTOMER_MODE=synthetic, `synthetic-` credentials and loopback URLs only (`real` is refused by the
 * adapters), the trusted binding, task state and thread of the production store, and the identity-verification
 * schema of the platform database. Each missing dependency refuses the composition; nothing is defaulted.
 */
function composeCustomerIdentity(profile: ProductionProfile, options: SalesProductionWorkerOptions, capabilities: CapabilityRegistry): void {
  const refuse = (reason: string, cause?: unknown) => new Error(`refusing production composition: ${profileLabel(profile)} ${reason}`, cause === undefined ? undefined : { cause });
  if (!options.customer) throw refuse('composes Customer and identity verification but no R4_CUSTOMER_* configuration was provided');
  const leaked = GATEWAY_ONLY_ENV.filter((name) => options.customer!.env[name]?.trim());
  if (leaked.length > 0) throw refuse(`must not receive ${leaked.join(', ')}: they belong to the channel gateway only`);
  const fetch = { ...(options.customer.fetch ? { fetch: options.customer.fetch } : {}), ...(options.customer.allowedHosts ? { allowedHosts: options.customer.allowedHosts } : {}) };
  try {
    const [context, history] = composeSyntheticCustomerCapabilities({ env: options.customer.env, bindings: options.store, ...fetch });
    const identity = composeSyntheticIdentityVerificationCapabilities({ env: options.customer.env, bindings: options.store, pool: options.pool, ...fetch });
    capabilities.register(context);
    capabilities.register(history);
    capabilities.register(identity.reads[0]);
    capabilities.registerWrite(identity.writes[0]);
  } catch (error) {
    throw refuse(`cannot compose Customer and identity verification: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

/**
 * (R4-J4-R4) What a v8 process checks against the database before it starts (worker and gateway): the
 * identity-verification migrations are applied. Earlier profiles need nothing.
 */
export async function assertSalesProductionPrerequisites(profile: ProductionProfile, pool: pg.Pool): Promise<void> {
  if (!isCustomerIdentityProfile(profile)) return;
  if (!(await identityVerificationSchemaIsCurrent(pool))) throw new Error(`refusing production composition: ${profileLabel(profile)} needs the identity-verification migrations applied (identity_verification schema not current)`);
}

/**
 * How the channel ingress opens a Sales conversation task (deterministic in the binding; idempotent hook).
 * The task is pinned to the Sales definition version of the selected profile (R4-J2D): registering a newer
 * definition never switches a running profile, since an unpinned task would run the latest registered version.
 */
export function salesConversationTaskFactory(pool: pg.Pool, agentVersion: number): ConversationTaskFactory {
  const sales = new PostgresSalesStore(pool);
  return {
    requestedBy: SALES_CHANNEL_INGRESS,
    request: (binding) => ({ taskType: SALES_TASK_TYPE, agentId: SALES_AGENT_ID, agentVersion, goal: SALES_ROOT_GOAL, input: { channel: binding.channel, conversationBinding: binding.bindingId } }),
    // Customer identity is UNAVAILABLE in this profile: the conversation acts for an unknown customer.
    afterOpen: async (taskId, binding) => {
      await sales.bindConversation({ taskId, customerRef: null, channelRef: binding.channel });
    },
  };
}

export interface SalesGatewayOptions {
  readonly pool: pg.Pool;
  readonly production: { readonly config: ProductionConfig; readonly secrets: ProductionSecrets };
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Tests: an injected fetch (the adapter still refuses non-loopback URLs without the network opt-in). */
  readonly fetch?: FetchLike;
  /** (R4-J4-R4) Tests: the transport of the CIA confirm client (v8). */
  readonly identityFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** (R4-J4-R5 preparation) The isolated canary's closed test-host allowlist for the CIA confirm client. */
  readonly allowedHosts?: readonly string[];
}

/**
 * (R4-J5 P0, ADR-041) The notice the delivery owner sends once when a model failure hands the conversation to a
 * person (ADR-028 recovery exhausted, or a non-retryable model failure). Fixed text, never model output. It claims
 * no effect: whatever was or was not done (a quote, a verification) stays for the person to confirm.
 */
export const SALES_RUN_FAILURE_FALLBACK_TEXT =
  'Disculpa, tuve un problema técnico y no pude responder tu último mensaje. Ya avisé a una persona del equipo de PesasChile, que seguirá la conversación por este mismo chat. No hace falta que repitas lo que escribiste.';

/**
 * (F-ADV-2, ADR-041 extension) The notice the delivery owner sends once when the agent opens a human request (a
 * consultation or a handoff) without replying in that run, so the contact never waits in silence. Fixed text, never
 * model output; it claims no commercial effect: the answer, and any commercial resolution, stay with the person.
 */
export const SALES_HUMAN_REQUEST_NOTICE_TEXT =
  'Gracias por tu mensaje. Tu consulta quedó pendiente de revisión por una persona del equipo de PesasChile. La respuesta llegará por este mismo chat; no hace falta que repitas lo que escribiste.';

/** The profiles whose conversations get that notice: only the F1 quote lane candidate (@13 and the others unchanged). */
export const SALES_HUMAN_REQUEST_NOTICE_PROFILES: readonly string[] = Object.freeze([SALES_QUOTE_LANE_V17_PROFILE_LABEL, SALES_QUOTE_LANE_V18_PROFILE_LABEL, 'sales-production@19']);

/** Gateway bindings of the Sales canary: the WhatsApp Cloud adapter (canary number), the profile and the task factory. */
export function composeSalesGateway(options: SalesGatewayOptions): { bindings: GatewayBindings; whatsapp: WhatsAppCloudConfig; describe: Record<string, string | boolean> } {
  const config = assertProductionMode(options.production.config);
  const profile = selectedSalesProductionProfile(config);
  const whatsapp = loadWhatsAppCloudConfig(options.env, { allowNetwork: config.allowNetwork });
  const media = salesMediaPerception(options.env, whatsapp, config.allowNetwork, isCustomerIdentityProfile(profile));
  return {
    whatsapp,
    describe: { ...describeWhatsAppConfig(whatsapp), ...media.describe },
    bindings: {
      production: options.production,
      profile,
      inbound: [new WhatsAppInboundAdapter(whatsapp)],
      outbound: [new WhatsAppOutboundAdapter(whatsapp, options.fetch ? { fetch: options.fetch } : {})],
      taskFactory: salesConversationTaskFactory(options.pool, salesProductionAgentVersion(profile)),
      runFailureFallback: { text: SALES_RUN_FAILURE_FALLBACK_TEXT },
      humanRequestNotice: { text: SALES_HUMAN_REQUEST_NOTICE_TEXT, profiles: SALES_HUMAN_REQUEST_NOTICE_PROFILES },
      ...laneOf(salesGatewayLane(options.env, options.pool)),
      ...(media.perception ? { media: media.perception } : {}),
      // (R4-J4-R4) v8 never runs without the inbound inspector, requested in full (ADR-040).
      ...(isCustomerIdentityProfile(profile) ? { inspection: salesGatewayInspection(profile, options.env, { transport: options.identityFetch, allowedHosts: options.allowedHosts }) } : {}),
    },
  };
}

/**
 * (Inbound multimodal v1) Image and voice-note perception for the gateway, off unless R4_MEDIA_PERCEPTION=enabled.
 * The downloader holds the WhatsApp token; the describer (DeepSeek deepseek-flash) and the transcriber (OpenAI
 * gpt-transcribe) hold their own credentials, which only the gateway's environment carries (never the worker's).
 */
export function salesMediaPerception(env: Readonly<Record<string, string | undefined>>, whatsapp: WhatsAppCloudConfig, allowNetwork: boolean, inspected: boolean): { perception?: { perception: MediaPerception; profiles: readonly string[] }; describe: Record<string, string | boolean> } {
  const c = configuredMediaPerception(env, { allowNetwork, imageInstructions: SALES_IMAGE_PERCEPTION_INSTRUCTIONS });
  if (!c.enabled) return { describe: c.description };
  // Opt-in per profile (never the whole gateway): every other profile keeps holding media for a person, as before.
  const profiles = [...new Set((env.R4_MEDIA_PERCEPTION_PROFILES ?? '').split(/[\s,]+/).map((p) => p.trim()).filter(Boolean))];
  const known = new Set([...SALES_PRODUCTION_PROFILES, ...SALES_LANE_PROFILES].map(profileLabel));
  if (profiles.length === 0 || profiles.some((p) => !known.has(p))) throw new Error(`refusing media perception: R4_MEDIA_PERCEPTION_PROFILES must list Sales profiles (${[...known].join(', ')})`);
  // The ADR-040 inspector covers text only: with it, the ingress never perceives media (and says so here).
  if (inspected) return { describe: { ...c.description, mediaPerception: 'off_inspector_composed' } };
  const perception = new SalesMediaPerceiver({
    downloader: new WhatsAppMediaDownloader(whatsapp),
    ...(c.describer ? { describer: c.describer } : {}),
    ...(c.transcriber ? { transcriber: c.transcriber } : {}),
    transcriptionPrompt: c.transcriptionPromptOverride ?? SALES_TRANSCRIPTION_PROMPT,
  });
  return { perception: { perception, profiles }, describe: { ...c.description, mediaPerceptionProfiles: profiles.join(','), mediaPerceptionKinds: [...perception.kinds].join(',') || 'none' } };
}

/** (ADR-045) The lane variables of the gateway: both set (the lane) or neither (exactly R4-I). */
export const SALES_LANE_ENV = ['R4_PROD_LANE_PROFILE', 'R4_PROD_LANE_ALLOWLIST'] as const;

/**
 * (ADR-045) The gateway's lane: a lane profile (sales-production@13) for an explicit list of conversation keys, each
 * of which ChannelIngress also requires to be allowlisted in the rollout. Refuses partial or malformed configuration.
 */
export function salesGatewayLane(env: Readonly<Record<string, string | undefined>>, pool: pg.Pool): ConversationLane | undefined {
  const label = env.R4_PROD_LANE_PROFILE?.trim() ?? '';
  const raw = env.R4_PROD_LANE_ALLOWLIST?.trim() ?? '';
  if (label === '' && raw === '') return undefined;
  if (label === '' || raw === '') throw new Error(`refusing the gateway lane: ${SALES_LANE_ENV.join(' and ')} are set together or not at all`);
  const profile = SALES_LANE_PROFILES.find((p) => profileLabel(p) === label);
  if (!profile) throw new Error(`refusing the gateway lane: R4_PROD_LANE_PROFILE=${label} is not a Sales lane profile (${SALES_LANE_PROFILES.map(profileLabel).join(', ')})`);
  const keys = [...new Set(raw.split(/[\s,]+/).map((k) => k.trim().toLowerCase()).filter(Boolean))];
  if (keys.some((k) => !/^[0-9a-f]{64}$/.test(k))) throw new Error('refusing the gateway lane: R4_PROD_LANE_ALLOWLIST must list 64-hex conversation keys (--identity-key)');
  return { conversationKeys: keys, profile, taskFactory: salesConversationTaskFactory(pool, salesProductionAgentVersion(profile)) };
}

function laneOf(lane: ConversationLane | undefined): { lane?: ConversationLane } {
  return lane ? { lane } : {};
}

/**
 * (R4-J3E-C1) Quote V2 with its only mutation, createAndIssue, behind the kill switch: the guard re-reads the
 * durable autonomy controls immediately before every call (never cached; unreadable = engaged) and refuses with
 * "definitely not sent" instead of calling the owner. The reads (idempotency lookup, quote, operation, document)
 * stay open, so reconciliation and document verification keep working while the switch is engaged.
 *
 * The port is first adapted to plain functions: guardProductionWrites returns non-write methods unbound, so a
 * port that keeps its state in private class fields (QuoteV2HttpClient) would fail on every read through it.
 */
export function killSwitchGuardedQuotes(quotes: QuoteV2Service, controls: AutonomyControls, logger: Logger): QuoteV2Service {
  const port: QuoteV2Service = {
    createAndIssue: (...a) => quotes.createAndIssue(...a),
    getQuote: (...a) => quotes.getQuote(...a),
    getOperation: (...a) => quotes.getOperation(...a),
    lookupIdempotency: (...a) => quotes.lookupIdempotency(...a),
    getDocument: (...a) => quotes.getDocument(...a),
  };
  return guardProductionWrites(port, { domain: SALES_DOMAINS.quote, writeOperations: ['createAndIssue'], controls, logger, blocked: () => quoteWritesBlockedError() });
}

/** (F1 commercial eligibility) The policy the F1 candidate @17 enforces at quote.preview and quote.create; null elsewhere. */
export function salesCommercialEligibility(profile: ProductionProfile): CommercialEligibility | null {
  if (!SALES_VARIANT_AVAILABILITY_PROFILES.has(profileLabel(profile))) return null;
  // (owner decision 2026-11-10) @19: F1 policy v2, delivery at the Shipping owner price; @17/@18 keep v1 (no delivery).
  return SALES_F1_SHIPPING_PROFILES.has(profileLabel(profile)) ? { policyVersion: F1_COMMERCIAL_POLICY_V2_VERSION, shippingAllowed: true } : { policyVersion: F1_COMMERCIAL_POLICY_VERSION };
}

/** The Quote V2 port quote.create@5 uses: behind the kill switch; for the F1 profiles also single-flight (see below). */
export function salesQuotePort(profile: ProductionProfile, quotes: QuoteV2Service, controls: AutonomyControls, pool: pg.Pool, logger: Logger): QuoteV2Service {
  const guarded = killSwitchGuardedQuotes(quotes, controls, logger);
  return isF1CanaryProfile(profile) || isQuoteLaneProfile(profile) ? singleFlightQuoteIssuance(guarded, pool) : guarded;
}

/** (F1 concurrency) The advisory-lock key of Quote V2 issuance (database-wide, like the autonomous-decision lock). */
export const QUOTE_ISSUANCE_LOCK = 'sales.quote_v2_issuance';
/** How long an issuance waits for the one in flight before it is held (definitely not sent) on its own key. */
export const QUOTE_ISSUANCE_LOCK_WAIT_MS = 20_000;

/**
 * (F1 concurrency) Quote V2 with at most ONE createAndIssue in flight across every worker and process that shares the
 * production database: a session advisory lock (the existing coordination mechanism of this database, as for the
 * autonomous decisions) is held on a dedicated connection for the duration of the owner call. A worker that dies
 * releases it with its connection. A wait longer than `waitMs` fails BEFORE calling the owner as
 * temporarily_unavailable: quote.create holds the command on its key (reconcile, then the same key and body again),
 * so a wait never duplicates nor strands an issuance. Reads are never serialized.
 */
export function singleFlightQuoteIssuance(quotes: QuoteV2Service, pool: pg.Pool, waitMs = QUOTE_ISSUANCE_LOCK_WAIT_MS): QuoteV2Service {
  return {
    getQuote: (...a) => quotes.getQuote(...a),
    getOperation: (...a) => quotes.getOperation(...a),
    lookupIdempotency: (...a) => quotes.lookupIdempotency(...a),
    getDocument: (...a) => quotes.getDocument(...a),
    createAndIssue: async (...a) => {
      const client = await pool.connect();
      let locked = false;
      let broken = false;
      try {
        await client.query("select set_config('lock_timeout', $1, false)", [`${waitMs}ms`]);
        try {
          await client.query('select pg_advisory_lock(hashtextextended($1, 8))', [QUOTE_ISSUANCE_LOCK]);
          locked = true;
        } catch (error) {
          if ((error as { code?: string }).code === '55P03') throw new DomainError('temporarily_unavailable', 'quote_issuance_busy', `another Quote V2 issuance is in flight (waited ${waitMs} ms); nothing was sent`);
          throw error;
        }
        return await quotes.createAndIssue(...a);
      } finally {
        if (locked) await client.query('select pg_advisory_unlock(hashtextextended($1, 8))', [QUOTE_ISSUANCE_LOCK]).catch(() => (broken = true));
        await client.query('reset lock_timeout').catch(() => (broken = true));
        // A connection that could not release the lock is destroyed, which releases it.
        client.release(broken);
      }
    },
  };
}

/** (R4 Checkout) Checkout with its commands behind the kill switch (re-read before every call; unreadable = engaged); reads stay open. */
export function killSwitchGuardedCheckout(checkout: CheckoutService, controls: AutonomyControls, logger: Logger): CheckoutService {
  const port: CheckoutService = {
    createSession: (...a) => checkout.createSession(...a),
    getSession: (...a) => checkout.getSession(...a),
    prepareSession: (...a) => checkout.prepareSession(...a),
    createPaymentAttempt: (...a) => checkout.createPaymentAttempt(...a),
    listPaymentAttempts: (...a) => checkout.listPaymentAttempts(...a),
    getOrders: (...a) => checkout.getOrders(...a),
  };
  return guardProductionWrites(port, { domain: SALES_DOMAINS.checkout, writeOperations: ['createSession', 'prepareSession', 'createPaymentAttempt'], controls, logger, blocked: () => new DomainError('conflict', 'OPERATIONAL_GATE_BLOCKED', 'Checkout commands are stopped by the kill switch; nothing was sent') });
}

function isV6Limits(limits: AutonomousQuoteLimits | AutonomousQuoteLimitsV6): limits is AutonomousQuoteLimitsV6 {
  return 'maxTotalUnits' in limits && 'confirmationWindowSeconds' in limits;
}

