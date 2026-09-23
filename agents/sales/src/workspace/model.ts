import { z } from 'zod';

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

export const productIdSchema = z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,47}$/, 'a catalog product id');
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

export interface WorkspaceState {
  readonly facts: Readonly<Record<string, WorkspaceFact>>;
  readonly delivery: WorkspaceDelivery | null;
  readonly items: readonly WorkspaceItem[];
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
  | { readonly kind: 'item'; readonly productId: string; readonly from: WorkspaceItem | null; readonly to: WorkspaceItem | null };

export const WORKSPACE_REJECTION_CODES = ['version_conflict', 'item_already_selected', 'item_not_selected', 'fact_not_recorded', 'unknown_product', 'no_change'] as const;
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
export function applyOperations(workspace: Workspace, input: WorkspaceUpdateInput, now: string): WorkspaceApplication {
  if (input.expectedVersion !== undefined && input.expectedVersion !== workspace.version) {
    return { kind: 'rejected', code: 'version_conflict', message: `the workspace is at version ${workspace.version}, not ${input.expectedVersion}`, operationIndex: null };
  }
  const since = workspace.version + 1;
  const facts: Record<string, WorkspaceFact> = { ...workspace.state.facts };
  let delivery = workspace.state.delivery;
  const items = [...workspace.state.items];
  const changes: WorkspaceChange[] = [];
  const reject = (code: WorkspaceRejectionCode, message: string, index: number): WorkspaceApplication => ({ kind: 'rejected', code, message, operationIndex: index });
  const indexOf = (productId: string) => items.findIndex((i) => i.productId === productId);

  for (const [index, op] of input.operations.entries()) {
    switch (op.op) {
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
  return { kind: 'applied', state: { facts, delivery, items }, changes };
}

/** Product ids a batch would introduce (the capability verifies them with the Catalog owner first). */
export function introducedProducts(input: WorkspaceUpdateInput): string[] {
  return [...new Set(input.operations.flatMap((op) => (op.op === 'add_item' ? [op.productId] : op.op === 'replace_item' ? [op.withProductId] : [])))];
}

/** The compact form of the selection (what quotes and the context show). */
export function selectionOf(state: WorkspaceState): { productId: string; quantity: number }[] {
  return state.items.map((i) => ({ productId: i.productId, quantity: i.quantity }));
}
