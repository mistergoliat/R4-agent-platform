import { describe, expect, it } from 'vitest';
import type { CatalogItemContext, CatalogItemContextRequest, CatalogPort } from '@r4-adapters/domains';
import { CAPABILITY_IDS, catalogDiscoverView, workspaceCapability, type CatalogDiscoverView } from '@r4-sales/agent';
import { DISCOVER_T0, fixedDiscover, scenarioFixture, turnFixture, type DiscoverFixture } from '../../support/catalog-discover-contract.js';

/**
 * R4-DISCOVER-I1 §8 — variant resolution. Which capability serves what:
 *
 *   conceptual need, goal, use, spec combination      catalog.discover
 *   name, SKU, reference, exact nominal search        catalog.search (unchanged; Discover replaces nothing)
 *   known productKey: facts, variant options          catalog.get_product_context
 *   one sellable unit: exact price/stock for a qty    item context — INTERNAL (workspace add_item, quote): not model-visible
 *
 * Discover may hand back a unit (itemKey) but never selects it for the customer, and nothing that
 * depends on an exact price or availability runs before the owner confirms a concrete sellable unit.
 */

const SENT = { need: 'x', constraints: {}, referenceProductKeys: [], selectedItemKeys: [], limit: 8, budgetFromWorkspace: null, unappliedWorkspaceBudgets: [] };
async function viewOf(fixture: DiscoverFixture): Promise<CatalogDiscoverView> {
  return catalogDiscoverView(await fixedDiscover({ status: 200, body: fixture.http.body }).port.discover({ need: 'x' }), SENT, DISCOVER_T0);
}

/** The owner's item-context answers for the synthetic Discover catalog (status only: what the workspace checks). */
function ownerItems(): CatalogPort & { asked: string[] } {
  const asked: string[] = [];
  const answers: Record<string, CatalogItemContext['status']> = { P5: 'variant_required', 'P5-V1': 'found', 'P5-V99': 'not_found', P7: 'variant_required', 'P7-V1': 'found', 'P7-V2': 'found' };
  return {
    asked,
    search: () => Promise.reject(new Error('unused')),
    getProductContext: () => Promise.reject(new Error('unused')),
    getItemContext: (request: CatalogItemContextRequest): Promise<CatalogItemContext> => {
      asked.push(request.itemKey);
      const status = answers[request.itemKey] ?? 'not_found';
      if (status === 'variant_required') return Promise.resolve({ status, itemKey: request.itemKey, productKey: request.itemKey });
      if (status === 'not_found') return Promise.resolve({ status, itemKey: request.itemKey });
      return Promise.resolve({ status: 'found', itemKey: request.itemKey } as unknown as CatalogItemContext);
    },
  };
}

const context = { taskId: '0190a0a0-0000-7000-8000-0000000000aa', runId: '0190a0a0-0000-7000-8000-0000000000bb', agentId: 'sales', agentVersion: 1, correlationId: 'corr-i1', grantedScopes: ['sales.workspace.write'] };
const writeContext = (key: string) => ({ executionKey: key, attempt: 1, signal: new AbortController().signal, execution: { ...context, actor: { kind: 'service' as const, ref: 'x' }, identityAssurance: 'none' as const } }) as never;
function withStore() {
  const commands: { unknownProducts: readonly string[] }[] = [];
  const store = { applyCommand: (c: { unknownProducts: readonly string[] }) => { commands.push(c); return Promise.resolve({ result: { status: 'applied', version: 1, operationsApplied: 1, state: { facts: {}, delivery: null, items: [] } }, workspace: {}, replayed: false }); } };
  return { store, commands };
}
const add = (productId: string) => ({ operations: [{ op: 'add_item' as const, productId, quantity: 1 }] });

describe('catalog.discover → a concrete sellable unit (owner-confirmed)', () => {
  it('a "from" candidate has no unit: R4 points to product context to choose, and the workspace refuses the bare productKey', async () => {
    const p5 = (await viewOf(scenarioFixture(9))).candidates.find((c) => c.productKey === 'P5')!;
    expect(p5.itemKey).toBeNull();
    expect(p5.reading.next).toEqual([{ action: 'SELECT_ITEM', capability: CAPABILITY_IDS.productContext, key: 'P5' }]);
    const catalog = ownerItems();
    const { store, commands } = withStore();
    const result = await workspaceCapability({ store: store as never, catalog, clock: { now: () => DISCOVER_T0 } }).execute(add('P5'), writeContext('k1'));
    expect(result).toMatchObject({ status: 'rejected', code: 'variant_required' });
    expect(commands).toHaveLength(0);
    expect(catalog.asked).toEqual(['P5']);
  });

  it('a variant the owner does not know (selection.notFound) is refused as an unknown product', async () => {
    const v = await viewOf(scenarioFixture(10));
    expect(v.interpretation.selection.notFound).toEqual(['P5-V99']);
    const { store, commands } = withStore();
    await workspaceCapability({ store: store as never, catalog: ownerItems(), clock: { now: () => DISCOVER_T0 } }).execute(add('P5-V99'), writeContext('k2'));
    expect(commands.map((c) => c.unknownProducts)).toEqual([['P5-V99']]);
  });

  it('a WITNESS unit (it certified the budget) is not the customer\'s choice: not fixed, no current price; the chosen unit is confirmed by the owner before entering the selection', async () => {
    const p7 = (await viewOf(turnFixture(3))).candidates.find((c) => c.productKey === 'P7')!;
    expect(p7).toMatchObject({ itemKey: 'P7-V1', reading: { unitBasis: 'WITNESS' } });
    expect(p7.reading.forbiddenClaims).toEqual(expect.arrayContaining(['VARIANT_FIXED', 'PRICE_CURRENT']));
    const catalog = ownerItems();
    const { store, commands } = withStore();
    await workspaceCapability({ store: store as never, catalog, clock: { now: () => DISCOVER_T0 } }).execute(add('P7-V2'), writeContext('k3'));
    expect(catalog.asked).toEqual(['P7-V2']);
    expect(commands.map((c) => c.unknownProducts)).toEqual([[]]);
  });

  it('once selected, Discover prices the chosen unit itself and points to the owner confirmation (item context) before any commercial action', async () => {
    const p7 = (await viewOf(scenarioFixture(23))).candidates.find((c) => c.productKey === 'P7')!;
    expect(p7).toMatchObject({ itemKey: 'P7-V2', reading: { unitBasis: 'SELECTED' }, commercial: { unit: { itemKey: 'P7-V2', finalGrossClp: 273_700 } } });
    expect(p7.reading.next).toContainEqual({ action: 'CONFIRM_ITEM', capability: 'catalog.get_item_context (internal confirmation)', key: 'P7-V2' });
    // Discover's unit block is the owner's item context copy (quantity 1): it is not a quote, and the quote re-reads the unit itself.
    expect(p7.reading.forbiddenClaims).toContain('PURCHASE_CONFIRMED');
  });
});
