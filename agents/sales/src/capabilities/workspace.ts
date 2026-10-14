import { z } from 'zod';
import { DomainError, type CatalogPort } from '@r4-adapters/domains';
import type { WriteCapabilityRegistration, WriteExecutionResult } from '@r4/capability-runtime';
import type { Clock } from '@r4/contracts';
import { CAPABILITY_IDS, SCOPES } from '../ids.js';
import { factValueSchema, introducedProducts, selectionOf, workspaceUpdateInputSchema, type WorkspaceState, type WorkspaceUpdateInput } from '../workspace/model.js';
import type { PostgresSalesStore, StoredWorkspaceResult } from '../workspace/store.js';

export const workspaceUpdateOutput = z.strictObject({
  workspaceVersion: z.int().positive(),
  operationsApplied: z.int().positive(),
  selection: z.array(z.strictObject({ productId: z.string(), quantity: z.int().positive() })),
  facts: z.record(z.string(), factValueSchema),
  deliveryDestination: z.strictObject({ commune: z.string(), region: z.string().nullable() }).nullable(),
});
export type WorkspaceUpdateOutput = z.infer<typeof workspaceUpdateOutput>;

/**
 * The only way the agent changes Sales state: a governed REVERSIBLE_WRITE
 * (propose_action → policy → command → receipt). Each command applies at most
 * once per platform execution key (the store records the key atomically with
 * the change); replaying the key returns the original answer. New item
 * keys are verified with the Catalog owner first (item context), so a
 * made-up key is refused instead of entering the selection, and a product
 * whose variant has not been chosen is refused as not yet sellable — the
 * pack never picks a variant.
 */
export function workspaceCapability(deps: { store: PostgresSalesStore; catalog: CatalogPort; clock: Clock }): WriteCapabilityRegistration<WorkspaceUpdateInput, WorkspaceUpdateOutput> {
  const { store, catalog, clock } = deps;
  return {
    definition: {
      capabilityId: CAPABILITY_IDS.workspaceUpdate,
      version: 1,
      description:
        'Records changes to this conversation\'s Sales workspace with explicit operations, applied together or not at all: record_fact / retract_fact (customer-stated constraints and preferences; recording an existing key replaces its value), set_delivery_destination / clear_delivery_destination, add_item / remove_item / set_item_quantity / replace_item (items under consideration, by the catalog sellable item key: a product sellableItemKey, or the itemKey of the chosen variant — never a SKU). Adding an already selected item, or changing or replacing one that is not selected, is rejected. Holds no prices.',
      owner: 'sales',
      riskClass: 'REVERSIBLE_WRITE',
      requiredScopes: [SCOPES.workspaceWrite],
      identityRequirement: 'none',
      confirmationPolicy: 'none',
      approvalPolicy: 'none',
      idempotency: 'key_required',
      retryPolicy: { maxAttempts: 3, initialBackoffMs: 0 },
      timeoutMs: 10_000,
      freshnessTtlMs: null,
      auditLevel: 'full',
    },
    recovery: 'idempotent_replay',
    input: workspaceUpdateInputSchema,
    output: workspaceUpdateOutput,
    async execute(input, context) {
      let unknownProducts: string[];
      const variantRequired: string[] = [];
      try {
        unknownProducts = [];
        for (const itemKey of introducedProducts(input)) {
          const item = await catalog.getItemContext({ itemKey, quantity: 1 }, { signal: context.signal, correlationId: context.execution.correlationId });
          if (item.status === 'not_found') unknownProducts.push(itemKey);
          else if (item.status === 'variant_required') variantRequired.push(itemKey);
        }
      } catch (error) {
        // Nothing was written yet: a catalog outage here is a definitive "no effect".
        if (error instanceof DomainError) return { status: 'failed', code: 'catalog_unavailable', message: `products could not be verified: ${error.message}`, details: { category: error.category } };
        throw error;
      }
      // Nothing was written: a product key whose variant is not chosen is not a sellable item.
      if (variantRequired.length > 0) return { status: 'rejected', code: 'variant_required', message: `${variantRequired.join(', ')} ${variantRequired.length === 1 ? 'is a product' : 'are products'} with variants: select one variant's itemKey`, details: { itemKeys: variantRequired.join(',') } };
      const { result, replayed } = await store.applyCommand({ taskId: context.execution.taskId, executionKey: context.executionKey, input, unknownProducts, now: clock.now().toISOString() });
      return answerOf(context.execution.taskId, context.executionKey, result, replayed);
    },
    async reconcile(context) {
      const transition = await store.transitionByKey(context.executionKey);
      return transition ? answerOf(context.execution.taskId, context.executionKey, transition.result, true) : { status: 'not_applied' };
    },
  };
}

function answerOf(taskId: string, executionKey: string, result: StoredWorkspaceResult, replayed: boolean): WriteExecutionResult<WorkspaceUpdateOutput> {
  if (result.status === 'rejected') {
    return { status: 'rejected', code: result.code, message: result.message, details: { operationIndex: result.operationIndex, workspaceVersion: result.version } };
  }
  return { status: 'applied', result: outputOf(result.version, result.operations, result.state), resourceRef: `sales-workspace:${taskId}@v${result.version}`, externalOperationRef: executionKey, replayed };
}

export function outputOf(version: number, operations: number, state: WorkspaceState): WorkspaceUpdateOutput {
  return {
    workspaceVersion: version,
    operationsApplied: operations,
    selection: selectionOf(state),
    facts: Object.fromEntries(Object.entries(state.facts).map(([key, fact]) => [key, fact.value])),
    deliveryDestination: state.delivery ? { commune: state.delivery.commune, region: state.delivery.region } : null,
  };
}
