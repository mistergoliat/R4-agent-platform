import type pg from 'pg';
import type { Logger } from 'pino';
import { DomainError, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import { WhatsAppInboundAdapter, WhatsAppOutboundAdapter, describeWhatsAppConfig, loadWhatsAppCloudConfig, type FetchLike, type WhatsAppCloudConfig } from '@r4-adapters/whatsapp-cloud';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { systemClock, type Clock, type Principal } from '@r4/contracts';
import type { ModelProvider } from '@r4/model-gateway';
import {
  AutonomyControls,
  DeliveryStateContextSource,
  assertProductionComposition,
  assertProductionMode,
  capabilityAvailability,
  profileLabel,
  type ConversationTaskFactory,
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
import { isAutonomousQuoteProfile, salesProductionActionPolicy } from './profile-v5.js';
import { SALES_PRODUCTION_PROFILES, isConfirmedIntentProfile, salesProductionAgentVersion, salesProductionProfile } from './profile-v6.js';
import { catalogCapabilities } from '../capabilities/catalog.js';
import { shippingCapability } from '../capabilities/shipping.js';
import { quoteCreateV2Capability } from '../capabilities/quote-v2.js';
import { quoteCreateV3Capability } from '../capabilities/quote-v3.js';
import { quotePreviewCapability, quotePreviewV2Capability } from '../capabilities/quote-preview.js';
import { quoteCreateV4Capability } from '../capabilities/quote-v4.js';
import { workspaceCapabilityV2 } from '../capabilities/workspace-v2.js';
import type { AutonomousQuoteLimits, AutonomousQuoteLimitsV6 } from '../capabilities/autonomy-limits.js';

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
  /** The pc-carrier binding (ProductionShippingAdapter); required when the selected profile makes Shipping REAL (v3). */
  readonly shipping?: ShippingService & { readonly bindingKind: string };
  /** The Quote V2 binding (QuoteV2HttpClient); required when the selected profile makes Quote REAL (v4). */
  readonly quotes?: QuoteV2Service & { readonly bindingKind: string };
  /** (R4-J3E) The configured limits of autonomous issuance; required when the selected profile issues quotes autonomously (v5; v6 also needs the total-units limit and the confirmation window). */
  readonly autonomousQuoteLimits?: AutonomousQuoteLimits | AutonomousQuoteLimitsV6;
}

/** The Sales production profile the deployment declared, or a refusal (nothing is defaulted). */
export function selectedSalesProductionProfile(config: ProductionConfig): ProductionProfile {
  const profile = salesProductionProfile(config.policyProfile);
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
 *   actionPolicy  SALES_PRODUCTION_ACTION_POLICY (R4-D governs every proposal); v5 only:
 *                 SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY (ADR-034)
 *   admission     the durable kill switch, asked before every claim
 *   context       + the delivery state of earlier responses (honest: sent ≠ received)
 *   presence      production mode + the profile version (execution-contract compatibility)
 * and refuses to compose unless production is proven, the profile is the
 * declared one, and every registered capability is available.
 */
export function composeSalesProductionWorker(options: SalesProductionWorkerOptions): SalesProductionWorker {
  const config = assertProductionMode(options.production.config);
  const profile = selectedSalesProductionProfile(config);
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
    const [catalogSearch, productContext] = catalogCapabilities(catalog);
    capabilities.register(catalogSearch);
    capabilities.register(productContext);
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
        if (capabilityAvailability(profile, AUTONOMOUS_QUOTE_CAPABILITY_IDS.quotePreview).available) capabilities.register(quotePreviewV2Capability({ store: sales, catalog, shipping: options.shipping, limits, now: () => clock.now() }));
        if (capabilityAvailability(profile, CAPABILITY_IDS.quoteCreate).available) capabilities.registerWrite(quoteCreateV4Capability({ store: sales, quotes: options.quotes, catalog, shipping: options.shipping, limits, conversation: options.store, now: () => clock.now() }));
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
  // Customer (and Catalog under v1, Shipping under v1/v2, Quote under v1–v3) are UNAVAILABLE: their capabilities are deliberately not registered.
  const report = assertProductionComposition(
    profile,
    [
      { domain: SALES_DOMAINS.workspace, bindingKind: 'internal' },
      { domain: SALES_DOMAINS.catalog, bindingKind: catalogReal ? 'real' : UNAVAILABLE_CATALOG.bindingKind },
      ...(shippingReal ? [{ domain: SALES_DOMAINS.shipping, bindingKind: 'real' as const }] : []),
      ...(quoteReal ? [{ domain: SALES_DOMAINS.quote, bindingKind: 'real' as const }] : []),
    ],
    capabilities.list().map((c) => c.capabilityId),
  );
  return {
    report,
    controls,
    bindings: {
      modelProvider: options.modelProvider,
      capabilities,
      contextSources: [new SalesWorkspaceContextSource(sales), new DeliveryStateContextSource(options.store)],
      actionPolicy: salesProductionActionPolicy(profile),
      admission: controls,
      presence: { executionMode: 'production', runtimeProfile: profileLabel(profile) },
    },
  };
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
}

/** Gateway bindings of the Sales canary: the WhatsApp Cloud adapter (canary number), the profile and the task factory. */
export function composeSalesGateway(options: SalesGatewayOptions): { bindings: GatewayBindings; whatsapp: WhatsAppCloudConfig; describe: Record<string, string | boolean> } {
  const config = assertProductionMode(options.production.config);
  const profile = selectedSalesProductionProfile(config);
  const whatsapp = loadWhatsAppCloudConfig(options.env, { allowNetwork: config.allowNetwork });
  return {
    whatsapp,
    describe: describeWhatsAppConfig(whatsapp),
    bindings: {
      production: options.production,
      profile,
      inbound: [new WhatsAppInboundAdapter(whatsapp)],
      outbound: [new WhatsAppOutboundAdapter(whatsapp, options.fetch ? { fetch: options.fetch } : {})],
      taskFactory: salesConversationTaskFactory(options.pool, salesProductionAgentVersion(profile)),
    },
  };
}

function isV6Limits(limits: AutonomousQuoteLimits | AutonomousQuoteLimitsV6): limits is AutonomousQuoteLimitsV6 {
  return 'maxTotalUnits' in limits && 'confirmationWindowSeconds' in limits;
}
