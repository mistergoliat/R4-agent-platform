import type { z } from 'zod';
import type { CustomerIdentityResolver, CustomerProfilePort, CustomerPurpose, IdentityResolution } from '@r4-adapters/domains';
import type { CapabilityRegistration } from '@r4/capability-runtime';
import type { ProductionStore } from '@r4/live-ops';
import { CAPABILITY_IDS, SCOPES } from '../ids.js';
import { domainRead, readDefinition } from './common.js';
import {
  customerContextV2Input,
  customerContextV2Output,
  customerPurchaseHistoryV1Input,
  customerPurchaseHistoryV1Output,
  readCustomerContextV2,
  readCustomerPurchaseHistoryV1,
  type CustomerContextV2Output,
  type CustomerPurchaseHistoryV1Output,
} from './customer-profile-outputs.js';

/**
 * R4-J4-R3 (R3.4, R3.5): `customer.get_context@2` and `customer.get_purchase_history@1`
 * (specification R4-J4-R1 §6, §7; ADR-039). Building blocks only: NO production profile,
 * definition or registry binds them (sales-production@8 is J4-R4, not authorized). The only
 * composition that registers them is the synthetic one (customer-synthetic.ts), used by tests.
 *
 * Per invocation, never cached:
 *   1. the trusted binding of THIS task (`ProductionStore.bindingByTask`) gives the channel
 *      subject; no binding, or a closed one → `unavailable/anonymous` with no external call;
 *   2. the identity authority resolves the subject for THIS capability's purpose only;
 *   3. only `verified` reaches Customer Profile, with the customerRef and the grant in memory;
 *   4. the boundary-C reader projects the answer; the reference and the grant are dropped.
 * The inputs take no identifier: the customer never comes from the model, the transcript, the
 * workspace, memory or `task.requestedBy`.
 */

export const CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID = 'customer.get_purchase_history';

export interface CustomerCapabilityDependencies {
  readonly bindings: Pick<ProductionStore, 'bindingByTask'>;
  readonly identity: CustomerIdentityResolver;
  readonly profile: CustomerProfilePort;
  readonly now?: () => Date;
}

export class CustomerCapabilityCompositionError extends Error {
  override readonly name = 'CustomerCapabilityCompositionError';
}

/** AG-2: no capability exists without its three owners. */
function assertDependencies(deps: CustomerCapabilityDependencies): void {
  const missing = [
    typeof deps?.bindings?.bindingByTask !== 'function' && 'bindings',
    typeof deps?.identity?.resolve !== 'function' && 'identity',
    (typeof deps?.profile?.getSalesContext !== 'function' || typeof deps?.profile?.getPurchaseHistory !== 'function') && 'profile',
  ].filter(Boolean);
  if (missing.length > 0) throw new CustomerCapabilityCompositionError(`refusing to compose the Customer capabilities without ${missing.join(', ')}`);
}

async function resolveFor(deps: CustomerCapabilityDependencies, taskId: string, purpose: CustomerPurpose, options: { signal: AbortSignal; correlationId: string }): Promise<IdentityResolution | null> {
  const binding = await deps.bindings.bindingByTask(taskId);
  if (binding === null || binding.status !== 'open') return null;
  return deps.identity.resolve({ channel: binding.channel, accountRef: binding.accountRef, subjectRef: binding.recipientRef, sessionRef: binding.bindingId }, [purpose], options);
}

const ownerValidUntil = (output: CustomerContextV2Output | CustomerPurchaseHistoryV1Output) => (output.identity === 'verified' ? output.validUntil : null);

export function customerContextV2Capability(deps: CustomerCapabilityDependencies): CapabilityRegistration<z.infer<typeof customerContextV2Input>, CustomerContextV2Output> {
  assertDependencies(deps);
  const now = deps.now ?? (() => new Date());
  return {
    definition: {
      ...readDefinition({
        capabilityId: CAPABILITY_IDS.customerContext,
        description: 'Tells whether the customer of this conversation has a verified identity and a purchase history. Takes no arguments. unavailable never prevents helping or quoting as a guest. With withheld, do not speculate about the reason or mention it.',
        owner: 'customer',
        requiredScopes: [SCOPES.customerRead],
        freshnessTtlMs: 10 * 60_000,
      }),
      version: 2,
    },
    input: customerContextV2Input,
    output: customerContextV2Output,
    ownerValidUntil,
    handler: (_input, context) => domainRead(async () => {
      const options = { signal: context.signal, correlationId: context.execution.correlationId };
      const resolution = await resolveFor(deps, context.execution.taskId, 'sales_context', options);
      return readCustomerContextV2(resolution, deps.profile, { ...options, now: now() });
    }),
  };
}

export function customerPurchaseHistoryV1Capability(deps: CustomerCapabilityDependencies): CapabilityRegistration<z.infer<typeof customerPurchaseHistoryV1Input>, CustomerPurchaseHistoryV1Output> {
  assertDependencies(deps);
  const now = deps.now ?? (() => new Date());
  return {
    definition: {
      ...readDefinition({
        capabilityId: CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID,
        description: 'Lists products the customer of this conversation bought historically (a page of at most 10, offset up to 40). A past purchase does not mean current ownership or compatibility: use catalog.search for anything current. Quantities are gross units, not net of returns. Dates are the stored source day and may differ from the customer\'s local day. A null name is a product without a registered name. A new purchase between pages may duplicate or skip an item.',
        owner: 'customer',
        requiredScopes: [SCOPES.customerRead],
        freshnessTtlMs: 10 * 60_000,
      }),
      version: 1,
    },
    input: customerPurchaseHistoryV1Input,
    output: customerPurchaseHistoryV1Output,
    ownerValidUntil,
    handler: (input, context) => domainRead(async () => {
      const options = { signal: context.signal, correlationId: context.execution.correlationId };
      const resolution = await resolveFor(deps, context.execution.taskId, 'purchase_history', options);
      return readCustomerPurchaseHistoryV1(resolution, input, deps.profile, { ...options, now: now() });
    }),
  };
}
