import { z } from 'zod';
import { DomainError, type CatalogService } from '@r4-adapters/domains';
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
 * the change); replaying the key returns the original answer. New product
 * ids are verified with the Catalog owner first, so a made-up id is refused
 * instead of entering the selection.
 */
export function workspaceCapability(deps: { store: PostgresSalesStore; catalog: CatalogService; clock: Clock }): WriteCapabilityRegistration<WorkspaceUpdateInput, WorkspaceUpdateOutput> {
  const { store, catalog, clock } = deps;
  return {
    definition: {
      capabilityId: CAPABILITY_IDS.workspaceUpdate,
      version: 1,
      description:
        'Records changes to this conversation\'s Sales workspace with explicit operations, applied together or not at all: record_fact / retract_fact (customer-stated constraints and preferences; recording an existing key replaces its value), set_delivery_destination / clear_delivery_destination, add_item / remove_item / set_item_quantity / replace_item (products under consideration, by catalog product id). Adding an already selected item, or changing or replacing one that is not selected, is rejected. Holds no prices.',
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
      try {
        unknownProducts = [];
        for (const productId of introducedProducts(input)) {
          if ((await catalog.getProduct(productId, { signal: context.signal })) === null) unknownProducts.push(productId);
        }
      } catch (error) {
        // Nothing was written yet: a catalog outage here is a definitive "no effect".
        if (error instanceof DomainError) return { status: 'failed', code: 'catalog_unavailable', message: `products could not be verified: ${error.message}`, details: { category: error.category } };
        throw error;
      }
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

function outputOf(version: number, operations: number, state: WorkspaceState): WorkspaceUpdateOutput {
  return {
    workspaceVersion: version,
    operationsApplied: operations,
    selection: selectionOf(state),
    facts: Object.fromEntries(Object.entries(state.facts).map(([key, fact]) => [key, fact.value])),
    deliveryDestination: state.delivery ? { commune: state.delivery.commune, region: state.delivery.region } : null,
  };
}
