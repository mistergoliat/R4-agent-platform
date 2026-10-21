import { CustomerProfileHttpClient, loadCustomerProfileHttpConfig, type CustomerProfileCallTelemetry } from '@r4-adapters/customer-http';
import { CiaVerificationStartClient, CustomerIdentityHttpClient, loadCustomerIdentityHttpConfig, type CiaStartCallTelemetry, type CustomerIdentityCallTelemetry } from '@r4-adapters/identity-http';
import { IdentityVerificationStore } from '@r4-adapters/identity-verification';
import type { ProductionStore } from '@r4/live-ops';
import { CustomerCapabilityCompositionError } from './customer-v2.js';
import { IDENTITY_VERIFICATION_ACTION_POLICY, identityStartVerificationCapability, identityVerificationStatusCapability, type VerificationRecords } from './identity-verification.js';
import { customerContextV3Capability, customerPurchaseHistoryV2Capability } from './customer-v3.js';

/**
 * R4-J4-R3 (R3.5): the ONLY composition that registers the Customer capabilities: synthetic,
 * explicit, for tests and the R4 → CIA → CP campaign.
 * No production profile, CLI or bootstrap calls it (contract test customer-http-contract.test.ts).
 *
 * SEC-S6 (RR-1): it registers `customer.get_context@3` and `customer.get_purchase_history@2`, which
 * revalidate the channel association (binding + task state) around every external call. The @2/@1
 * builders (customer-v2.ts) stay exported, but no composition registers them any more.
 *
 * Fail-closed (AG-1, AG-2): both adapter configurations must load (R4_CUSTOMER_MODE=synthetic,
 * loopback URLs: the CP network override is not offered here), both credentials must be synthetic,
 * and the trusted binding source and task state are mandatory. There is no fallback, no fixture
 * owner and no way to register one capability without the CIA, Customer Profile and their guards.
 */
export interface SyntheticCustomerCompositionOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly bindings: Pick<ProductionStore, 'bindingByTask' | 'taskState'>;
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
  return [customerContextV3Capability(deps), customerPurchaseHistoryV2Capability(deps)] as const;
}

/**
 * SEC-S5: the ONLY composition that registers `identity.start_verification@1` (governed write, with its
 * autonomous policy OA-05) and `identity.verification_status@1`. Synthetic and explicit, like the one above:
 * the CIA agent credential must be synthetic and on loopback (`R4_CUSTOMER_MODE=real` refused). It never
 * receives the code keyring or the channel-integration credential: those exist only in the gateway.
 */
export interface SyntheticIdentityVerificationCompositionOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly bindings: Pick<ProductionStore, 'bindingByTask' | 'taskState' | 'thread'>;
  /** The platform database (the identity_verification schema: expectations and the component mode). */
  readonly pool: ConstructorParameters<typeof IdentityVerificationStore>[0];
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly onStartCall?: (event: CiaStartCallTelemetry) => void;
  /** Tests against a CIA instance with a shorter resend interval only; the default is the contract's 60 s. */
  readonly resendIntervalMs?: number;
}

export function composeSyntheticIdentityVerificationCapabilities(options: SyntheticIdentityVerificationCompositionOptions) {
  const config = loadCustomerIdentityHttpConfig(options.env);
  const transport = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const adapt = (url: string, init: RequestInit) => transport(url, init).then((response) => ({ status: response.status, headers: response.headers, body: response.body }));
  const start = new CiaVerificationStartClient({ config, fetch: adapt, ...(options.onStartCall ? { onCall: options.onStartCall } : {}) });
  const store = new IdentityVerificationStore(options.pool);
  const verification: VerificationRecords = {
    mode: () => store.mode(),
    openExpectation: (input) => store.openExpectation(input),
    markIssued: (id, issued) => store.markIssued(id, issued),
    closeExpectation: (id, to, reason) => store.closeExpectation(id, to, reason),
    liveExpectation: (channel, key) => store.liveExpectation(options.pool, channel, key),
    latestForBinding: (bindingId) => store.latestForBinding(bindingId),
    codeNeeded: (expectationId) => store.codeNeeded(expectationId),
  };
  const deps = { bindings: options.bindings, verification, start, ...(options.resendIntervalMs === undefined ? {} : { resendIntervalMs: options.resendIntervalMs }) };
  return {
    reads: [identityVerificationStatusCapability(deps)] as const,
    writes: [identityStartVerificationCapability(deps)] as const,
    policy: IDENTITY_VERIFICATION_ACTION_POLICY,
  };
}
