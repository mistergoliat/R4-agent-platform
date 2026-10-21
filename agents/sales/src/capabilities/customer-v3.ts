import type { z } from 'zod';
import type { CustomerIdentityResolver, CustomerProfilePort, CustomerPurpose, IdentityResolution } from '@r4-adapters/domains';
import type { CapabilityRegistration } from '@r4/capability-runtime';
import { TERMINAL_TASK_STATUSES } from '@r4/contracts';
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
import { CUSTOMER_PURCHASE_HISTORY_CAPABILITY_ID, CustomerCapabilityCompositionError } from './customer-v2.js';

/**
 * R4-J4-SEC-OTP-ACCELERATED-IMPLEMENTATION-06 (SEC-S6, RR-1): `customer.get_context@3` and
 * `customer.get_purchase_history@2`. Same inputs, outputs, descriptions and projection as @2/@1
 * (customer-v2.ts, whose behavior is unchanged); the only difference is that the channel
 * association is revalidated around every external call (R4_J4_RR1_BINDING_RACE_ANALYSIS.md §4, §5.1):
 *
 *   V(taskId, b₀) ≡ bindingByTask(taskId).bindingId = b₀ ∧ status = 'open'
 *                 ∧ taskState(taskId).status ∉ {completed, cancelled, failed}
 *                 ∧ ¬terminalIntent ∧ ¬humanOwned (OA-09); a missing taskState fails V.
 *
 *   T1  b₀ ← bindingByTask; require V   → otherwise anonymous, no CIA and no CP call
 *   T2  CIA resolve
 *   T2' require V                       → otherwise the grant is dropped, anonymous, no CP call
 *   T4  CP read (boundary-C reader)
 *   T4' require V                       → otherwise the data is dropped, anonymous
 *
 * Building blocks only: the synthetic composition (customer-synthetic.ts) is the only one that
 * registers them; no production profile, definition, CLI or bootstrap does (J4-R4 is not authorized).
 */

export interface CustomerCapabilityV3Dependencies {
  readonly bindings: Pick<ProductionStore, 'bindingByTask' | 'taskState'>;
  readonly identity: CustomerIdentityResolver;
  readonly profile: CustomerProfilePort;
  readonly now?: () => Date;
}

/** AG-2: no capability exists without its owners, including the task state that V reads. */
function assertDependencies(deps: CustomerCapabilityV3Dependencies): void {
  const missing = [
    typeof deps?.bindings?.bindingByTask !== 'function' && 'bindings',
    typeof deps?.bindings?.taskState !== 'function' && 'taskState',
    typeof deps?.identity?.resolve !== 'function' && 'identity',
    (typeof deps?.profile?.getSalesContext !== 'function' || typeof deps?.profile?.getPurchaseHistory !== 'function') && 'profile',
  ].filter(Boolean);
  if (missing.length > 0) throw new CustomerCapabilityCompositionError(`refusing to compose the Customer capabilities without ${missing.join(', ')}`);
}

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_TASK_STATUSES);
const ANONYMOUS = { identity: 'unavailable', reason: 'anonymous' } as const;

/** V(taskId, b₀): read fresh on every call, never cached. */
async function associationValid(bindings: CustomerCapabilityV3Dependencies['bindings'], taskId: string, bindingId: string): Promise<boolean> {
  const binding = await bindings.bindingByTask(taskId);
  if (binding === null || binding.bindingId !== bindingId || binding.status !== 'open') return false;
  const task = await bindings.taskState(taskId);
  if (task === null || TERMINAL.has(task.status) || task.terminalIntent) return false;
  if (task.humanOwned) return false;
  return true;
}

async function revalidatedRead<O>(
  deps: CustomerCapabilityV3Dependencies,
  taskId: string,
  purpose: CustomerPurpose,
  options: { signal: AbortSignal; correlationId: string },
  read: (resolution: IdentityResolution) => Promise<O>,
): Promise<O | typeof ANONYMOUS> {
  const binding = await deps.bindings.bindingByTask(taskId);
  if (binding === null || binding.status !== 'open') return ANONYMOUS;
  if (!(await associationValid(deps.bindings, taskId, binding.bindingId))) return ANONYMOUS; // T1
  const resolution = await deps.identity.resolve({ channel: binding.channel, accountRef: binding.accountRef, subjectRef: binding.recipientRef, sessionRef: binding.bindingId }, [purpose], options);
  if (!(await associationValid(deps.bindings, taskId, binding.bindingId))) return ANONYMOUS; // T2'
  const output = await read(resolution);
  if (!(await associationValid(deps.bindings, taskId, binding.bindingId))) return ANONYMOUS; // T4'
  return output;
}

const ownerValidUntil = (output: CustomerContextV2Output | CustomerPurchaseHistoryV1Output) => (output.identity === 'verified' ? output.validUntil : null);

export function customerContextV3Capability(deps: CustomerCapabilityV3Dependencies): CapabilityRegistration<z.infer<typeof customerContextV2Input>, CustomerContextV2Output> {
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
      version: 3,
    },
    input: customerContextV2Input,
    output: customerContextV2Output,
    ownerValidUntil,
    handler: (_input, context) => domainRead(async () => {
      const options = { signal: context.signal, correlationId: context.execution.correlationId };
      return revalidatedRead(deps, context.execution.taskId, 'sales_context', options, (resolution) => readCustomerContextV2(resolution, deps.profile, { ...options, now: now() }));
    }),
  };
}

export function customerPurchaseHistoryV2Capability(deps: CustomerCapabilityV3Dependencies): CapabilityRegistration<z.infer<typeof customerPurchaseHistoryV1Input>, CustomerPurchaseHistoryV1Output> {
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
      version: 2,
    },
    input: customerPurchaseHistoryV1Input,
    output: customerPurchaseHistoryV1Output,
    ownerValidUntil,
    handler: (input, context) => domainRead(async () => {
      const options = { signal: context.signal, correlationId: context.execution.correlationId };
      return revalidatedRead(deps, context.execution.taskId, 'purchase_history', options, (resolution) => readCustomerPurchaseHistoryV1(resolution, input, deps.profile, { ...options, now: now() }));
    }),
  };
}
