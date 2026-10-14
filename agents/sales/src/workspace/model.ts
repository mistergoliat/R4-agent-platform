import { z } from 'zod';
import { CATALOG_KEY_PATTERN } from '@r4-adapters/domains';

/**
 * SalesWorkspace: the structured, durable working state of one Sales
 * conversation — Sales application state, not an R4 Core primitive and not
 * the AgentTask. It holds what the customer stated (facts such as budget,
 * space, preferences), where delivery goes, and which products are under
 * consideration with their quantities.
 *
 * It deliberately cannot hold domain truth: no price, stock, shipping cost,
 * quote number or total is representable here (those stay with their owners
 * and reach the agent only as observations). Quote *references* are written
 * separately, only by the quote capability from the Quote owner's answer.
 *
 * Every change is an explicit operation with one meaning. There is no
 * "set the selection to this array": adding an item already selected,
 * removing or re-quantifying one that is not, or replacing a missing one is
 * rejected, never silently reinterpreted. A batch applies atomically.
 */

/** Keys that would smuggle domain truth into Sales state. */
const DOMAIN_OWNED_FACT = /(price|precio|stock|quote|cotiz|total|cost|costo|discount|descuento)/;
export const factKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/, 'a lowercase snake_case key')
  .refine((key) => !DOMAIN_OWNED_FACT.test(key), 'prices, stock, costs, totals and quotes belong to their owners, not to the workspace');

/** A selection entry is the Catalog owner's opaque sellable-item key (field name kept for stored-state compatibility). */
export const productIdSchema = z.string().regex(CATALOG_KEY_PATTERN, 'a catalog item key');
const quantitySchema = z.int().min(1).max(99);
const scalar = z.union([z.string().trim().min(1).max(300), z.number().finite(), z.boolean()]);
export const factValueSchema = z.union([scalar, z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,31}$/), scalar).refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 8, 'an object fact has 1 to 8 fields')]);
const communeSchema = z.string().trim().min(2).max(80);

export const workspaceOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('record_fact'),
    key: factKeySchema,
    value: factValueSchema,
    /** Who stated it: the customer, or the agent's own recorded inference. */
    statedBy: z.enum(['customer', 'agent']),
    note: z.string().trim().min(1).max(300).optional(),
  }),
  z.strictObject({ op: z.literal('retract_fact'), key: factKeySchema }),
  z.strictObject({ op: z.literal('set_delivery_destination'), commune: communeSchema, region: z.string().trim().min(2).max(80).optional() }),
  z.strictObject({ op: z.literal('clear_delivery_destination') }),
  z.strictObject({ op: z.literal('add_item'), productId: productIdSchema, quantity: quantitySchema }),
  z.strictObject({ op: z.literal('remove_item'), productId: productIdSchema }),
  z.strictObject({ op: z.literal('set_item_quantity'), productId: productIdSchema, quantity: quantitySchema }),
  z.strictObject({ op: z.literal('replace_item'), productId: productIdSchema, withProductId: productIdSchema, quantity: quantitySchema }),
]);
export type WorkspaceOperation = z.infer<typeof workspaceOperationSchema>;

export const workspaceUpdateInputSchema = z.strictObject({
  operations: z.array(workspaceOperationSchema).min(1).max(10),
  /** Optional optimistic concurrency: apply only if the workspace is still at this version. */
  expectedVersion: z.int().min(0).optional(),
});
export type WorkspaceUpdateInput = z.infer<typeof workspaceUpdateInputSchema>;

/** A Quote-owner commercial snapshot id: lowercase SHA-256 hex (R4-J3E). */
export const previewIdSchema = z.string().regex(/^[0-9a-f]{64}$/, 'a quote.preview previewId');
const ownerLabel = z.string().trim().min(1).max(120);

/**
 * (R4-J3E) Operations only `sales.workspace.update@2` accepts — sales-production@5.
 * Version 1 keeps its exact schema: `workspaceOperationSchema` is unchanged.
 *
 * - select_shipping_offer: the customer's choice among the offers shipping.quote
 *   (basis=order) returned for the CURRENT selection and destination. The
 *   capability re-quotes the Shipping owner and refuses an offer it does not
 *   make now. It is cleared by any later change of items, quantities or destination.
 * - exclude_shipping: the customer explicitly wants no delivery (no destination recorded).
 * - record_quote_request: the customer asked for the quote shown by quote.preview,
 *   in their own words. It binds the request to that exact commercial snapshot.
 */
