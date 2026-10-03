import type pg from 'pg';
import type { CatalogPort, CustomerDirectory, QuoteService, ShippingService } from '@r4-adapters/domains';
import { CapabilityRegistry } from '@r4/capability-runtime';
import { systemClock, type Clock } from '@r4/contracts';
import type { ModelProvider } from '@r4/model-gateway';
import type { WorkerBindings } from '@r4/worker';
import { catalogCapabilities } from './capabilities/catalog.js';
import { customerCapability } from './capabilities/customer.js';
import { quoteCapability } from './capabilities/quote.js';
import { shippingCapability } from './capabilities/shipping.js';
import { workspaceCapability } from './capabilities/workspace.js';
import { SALES_ACTION_POLICY } from './policy.js';
import { SalesWorkspaceContextSource } from './workspace/context-source.js';
import { PostgresSalesStore } from './workspace/store.js';

/** The domain owners the pack talks to — each behind its port (fixtures today; live adapters pending). */
export interface SalesDomains {
  readonly customers: CustomerDirectory;
  readonly catalog: CatalogPort;
  readonly shipping: ShippingService;
  readonly quotes: QuoteService;
}

export interface SalesCompositionOptions {
  /** Pool over the database that holds the `sales` schema (0006). */
  readonly pool: pg.Pool;
  readonly domains: SalesDomains;
  readonly modelProvider: ModelProvider;
  readonly clock?: Clock;
}

export interface SalesComposition {
  readonly bindings: WorkerBindings;
  readonly store: PostgresSalesStore;
  readonly capabilities: CapabilityRegistry;
}

/**
 * Sales application composition: everything the pack plugs into a generic
 * R4 worker through its public seams — capabilities (registered, not Core),
 * one context source for the Sales workspace, and the pack's action policy.
 * The worker, kernel, context compiler and runtimes are used unchanged.
 */
export function composeSales(options: SalesCompositionOptions): SalesComposition {
  const clock = options.clock ?? systemClock;
  const store = new PostgresSalesStore(options.pool);
  const { customers, catalog, shipping, quotes } = options.domains;
  const capabilities = new CapabilityRegistry();
  const [catalogSearch, productContext] = catalogCapabilities(catalog);
  capabilities.register(customerCapability(customers, store));
  capabilities.register(catalogSearch);
  capabilities.register(productContext);
  capabilities.register(shippingCapability(shipping, catalog));
  capabilities.registerWrite(workspaceCapability({ store, catalog, clock }));
  capabilities.registerWrite(quoteCapability({ store, quotes }));
  return {
    store,
    capabilities,
    bindings: {
      modelProvider: options.modelProvider,
      capabilities,
      contextSources: [new SalesWorkspaceContextSource(store)],
      actionPolicy: SALES_ACTION_POLICY,
    },
  };
}
