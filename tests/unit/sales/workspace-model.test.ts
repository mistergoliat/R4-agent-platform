import { describe, expect, it } from 'vitest';
import { applyOperations, emptyWorkspace, factKeySchema, introducedProducts, workspaceUpdateInputSchema, type Workspace, type WorkspaceUpdateInput } from '@r4-sales/agent';

const NOW = '2026-09-23T12:00:00.000Z';
const TASK = '0190a0a0-0000-7000-8000-0000000000aa';

function apply(workspace: Workspace, input: WorkspaceUpdateInput) {
  const out = applyOperations(workspace, workspaceUpdateInputSchema.parse(input), NOW);
  return out;
}

function next(workspace: Workspace, input: WorkspaceUpdateInput): Workspace {
  const out = apply(workspace, input);
  if (out.kind !== 'applied') throw new Error(`expected applied, got ${out.code}`);
  return { ...workspace, version: workspace.version + 1, state: out.state };
}

const selection = (w: Workspace) => w.state.items.map((i) => [i.productId, i.quantity]);

describe('SalesWorkspace operations (unambiguous selection semantics)', () => {
  it('add A, add B, remove A, change B quantity: a coherent selection, never an accidental replacement', () => {
    let w = emptyWorkspace(TASK);
    w = next(w, { operations: [{ op: 'add_item', productId: 'RACK-PR200', quantity: 1 }] });
    w = next(w, { operations: [{ op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }] });
    expect(selection(w)).toEqual([['RACK-PR200', 1], ['BAR-OLY20', 1]]);
    w = next(w, { operations: [{ op: 'remove_item', productId: 'RACK-PR200' }] });
    w = next(w, { operations: [{ op: 'set_item_quantity', productId: 'BAR-OLY20', quantity: 2 }] });
    expect(selection(w)).toEqual([['BAR-OLY20', 2]]);
    expect(w.version).toBe(4);
  });

  it('refuses to add an item that is already selected (no silent merge or overwrite)', () => {
    const w = next(emptyWorkspace(TASK), { operations: [{ op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }] });
    expect(apply(w, { operations: [{ op: 'add_item', productId: 'BAR-OLY20', quantity: 3 }] })).toMatchObject({ kind: 'rejected', code: 'item_already_selected', operationIndex: 0 });
  });

  it('refuses to remove, re-quantify or replace an item that is not selected', () => {
    const w = emptyWorkspace(TASK);
    expect(apply(w, { operations: [{ op: 'remove_item', productId: 'BAR-OLY20' }] })).toMatchObject({ kind: 'rejected', code: 'item_not_selected' });
    expect(apply(w, { operations: [{ op: 'set_item_quantity', productId: 'BAR-OLY20', quantity: 2 }] })).toMatchObject({ kind: 'rejected', code: 'item_not_selected' });
    expect(apply(w, { operations: [{ op: 'replace_item', productId: 'BAR-OLY20', withProductId: 'BAR-OLY15', quantity: 1 }] })).toMatchObject({ kind: 'rejected', code: 'item_not_selected' });
  });

  it('replaces explicitly, keeping the position and recording both sides of the change', () => {
    let w = next(emptyWorkspace(TASK), { operations: [{ op: 'add_item', productId: 'RACK-PR200', quantity: 1 }, { op: 'add_item', productId: 'PLT-IRON-50', quantity: 1 }, { op: 'add_item', productId: 'BENCH-FID', quantity: 1 }] });
    const out = apply(w, { operations: [{ op: 'replace_item', productId: 'PLT-IRON-50', withProductId: 'PLT-BUMP-100', quantity: 1 }] });
    if (out.kind !== 'applied') throw new Error('expected applied');
    w = { ...w, version: 2, state: out.state };
    expect(selection(w)).toEqual([['RACK-PR200', 1], ['PLT-BUMP-100', 1], ['BENCH-FID', 1]]);
    expect(out.changes).toEqual([
      { kind: 'item', productId: 'PLT-IRON-50', from: expect.objectContaining({ productId: 'PLT-IRON-50' }), to: null },
      { kind: 'item', productId: 'PLT-BUMP-100', from: null, to: expect.objectContaining({ productId: 'PLT-BUMP-100', sinceVersion: 2 }) },
    ]);
    expect(apply(w, { operations: [{ op: 'replace_item', productId: 'RACK-PR200', withProductId: 'BENCH-FID', quantity: 1 }] })).toMatchObject({ kind: 'rejected', code: 'item_already_selected' });
  });

  it('applies a batch atomically: one invalid operation leaves everything unchanged', () => {
    const w = emptyWorkspace(TASK);
    const out = apply(w, { operations: [{ op: 'add_item', productId: 'RACK-PR200', quantity: 1 }, { op: 'remove_item', productId: 'BAR-OLY20' }] });
    expect(out).toMatchObject({ kind: 'rejected', code: 'item_not_selected', operationIndex: 1 });
    expect(w.state.items).toEqual([]);
  });

  it('a corrected fact supersedes the previous value; history keeps both', () => {
    let w = next(emptyWorkspace(TASK), { operations: [{ op: 'record_fact', key: 'budget', value: { amount: 800_000, currency: 'CLP' }, statedBy: 'customer' }] });
    const out = apply(w, { operations: [{ op: 'record_fact', key: 'budget', value: { amount: 1_100_000, currency: 'CLP' }, statedBy: 'customer' }] });
    if (out.kind !== 'applied') throw new Error('expected applied');
    w = { ...w, version: 2, state: out.state };
    expect(Object.keys(w.state.facts)).toEqual(['budget']);
    expect(w.state.facts.budget).toMatchObject({ value: { amount: 1_100_000, currency: 'CLP' }, sinceVersion: 2 });
    expect(out.changes).toEqual([{ kind: 'fact', key: 'budget', from: expect.objectContaining({ value: { amount: 800_000, currency: 'CLP' } }), to: expect.objectContaining({ value: { amount: 1_100_000, currency: 'CLP' } }) }]);
  });

  it('destination changes and retractions are explicit changes too', () => {
    let w = next(emptyWorkspace(TASK), { operations: [{ op: 'set_delivery_destination', commune: 'Ñuñoa' }] });
    w = next(w, { operations: [{ op: 'set_delivery_destination', commune: 'Viña del Mar', region: 'Valparaíso' }] });
    expect(w.state.delivery).toMatchObject({ commune: 'Viña del Mar', region: 'Valparaíso', sinceVersion: 2 });
    expect(apply(w, { operations: [{ op: 'retract_fact', key: 'budget' }] })).toMatchObject({ kind: 'rejected', code: 'fact_not_recorded' });
  });

  it('honors optimistic concurrency when the caller asks for it', () => {
    const w = next(emptyWorkspace(TASK), { operations: [{ op: 'record_fact', key: 'users', value: 2, statedBy: 'customer' }] });
    expect(apply(w, { expectedVersion: 0, operations: [{ op: 'record_fact', key: 'users', value: 3, statedBy: 'customer' }] })).toMatchObject({ kind: 'rejected', code: 'version_conflict' });
    expect(apply(w, { expectedVersion: 1, operations: [{ op: 'record_fact', key: 'users', value: 3, statedBy: 'customer' }] }).kind).toBe('applied');
  });

  it('cannot hold domain truth: price, stock, cost, total and quote keys are refused by the schema', () => {
    for (const key of ['unit_price', 'precio_barra', 'stock_units', 'quote_number', 'cotizacion', 'shipping_cost', 'total', 'discount']) {
      expect(factKeySchema.safeParse(key).success, key).toBe(false);
    }
    for (const key of ['budget', 'available_space', 'training', 'users']) expect(factKeySchema.safeParse(key).success, key).toBe(true);
    // There is no operation that sets a selection wholesale, and no field for prices.
    expect(workspaceUpdateInputSchema.safeParse({ operations: [{ op: 'set_selection', items: [] }] }).success).toBe(false);
    expect(workspaceUpdateInputSchema.safeParse({ operations: [{ op: 'add_item', productId: 'BAR-OLY20', quantity: 1, unitPrice: 1 }] }).success).toBe(false);
  });

  it('lists the product ids a batch would introduce (verified with the Catalog owner before applying)', () => {
    expect(introducedProducts(workspaceUpdateInputSchema.parse({ operations: [{ op: 'add_item', productId: 'A1', quantity: 1 }, { op: 'replace_item', productId: 'A1', withProductId: 'B2', quantity: 1 }, { op: 'remove_item', productId: 'C3' }] }))).toEqual(['A1', 'B2']);
  });
});