export const workspaceOperationV2Schema = z.discriminatedUnion('op', [
  ...workspaceOperationSchema.options,
  z.strictObject({ op: z.literal('select_shipping_offer'), carrierName: ownerLabel, serviceType: ownerLabel, ownerNetClp: z.int().min(0).max(100_000_000) }),
  z.strictObject({ op: z.literal('exclude_shipping') }),
  z.strictObject({ op: z.literal('record_quote_request'), previewId: previewIdSchema, customerWords: z.string().trim().min(2).max(300) }),
]);
export type WorkspaceOperationV2 = z.infer<typeof workspaceOperationV2Schema>;

export const workspaceUpdateV2InputSchema = z.strictObject({
  operations: z.array(workspaceOperationV2Schema).min(1).max(10),
  expectedVersion: z.int().min(0).optional(),
});
export type WorkspaceUpdateV2Input = z.infer<typeof workspaceUpdateV2InputSchema>;

/** Operations that change what would be quoted: they invalidate a shipping choice and a quote request. */
const COMMERCIAL_OPS: ReadonlySet<string> = new Set(['set_delivery_destination', 'clear_delivery_destination', 'add_item', 'remove_item', 'set_item_quantity', 'replace_item']);
export function changesCommercialSelection(input: WorkspaceUpdateV2Input): boolean {
  return input.operations.some((op) => COMMERCIAL_OPS.has(op.op));
}

export type FactValue = z.infer<typeof factValueSchema>;

export interface WorkspaceFact {
  readonly value: FactValue;
  readonly statedBy: 'customer' | 'agent';
  readonly note: string | null;
  /** Workspace version that set the current value. */
  readonly sinceVersion: number;
  readonly updatedAt: string;
}

export interface WorkspaceItem {
  readonly productId: string;
  readonly quantity: number;
  readonly sinceVersion: number;
  readonly updatedAt: string;
}

export interface WorkspaceDelivery {
  readonly commune: string;
  readonly region: string | null;
  readonly sinceVersion: number;
  readonly updatedAt: string;
}

/**
 * (R4-J3E) What the customer chose for delivery: one owner offer for the
 * destination (the agreed owner NET it was offered at), or explicitly none.
 * A label of the owner's offer, never a price the workspace vouches for:
 * quote.preview re-quotes it and refuses a changed or vanished offer.
 */
export type WorkspaceShipping =
  | { readonly kind: 'selected'; readonly commune: string; readonly carrierName: string; readonly serviceType: string; readonly agreedOwnerNetClp: number; readonly sinceVersion: number; readonly updatedAt: string }
  | { readonly kind: 'excluded'; readonly sinceVersion: number; readonly updatedAt: string };

/** (R4-J3E) The customer's request for one exact quote preview, in their words (as the agent recorded them). */
export interface WorkspaceQuoteRequest {
  readonly previewId: string;
  readonly customerWords: string;
  readonly sinceVersion: number;
  readonly updatedAt: string;
}

export interface WorkspaceState {
  readonly facts: Readonly<Record<string, WorkspaceFact>>;
  readonly delivery: WorkspaceDelivery | null;
  readonly items: readonly WorkspaceItem[];
  /** (R4-J3E, workspace.update@2 only) Absent in states written by version 1. */
  readonly shipping?: WorkspaceShipping | null;
  /** (R4-J3E, workspace.update@2 only) Absent in states written by version 1. */
  readonly quoteRequest?: WorkspaceQuoteRequest | null;
}

