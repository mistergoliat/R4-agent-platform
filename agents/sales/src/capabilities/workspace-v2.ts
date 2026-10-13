import { z } from 'zod';
import { DomainError, type CatalogPort, type ShippingService } from '@r4-adapters/domains';
import type { WriteCapabilityRegistration, WriteExecutionResult } from '@r4/capability-runtime';
import type { Clock } from '@r4/contracts';
import { introducedProducts, selectionOf, workspaceUpdateV2InputSchema, type WorkspaceUpdateV2Input } from '../workspace/model.js';
import type { PostgresSalesStore, StoredWorkspaceResult } from '../workspace/store.js';
import { resolveOrderBasis } from './shipping-basis.js';
import { outputOf, workspaceCapability, workspaceUpdateOutput } from './workspace.js';

export const workspaceUpdateV2Output = workspaceUpdateOutput.extend({
  shipping: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('selected'), commune: z.string(), carrierName: z.string(), serviceType: z.string(), agreedOwnerNetClp: z.int().nonnegative() }),
      z.strictObject({ kind: z.literal('excluded') }),
    ])
    .nullable(),
  quoteRequest: z.strictObject({ previewId: z.string(), customerWords: z.string() }).nullable(),
});
export type WorkspaceUpdateV2Output = z.infer<typeof workspaceUpdateV2Output>;

/**
 * sales.workspace.update@2 (R4-J3E, sales-production@5 only): version 1 plus
 * the customer's delivery choice and quote request. Any change of items,
 * quantities or destination clears both, so a choice can never be carried
 * over to a different order. A shipping choice must be an offer the Shipping
 * owner makes NOW for the current selection and destination at the stated
 * NET: it is re-quoted before anything is written, and applied only if the
 * workspace did not change meanwhile. Version 1 is unchanged.
 */
export function workspaceCapabilityV2(deps: { store: PostgresSalesStore; catalog: CatalogPort; shipping: ShippingService; clock: Clock }): WriteCapabilityRegistration<WorkspaceUpdateV2Input, WorkspaceUpdateV2Output> {
  const { store, catalog, shipping, clock } = deps;
  const v1 = workspaceCapability({ store, catalog, clock });
  return {
    definition: {
      ...v1.definition,
      version: 2,
      description: `${v1.definition.description} Also: select_shipping_offer (the offer the customer chose among the shipping.quote basis=order offers for the CURRENT selection and destination: carrierName, serviceType and ownerNetClp = price.ownerNet.amount; in its own update, after the items and destination are final; refused when the Shipping owner does not make that offer now), exclude_shipping (the customer wants no delivery; only without a destination), record_quote_request (the customer asked for the quote shown by quote.preview: its previewId and the customer's own words). Changing items, quantities or the destination clears the shipping choice and the quote request.`,
    },
    recovery: 'idempotent_replay',
    input: workspaceUpdateV2InputSchema,
    output: workspaceUpdateV2Output,
    async execute(input, context) {
      const options = { signal: context.signal, correlationId: context.execution.correlationId };
      const unknownProducts: string[] = [];
      const variantRequired: string[] = [];
      let requireVersion: number | undefined;
      try {
        for (const itemKey of introducedProducts(input)) {
          const item = await catalog.getItemContext({ itemKey, quantity: 1 }, options);
          if (item.status === 'not_found') unknownProducts.push(itemKey);
          else if (item.status === 'variant_required') variantRequired.push(itemKey);
        }
        const choice = input.operations.find((op) => op.op === 'select_shipping_offer');
        if (choice) {
          const current = await store.workspace(context.execution.taskId);
          // A batch that also changes the order, or a workspace without a destination, is refused by the operations themselves.
          if (current.state.delivery && current.state.items.length > 0) {
            const basis = await resolveOrderBasis(catalog, selectionOf(current.state), options);
            const quote = await shipping.quote({ destination: { commune: current.state.delivery.commune }, basis: { type: 'order', ...basis } }, options);
            const offered = quote.serviceable && quote.offers.some((o) => o.carrierName === choice.carrierName && o.serviceType === choice.serviceType && o.price.ownerNet.amount === choice.ownerNetClp);
            if (!offered) {
              const same = quote.offers.find((o) => o.carrierName === choice.carrierName && o.serviceType === choice.serviceType);
              const message = same
                ? `the shipping owner now offers ${choice.carrierName} ${choice.serviceType} at ${same.price.ownerNet.amount} CLP net for this order`
                : `the shipping owner does not offer ${choice.carrierName} ${choice.serviceType} for this order and destination`;
              return { status: 'rejected', code: 'shipping_offer_not_offered', message, details: { currentOwnerNet: same?.price.ownerNet.amount ?? null } };
            }
            requireVersion = current.version;
          }
        }
      } catch (error) {
        // Nothing was written yet: an owner outage here is a definitive "no effect".
        if (error instanceof DomainError) return { status: 'failed', code: 'owner_unavailable', message: `the owners could not verify this update: ${error.message}`, details: { category: error.category } };
        throw error;
      }
      if (variantRequired.length > 0) {
        return { status: 'rejected', code: 'variant_required', message: `${variantRequired.join(', ')} ${variantRequired.length === 1 ? 'is a product' : 'are products'} with variants: select one variant's itemKey`, details: { itemKeys: variantRequired.join(',') } };
      }
      const { result, replayed } = await store.applyCommand({ taskId: context.execution.taskId, executionKey: context.executionKey, input, unknownProducts, now: clock.now().toISOString(), ...(requireVersion !== undefined ? { requireVersion } : {}) });
      return answerOf(context.execution.taskId, context.executionKey, result, replayed);
    },
    async reconcile(context) {
      const transition = await store.transitionByKey(context.executionKey);
      return transition ? answerOf(context.execution.taskId, context.executionKey, transition.result, true) : { status: 'not_applied' };
    },
  };
}

function answerOf(taskId: string, executionKey: string, result: StoredWorkspaceResult, replayed: boolean): WriteExecutionResult<WorkspaceUpdateV2Output> {
  if (result.status === 'rejected') {
    return { status: 'rejected', code: result.code, message: result.message, details: { operationIndex: result.operationIndex, workspaceVersion: result.version } };
  }
  const shipping = result.state.shipping ?? null;
  const request = result.state.quoteRequest ?? null;
  return {
    status: 'applied',
    result: {
      ...outputOf(result.version, result.operations, result.state),
      shipping:
        shipping === null
          ? null
          : shipping.kind === 'selected'
            ? { kind: 'selected', commune: shipping.commune, carrierName: shipping.carrierName, serviceType: shipping.serviceType, agreedOwnerNetClp: shipping.agreedOwnerNetClp }
            : { kind: 'excluded' },
      quoteRequest: request === null ? null : { previewId: request.previewId, customerWords: request.customerWords },
    },
    resourceRef: `sales-workspace:${taskId}@v${result.version}`,
    externalOperationRef: executionKey,
    replayed,
  };
}
