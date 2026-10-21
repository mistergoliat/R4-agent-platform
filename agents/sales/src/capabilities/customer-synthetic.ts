import { CustomerProfileHttpClient, loadCustomerProfileHttpConfig, type CustomerProfileCallTelemetry } from '@r4-adapters/customer-http';
import { CustomerIdentityHttpClient, loadCustomerIdentityHttpConfig, type CustomerIdentityCallTelemetry } from '@r4-adapters/identity-http';
import type { ProductionStore } from '@r4/live-ops';
import { CustomerCapabilityCompositionError, customerContextV2Capability, customerPurchaseHistoryV1Capability } from './customer-v2.js';

/**
 * R4-J4-R3 (R3.5): the ONLY composition that registers `customer.get_context@2` and
 * `customer.get_purchase_history@1`: synthetic, explicit, for tests and the R4 → CIA → CP campaign.
 * No production profile, CLI or bootstrap calls it (contract test customer-http-contract.test.ts).
 *
 * Fail-closed (AG-1, AG-2): both adapter configurations must load (R4_CUSTOMER_MODE=synthetic,
 * loopback URLs: the CP network override is not offered here), both credentials must be synthetic,
 * and the trusted binding source is mandatory. There is no fallback, no fixture owner and no way to
 * register one capability without the CIA, Customer Profile and their guards.
 */
export interface SyntheticCustomerCompositionOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly bindings: Pick<ProductionStore, 'bindingByTask'>;
  /** Transport (default: the global fetch). Redirects are never followed by either adapter. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly onIdentityCall?: (event: CustomerIdentityCallTelemetry) => void;
  readonly onProfileCall?: (event: CustomerProfileCallTelemetry) => void;
  readonly now?: () => Date;
}

export function composeSyntheticCustomerCapabilities(options: SyntheticCustomerCompositionOptions) {
  const identityConfig = loadCustomerIdentityHttpConfig(options.env);
  const profileConfig = loadCustomerProfileHttpConfig(options.env, { allowNetwork: false });
  if (!profileConfig.bearerToken.startsWith('synthetic-')) {
    throw new CustomerCapabilityCompositionError('refusing a non-synthetic Customer Profile credential in the synthetic composition');
  }
  const transport = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const adapt = (url: string, init: RequestInit) => transport(url, init).then((response) => ({ status: response.status, headers: response.headers, body: response.body }));
  const identity = new CustomerIdentityHttpClient({ config: identityConfig, fetch: adapt, ...(options.onIdentityCall ? { onCall: options.onIdentityCall } : {}), ...(options.now ? { now: options.now } : {}) });
  const profile = new CustomerProfileHttpClient({ config: profileConfig, fetch: adapt, ...(options.onProfileCall ? { onCall: options.onProfileCall } : {}), ...(options.now ? { now: options.now } : {}) });
  const deps = { bindings: options.bindings, identity, profile, ...(options.now ? { now: options.now } : {}) };
  return [customerContextV2Capability(deps), customerPurchaseHistoryV1Capability(deps)] as const;
}