export interface Workspace {
  readonly taskId: string;
  /** 0 = nothing recorded yet. */
  readonly version: number;
  readonly state: WorkspaceState;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** One material change, with what it replaced: enough to reconstruct the history. */
export type WorkspaceChange =
  | { readonly kind: 'fact'; readonly key: string; readonly from: WorkspaceFact | null; readonly to: WorkspaceFact | null }
  | { readonly kind: 'delivery'; readonly from: WorkspaceDelivery | null; readonly to: WorkspaceDelivery | null }
  | { readonly kind: 'item'; readonly productId: string; readonly from: WorkspaceItem | null; readonly to: WorkspaceItem | null }
  | { readonly kind: 'shipping'; readonly from: WorkspaceShipping | null; readonly to: WorkspaceShipping | null }
  | { readonly kind: 'quote_request'; readonly from: WorkspaceQuoteRequest | null; readonly to: WorkspaceQuoteRequest | null };

export const WORKSPACE_REJECTION_CODES = [
  'version_conflict',
  'item_already_selected',
  'item_not_selected',
  'fact_not_recorded',
  'unknown_product',
  'no_change',
  // R4-J3E (workspace.update@2)
  'no_delivery_destination',
  'delivery_destination_set',
  'shipping_selection_not_alone',
  'shipping_offer_not_offered',
] as const;
export type WorkspaceRejectionCode = (typeof WORKSPACE_REJECTION_CODES)[number];

export type WorkspaceApplication =
  | { readonly kind: 'applied'; readonly state: WorkspaceState; readonly changes: readonly WorkspaceChange[] }
  | { readonly kind: 'rejected'; readonly code: WorkspaceRejectionCode; readonly message: string; readonly operationIndex: number | null };

export const EMPTY_STATE: WorkspaceState = Object.freeze({ facts: {}, delivery: null, items: [] });

export function emptyWorkspace(taskId: string): Workspace {
  return { taskId, version: 0, state: EMPTY_STATE, createdAt: null, updatedAt: null };
}

/**
 * Pure: applies a batch to a workspace, all-or-nothing. `nextVersion` is the
 * version the changes are stamped with; `now` the instant.
 */
export function applyOperations(workspace: Workspace, input: WorkspaceUpdateInput | WorkspaceUpdateV2Input, now: string): WorkspaceApplication {
  if (input.expectedVersion !== undefined && input.expectedVersion !== workspace.version) {
    return { kind: 'rejected', code: 'version_conflict', message: `the workspace is at version ${workspace.version}, not ${input.expectedVersion}`, operationIndex: null };
  }
  const since = workspace.version + 1;
  const facts: Record<string, WorkspaceFact> = { ...workspace.state.facts };
  let delivery = workspace.state.delivery;
  const items = [...workspace.state.items];
  // R4-J3E fields: carried only when the state already has them or a v2 operation sets them,
  // so a version-1 command over a version-1 state produces exactly the state it always did.
  let shipping = workspace.state.shipping;
  let quoteRequest = workspace.state.quoteRequest;
  const changes: WorkspaceChange[] = [];
  const reject = (code: WorkspaceRejectionCode, message: string, index: number): WorkspaceApplication => ({ kind: 'rejected', code, message, operationIndex: index });
  const indexOf = (productId: string) => items.findIndex((i) => i.productId === productId);
  const operations = input.operations as readonly WorkspaceOperationV2[];
  const commercial = operations.some((op) => COMMERCIAL_OPS.has(op.op));
  /** What would be quoted changed: an earlier delivery choice and quote request no longer apply. */
  const invalidate = (what: { shipping: boolean }) => {
    if (what.shipping && shipping) {
      changes.push({ kind: 'shipping', from: shipping, to: null });
      shipping = null;
    }
    if (quoteRequest) {
      changes.push({ kind: 'quote_request', from: quoteRequest, to: null });
      quoteRequest = null;
    }
  };

  for (const [index, op] of operations.entries()) {
    if (COMMERCIAL_OPS.has(op.op)) invalidate({ shipping: true });
    switch (op.op) {
      case 'select_shipping_offer': {
        // A choice is made for one exact selection and destination: never in the same batch that changes them.
        if (commercial) return reject('shipping_selection_not_alone', 'choose the shipping offer in its own update, after the items and destination are final', index);
        if (!delivery) return reject('no_delivery_destination', 'set the delivery destination before choosing a shipping offer', index);
        invalidate({ shipping: false });
        const to: WorkspaceShipping = { kind: 'selected', commune: delivery.commune, carrierName: op.carrierName, serviceType: op.serviceType, agreedOwnerNetClp: op.ownerNetClp, sinceVersion: since, updatedAt: now };
        changes.push({ kind: 'shipping', from: shipping ?? null, to });
        shipping = to;
        break;
      }
      case 'exclude_shipping': {
        if (delivery) return reject('delivery_destination_set', 'a delivery destination is recorded: clear it before excluding delivery', index);
        invalidate({ shipping: false });
        const to: WorkspaceShipping = { kind: 'excluded', sinceVersion: since, updatedAt: now };
        changes.push({ kind: 'shipping', from: shipping ?? null, to });
        shipping = to;
        break;
      }
      case 'record_quote_request': {
        const to: WorkspaceQuoteRequest = { previewId: op.previewId, customerWords: op.customerWords, sinceVersion: since, updatedAt: now };
        changes.push({ kind: 'quote_request', from: quoteRequest ?? null, to });
        quoteRequest = to;
        break;
      }
      case 'record_fact': {
        const from = facts[op.key] ?? null;
        const to: WorkspaceFact = { value: op.value, statedBy: op.statedBy, note: op.note ?? null, sinceVersion: since, updatedAt: now };
        facts[op.key] = to;
        changes.push({ kind: 'fact', key: op.key, from, to });
        break;
      }
      case 'retract_fact': {
        const from = facts[op.key];
        if (!from) return reject('fact_not_recorded', `no fact "${op.key}" is recorded`, index);
        delete facts[op.key];
        changes.push({ kind: 'fact', key: op.key, from, to: null });
        break;
      }
      case 'set_delivery_destination': {
        const to: WorkspaceDelivery = { commune: op.commune, region: op.region ?? null, sinceVersion: since, updatedAt: now };
        changes.push({ kind: 'delivery', from: delivery, to });
        delivery = to;
        break;
      }
      case 'clear_delivery_destination': {
        if (delivery === null) return reject('no_change', 'no delivery destination is recorded', index);
        changes.push({ kind: 'delivery', from: delivery, to: null });
        delivery = null;
        break;
      }
      case 'add_item': {
        if (indexOf(op.productId) >= 0) return reject('item_already_selected', `${op.productId} is already selected: change its quantity or replace it explicitly`, index);
        const to: WorkspaceItem = { productId: op.productId, quantity: op.quantity, sinceVersion: since, updatedAt: now };
        items.push(to);
        changes.push({ kind: 'item', productId: op.productId, from: null, to });
        break;
      }
      case 'remove_item': {
        const at = indexOf(op.productId);
        if (at < 0) return reject('item_not_selected', `${op.productId} is not selected`, index);
        changes.push({ kind: 'item', productId: op.productId, from: items[at]!, to: null });
        items.splice(at, 1);
        break;
      }
      case 'set_item_quantity': {
        const at = indexOf(op.productId);
        if (at < 0) return reject('item_not_selected', `${op.productId} is not selected: add it first`, index);
        const from = items[at]!;
        const to: WorkspaceItem = { ...from, quantity: op.quantity, sinceVersion: since, updatedAt: now };
        items[at] = to;
        changes.push({ kind: 'item', productId: op.productId, from, to });
        break;
      }
      case 'replace_item': {
        const at = indexOf(op.productId);
        if (at < 0) return reject('item_not_selected', `${op.productId} is not selected, so it cannot be replaced`, index);
        if (indexOf(op.withProductId) >= 0) return reject('item_already_selected', `${op.withProductId} is already selected`, index);
        const from = items[at]!;
        const to: WorkspaceItem = { productId: op.withProductId, quantity: op.quantity, sinceVersion: since, updatedAt: now };
        items[at] = to;
        changes.push({ kind: 'item', productId: op.productId, from, to: null }, { kind: 'item', productId: op.withProductId, from: null, to });
        break;
      }
    }
  }
  const state: WorkspaceState = {
    facts,
    delivery,
    items,
    ...(shipping !== undefined ? { shipping } : {}),
    ...(quoteRequest !== undefined ? { quoteRequest } : {}),
  };
  return { kind: 'applied', state, changes };
}

/** Product ids a batch would introduce (the capability verifies them with the Catalog owner first). */
export function introducedProducts(input: WorkspaceUpdateInput | WorkspaceUpdateV2Input): string[] {
  return [...new Set(input.operations.flatMap((op) => (op.op === 'add_item' ? [op.productId] : op.op === 'replace_item' ? [op.withProductId] : [])))];
}

/** The compact form of the selection (what quotes and the context show). */
export function selectionOf(state: WorkspaceState): { productId: string; quantity: number }[] {
  return state.items.map((i) => ({ productId: i.productId, quantity: i.quantity }));
}
