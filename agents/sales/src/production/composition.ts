import type pg from 'pg';
import type { Logger } from 'pino';
import { DomainError, type CatalogService } from '@r4-adapters/domains';
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
  type ProductionConfig,
  type ProductionSecrets,
  type ProductionStore,
} from '@r4/live-ops';
import type { WorkerBindings } from '@r4/worker';
import type { GatewayBindings } from '@r4/channel-gateway';
import { workspaceCapability } from '../capabilities/workspace.js';
import { SALES_AGENT_ID, SALES_TASK_TYPE, CAPABILITY_IDS } from '../ids.js';
import { SALES_ROOT_GOAL } from '../goal.js';
import { SalesWorkspaceContextSource } from '../workspace/context-source.js';
import { PostgresSalesStore } from '../workspace/store.js';
import { SALES_DOMAINS, SALES_PRODUCTION_ACTION_POLICY, SALES_PRODUCTION_PROFILE } from './profile.js';

/** Who opens production Sales conversations: the channel ingress (a platform service, never the model). */
export const SALES_CHANNEL_INGRESS: Principal = { kind: 'service', ref: 'sales-channel-ingress' };

/**
 * A Catalog port for a deployment where Catalog is UNAVAILABLE: every call is
 * refused before any effect, classified like an owner outage. It exists only
 * because the (internal) workspace capability validates product ids against
 * Catalog; with it, selections are refused honestly instead of accepted
 * against fixture data.
 */
export const UNAVAILABLE_CATALOG: CatalogService & { readonly bindingKind: 'unavailable' } = Object.freeze({
  bindingKind: 'unavailable' as const,
  search(): Promise<never> {
    return Promise.reject(new DomainError('temporarily_unavailable', 'catalog_unavailable', 'the catalog is not available in this deployment'));
  },
  getProduct(): Promise<never> {
    return Promise.reject(new DomainError('temporarily_unavailable', 'catalog_unavailable', 'the catalog is not available in this deployment'));
  },
});

export interface SalesProductionWorkerOptions {
  readonly pool: pg.Pool;
  /** The durable production store (autonomy controls, delivery state), composed by the deployment. */
  readonly store: ProductionStore;
  readonly production: { readonly config: ProductionConfig };
  readonly modelProvider: ModelProvider;
  readonly logger: Logger;
  readonly clock?: Clock;
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
 *   actionPolicy  SALES_PRODUCTION_ACTION_POLICY (R4-D governs every proposal)
 *   admission     the durable kill switch, asked before every claim
 *   context       + the delivery state of earlier responses (honest: sent ≠ received)
 *   presence      production mode + the profile version (execution-contract compatibility)
 * and refuses to compose unless production is proven, the profile is the
 * declared one, and every registered capability is available.
 */
export function composeSalesProductionWorker(options: SalesProductionWorkerOptions): SalesProductionWorker {
  const config = assertProductionMode(options.production.config);
  const profile = SALES_PRODUCTION_PROFILE;
  if (profileLabel(profile) !== config.policyProfile) throw new Error(`refusing production composition: R4_PROD_POLICY_PROFILE=${config.policyProfile} but the Sales pack provides ${profileLabel(profile)}`);
  const clock = options.clock ?? systemClock;
  const sales = new PostgresSalesStore(options.pool);
  const controls = new AutonomyControls({ store: options.store, logger: options.logger });
  const capabilities = new CapabilityRegistry();
  if (capabilityAvailability(profile, CAPABILITY_IDS.workspaceUpdate).available) {
    capabilities.registerWrite(workspaceCapability({ store: sales, catalog: UNAVAILABLE_CATALOG, clock }));
  }
  // Customer / Catalog / Shipping / Quote are UNAVAILABLE in this profile: their capabilities are deliberately not registered.
  const report = assertProductionComposition(profile, [{ domain: SALES_DOMAINS.workspace, bindingKind: 'internal' }, { domain: SALES_DOMAINS.catalog, bindingKind: UNAVAILABLE_CATALOG.bindingKind }], capabilities.list().map((c) => c.capabilityId));
  return {
    report,
    controls,
    bindings: {
      modelProvider: options.modelProvider,
      capabilities,
      contextSources: [new SalesWorkspaceContextSource(sales), new DeliveryStateContextSource(options.store)],
      actionPolicy: SALES_PRODUCTION_ACTION_POLICY,
      admission: controls,
      presence: { executionMode: 'production', runtimeProfile: profileLabel(profile) },
    },
  };
}

/** How the channel ingress opens a Sales conversation task (deterministic in the binding; idempotent hook). */
export function salesConversationTaskFactory(pool: pg.Pool): ConversationTaskFactory {
  const sales = new PostgresSalesStore(pool);
  return {
    requestedBy: SALES_CHANNEL_INGRESS,
    request: (binding) => ({ taskType: SALES_TASK_TYPE, agentId: SALES_AGENT_ID, goal: SALES_ROOT_GOAL, input: { channel: binding.channel, conversationBinding: binding.bindingId } }),
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
  const whatsapp = loadWhatsAppCloudConfig(options.env, { allowNetwork: config.allowNetwork });
  return {
    whatsapp,
    describe: describeWhatsAppConfig(whatsapp),
    bindings: {
      production: options.production,
      profile: SALES_PRODUCTION_PROFILE,
      inbound: [new WhatsAppInboundAdapter(whatsapp)],
      outbound: [new WhatsAppOutboundAdapter(whatsapp, options.fetch ? { fetch: options.fetch } : {})],
      taskFactory: salesConversationTaskFactory(options.pool),
    },
  };
}
