import { describe, expect, it } from 'vitest';
import type { Observation } from '@r4/contracts';
import { contextContributionSchema } from '@r4/contracts';
import { SalesWorkspaceContextSource, emptyWorkspace, projectWorkspace, type Workspace, type WorkspaceReader } from '@r4-sales/agent';

const TASK = '0190a0a0-0000-7000-8000-0000000000aa';
const RUN = '0190a0a0-0000-7000-8000-0000000000bb';
const NOW = new Date('2026-09-23T12:00:00.000Z');

let seq = 0;
function observation(capabilityId: string, payload: unknown, observedAt: string, validUntil: string | null): Observation {
  seq += 1;
  return {
    observationId: `0190a0a0-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    taskId: TASK,
    runId: RUN,
    agentId: 'sales',
    source: { kind: 'capability', capabilityId, capabilityVersion: 1, invocationId: `0190a0a0-0000-7000-9000-${String(seq).padStart(12, '0')}` },
    outcome: 'succeeded',
    payload: payload as never,
    error: null,
    observedAt,
    validUntil,
    provenance: {},
    correlationId: 'c',
  };
}

const workspace: Workspace = {
  ...emptyWorkspace(TASK),
  version: 3,
  state: {
    facts: { budget: { value: { amount: 800_000, currency: 'CLP' }, statedBy: 'customer', note: null, sinceVersion: 1, updatedAt: NOW.toISOString() } },
    delivery: { commune: 'Viña del Mar', region: null, sinceVersion: 3, updatedAt: NOW.toISOString() },
    items: [{ productId: 'BAR-OLY20', quantity: 1, sinceVersion: 2, updatedAt: NOW.toISOString() }],
  },
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

describe('Sales workspace projection (what the agent sees as current Sales state)', () => {
  it('marks shipping evidence for another destination or selection as not applicable', () => {
    const items = [{ productId: 'BAR-OLY20', quantity: 1 }];
    const old = observation('shipping.quote', { destination: { communeId: '99', communeName: 'Ñuñoa', regionName: 'Metropolitana de Santiago' }, requestedItems: items }, '2026-09-23T11:50:00.000Z', '2026-09-23T12:20:00.000Z');
    const other = observation('shipping.quote', { destination: { communeId: '1', communeName: 'Viña del Mar', regionName: 'Valparaíso' }, requestedItems: [{ productId: 'BAR-OLY20', quantity: 2 }] }, '2026-09-23T11:55:00.000Z', '2026-09-23T12:25:00.000Z');
    const current = observation('shipping.quote', { destination: { communeId: '1', communeName: 'Vina del Mar', regionName: 'Valparaíso' }, requestedItems: items }, '2026-09-23T11:58:00.000Z', '2026-09-23T12:28:00.000Z');
    const view = projectWorkspace({ workspace, binding: null, quotes: [], transitions: [], observations: [old, other, current], now: NOW });
    expect(view.shippingEvidence).toEqual([
      { observationId: old.observationId, destination: 'Ñuñoa', forCurrentDestination: false, forCurrentSelection: true, current: true },
      { observationId: other.observationId, destination: 'Viña del Mar', forCurrentDestination: true, forCurrentSelection: false, current: true },
      { observationId: current.observationId, destination: 'Vina del Mar', forCurrentDestination: true, forCurrentSelection: true, current: true },
    ]);
  });

  it('points each selected item at its newest catalog evidence and says whether it is still current', () => {
    const stale = observation('catalog.get_product_context', { status: 'found', productKey: 'BAR-OLY20', facts: { sellableItemKey: 'BAR-OLY20', variantOptions: [] }, freshness: { validUntil: '2026-09-23T11:05:00.000Z' } }, '2026-09-23T11:00:00.000Z', '2026-09-23T11:05:00.000Z');
    let view = projectWorkspace({ workspace, binding: null, quotes: [], transitions: [], observations: [stale], now: NOW });
    expect(view.selection).toEqual([{ productId: 'BAR-OLY20', quantity: 1, sinceVersion: 2, catalogEvidence: { observationId: stale.observationId, current: false } }]);
    const fresh = observation('catalog.search', { results: [{ productKey: 'BAR-OLY20' }], freshness: { validUntil: '2026-09-23T12:04:00.000Z' } }, '2026-09-23T11:59:00.000Z', '2026-09-23T12:04:00.000Z');
    view = projectWorkspace({ workspace, binding: null, quotes: [], transitions: [], observations: [stale, fresh], now: NOW });
    expect(view.selection).toEqual([{ productId: 'BAR-OLY20', quantity: 1, sinceVersion: 2, catalogEvidence: { observationId: fresh.observationId, current: true } }]);
  });

  it("never extends the Catalog owner's freshness: evidence the owner declared expired is not current, even inside R4's window (J1B §8)", () => {
    // R4's window is still open (12:04) but the owner vouched only until 11:59:30 (e.g. a cached answer).
    const ownerExpired = observation('catalog.search', { results: [{ productKey: 'BAR-OLY20' }], freshness: { asOf: '2026-09-23T11:44:30.000Z', validUntil: '2026-09-23T11:59:30.000Z', cacheAgeMs: 900_000 } }, '2026-09-23T11:59:00.000Z', '2026-09-23T12:04:00.000Z');
    const view = projectWorkspace({ workspace, binding: null, quotes: [], transitions: [], observations: [ownerExpired], now: NOW });
    expect(view.selection).toEqual([{ productId: 'BAR-OLY20', quantity: 1, sinceVersion: 2, catalogEvidence: { observationId: ownerExpired.observationId, current: false } }]);
  });

  it('a selected variant itemKey is backed by the product context that lists it (itemKey stays the identity across turns)', () => {
    const variantWorkspace: Workspace = { ...workspace, state: { ...workspace.state, items: [{ productId: 'KB-COMP-12', quantity: 1, sinceVersion: 2, updatedAt: NOW.toISOString() }] } };
    const context = observation('catalog.get_product_context', { status: 'found', productKey: 'KB-COMP', facts: { sellableItemKey: null, variantOptions: [{ itemKey: 'KB-COMP-12' }, { itemKey: 'KB-COMP-24' }] }, freshness: { validUntil: '2026-09-23T12:04:00.000Z' } }, '2026-09-23T11:59:00.000Z', '2026-09-23T12:04:00.000Z');
    const view = projectWorkspace({ workspace: variantWorkspace, binding: null, quotes: [], transitions: [], observations: [context], now: NOW });
    expect(view.selection).toEqual([{ productId: 'KB-COMP-12', quantity: 1, sinceVersion: 2, catalogEvidence: { observationId: context.observationId, current: true } }]);
  });

  it('says a quote no longer matches once the selection or destination changed after it', () => {
    const quotes = [{ executionKey: 'k', taskId: TASK, quoteId: 'qt-1', quoteNumber: 'COT-100001', basedOnWorkspaceVersion: 2, recordedAt: NOW.toISOString() }];
    const transitions = [{ executionKey: 'k2', taskId: TASK, outcome: 'applied' as const, fromVersion: 2, toVersion: 3, operations: [], changes: [{ kind: 'delivery' as const, from: null, to: workspace.state.delivery }], result: { status: 'applied' as const, version: 3, operations: 1, state: workspace.state }, recordedAt: NOW.toISOString() }];
    const view = projectWorkspace({ workspace, binding: null, quotes, transitions, observations: [], now: NOW });
    expect(view.quotes).toEqual([{ quoteId: 'qt-1', quoteNumber: 'COT-100001', basedOnWorkspaceVersion: 2, selectionOrDeliveryChangedSince: true }]);
  });

  it('never carries prices, stock or totals, and reports identity only as provisional/unavailable', () => {
    const view = projectWorkspace({ workspace, binding: { taskId: TASK, customerRef: null, channelRef: 'x', createdAt: NOW.toISOString() }, quotes: [], transitions: [], observations: [], now: NOW });
    expect(view.customer).toEqual({ identity: 'unavailable' });
    expect(JSON.stringify(view)).not.toMatch(/"(unitPrice|price|stock|total|subtotal|amount)"\s*:\s*\{/);
    expect(JSON.stringify(view.selection)).not.toMatch(/price|stock/i);
  });

  it('contributes one AUTHORITATIVE live state item for Sales tasks only (never for other packs)', async () => {
    const reader: WorkspaceReader = {
      workspace: () => Promise.resolve(workspace),
      conversation: () => Promise.resolve(null),
      quoteReferences: () => Promise.resolve([]),
      transitions: () => Promise.resolve([]),
    };
    const source = new SalesWorkspaceContextSource(reader);
    const base = { taskId: TASK, createdAt: NOW.toISOString() };
    const request = (taskType: string) => ({ scope: { taskId: TASK, runId: RUN, agentId: 'sales', agentVersion: 1, iteration: 1 }, now: NOW, execution: { task: { ...base, taskType }, observations: [] } }) as never;
    const items = await source.load(request('sales.conversation'));
    expect(items).toHaveLength(1);
    const item = contextContributionSchema.parse(items[0]);
    expect(item).toMatchObject({ itemId: `sales_workspace:${TASK}`, kind: 'state', authority: 'AUTHORITATIVE', temporality: 'live', required: true, provenance: { recordType: 'sales_workspace', recordVersion: '3', producedBy: 'sales' } });
    expect(await source.load(request('probe.echo'))).toEqual([]);
  });
});
