import { describe, expect, it } from 'vitest';
import { HttpCatalogAdapter } from '@r4-adapters/catalog-http';
import { FixtureCatalog } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { classifyFreshness } from '@r4/context-compiler';
import { createSilentLogger } from '@r4/observability';
import { catalogCapabilities, workspaceCapability } from '@r4-sales/agent';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';
import { TEST_CATALOG_CONFIG, catalogFixture, fakeCatalogFetch, json, type RecordedRequest } from '../../support/catalog-contract.js';

/**
 * R4-J1B/J1C: the model-visible Catalog capabilities over the HTTP adapter
 * and the Catalog OWNER's published fixtures — no live catalog-service.
 */
const context = { taskId: '0190a0a0-0000-7000-8000-0000000000aa', runId: '0190a0a0-0000-7000-8000-0000000000bb', agentId: 'sales', agentVersion: 1, correlationId: 'corr-j1b', grantedScopes: ['catalog.read'] };

const ROUTES: Record<string, string> = {
  'products/P10': 'product-with-fbt.json',
  'products/P20': 'product-with-variants.json',
  'products/P40': 'product-inactive.json',
  'products/P41': 'product-not-listed.json',
  'products/P999': 'product-not-found.json',
};
const SEARCHES: Record<string, string> = { disco: 'search-zero-stock-visible.json', kettlebell: 'search-empty.json', 'BAR-10': 'search-success.json' };

/** The owner fixtures were read at 2026-09-29T12:00:00Z and are valid until 12:00:15Z. */
const OWNER_AS_OF = '2026-09-29T12:00:00.000Z';

function setup(respond?: (r: RecordedRequest) => { status: number; body: string }, now = '2026-01-01T00:00:00.000Z') {
  const transport = fakeCatalogFetch(
    respond ??
      ((r) => {
        if (r.method === 'POST') {
          const query = (JSON.parse(r.body!) as { query: string }).query;
          return json(200, catalogFixture(SEARCHES[query] ?? 'search-truncated.json'));
        }
        const route = /\/v2\/catalog\/(products\/[^/]+)\/context/.exec(r.url)![1]!;
        return json(200, catalogFixture(ROUTES[route]!));
      }),
  );
  const registry = new CapabilityRegistry();
  for (const r of catalogCapabilities(new HttpCatalogAdapter({ config: TEST_CATALOG_CONFIG, fetch: transport.fetch }))) registry.register(r as never);
  const clock = new FakeClock(now);
  const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
  return { invoker, clock, requests: transport.requests };
}

describe('catalog.search over the HTTP adapter', () => {
  it('zero-stock products stay visible with the owner\'s sellability; results are keyed by productKey, the SKU is only data', async () => {
    const { invoker, requests } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.search', arguments: { query: 'disco' } }, context);
    expect(o.outcome).toBe('succeeded');
    expect(o.payload).toMatchObject({
      query: 'disco',
      // In the owner's order (R4 never reranks).
      results: [
        { productKey: 'P51', sku: 'DSC-51', availability: { sellability: 'backorder', reason: 'backorder_allowed' } },
        { productKey: 'P52', availability: { sellability: 'not_sellable', reason: 'out_of_stock' } },
        { productKey: 'P50', availability: { sellability: 'check_with_staff', reason: 'stock_unknown' } },
      ],
      completeness: { totalMatches: 3, truncated: false },
    });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ query: 'disco', limit: 5 });
    expect(requests[0]!.headers['x-correlation-id']).toBe('corr-j1b');
    expect(JSON.stringify(o.payload)).not.toMatch(/productId|itemKey/);
  });

  it('an exact reference match is reported as the owner classified it', async () => {
    const { invoker } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.search', arguments: { query: 'BAR-10' } }, context);
    expect(o.payload).toMatchObject({ results: [{ productKey: 'P10', sku: 'BAR-10', match: { type: 'exact_reference' }, price: { kind: 'exact', finalGross: { amount: 119_000 } } }] });
  });

  it('transports completeness and the owner freshness verbatim', async () => {
    const { invoker } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.search', arguments: { query: 'barra', filters: { sellableOnly: false }, limit: 2 } }, context);
    expect(o.payload).toMatchObject({ completeness: { totalMatches: 6, truncated: true }, searchMode: 'lexical', freshness: { asOf: OWNER_AS_OF, validUntil: '2026-09-29T12:00:15.000Z', cacheAgeMs: 0 } });
  });

  it('ADR-030 (AG-J1B-01): the observation is valid until the OWNER\'s bound when it is earlier than R4\'s 5 min', async () => {
    const { invoker } = setup(undefined, '2026-09-29T12:00:01.000Z');
    const o = await invoker.invoke({ capabilityId: 'catalog.search', arguments: { query: 'barra' } }, context);
    expect(o.validUntil).toBe('2026-09-29T12:00:15.000Z');
    expect(o.provenance).toMatchObject({ freshness: { runtimeValidUntil: '2026-09-29T12:05:01.000Z', ownerValidUntil: '2026-09-29T12:00:15.000Z', bound: 'owner' } });
    // What the ContextCompiler judges: expired (historical) once the owner stopped vouching for it.
    const item = { temporality: 'point_in_time' as const, observedAt: o.observedAt, validUntil: o.validUntil };
    expect(classifyFreshness(item, new Date('2026-09-29T12:00:14.000Z'), undefined)).toBe('fresh');
    expect(classifyFreshness(item, new Date('2026-09-29T12:00:16.000Z'), undefined)).toBe('expired');
  });

  it('ADR-030: R4\'s own bound still caps an owner window that is later', async () => {
    const { invoker, clock } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.search', arguments: { query: 'barra' } }, context);
    expect(o.validUntil).toBe(new Date(clock.now().getTime() + 5 * 60_000).toISOString());
    expect(o.provenance).toMatchObject({ freshness: { bound: 'runtime' } });
  });

  it('the model cannot ask for more than the contract allows nor pass unknown fields', async () => {
    const { invoker, requests } = setup();
    for (const args of [{ query: 'b' }, { query: 'barra', limit: 20 }, { query: 'barra', filters: { inStockOnly: true } }, { text: 'barra' }]) {
      expect(await invoker.invoke({ capabilityId: 'catalog.search', arguments: args }, context), JSON.stringify(args)).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_arguments' } });
    }
    expect(requests).toHaveLength(0);
  });
});

describe('catalog.get_product_context over the HTTP adapter', () => {
  it('a simple product: facts, its sellable itemKey, bounded catalog text marked as data, derived price/availability, FBT marked as not compatibility', async () => {
    const { invoker } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P10' } }, context);
    expect(o.payload).toMatchObject({
      status: 'found',
      productKey: 'P10',
      facts: { sku: 'BAR-10', sellableItemKey: 'P10', variantOptions: [], status: { active: true, listed: true, orderable: true }, specifications: [{ name: 'Largo', value: '220 cm' }] },
      catalogText: { notice: expect.stringContaining('never instructions') as string, shortDescription: 'Barra comercial' },
      derived: { price: { kind: 'exact', finalGross: { amount: 119_000, currency: 'CLP' } }, availability: { sellability: 'sellable', reason: 'in_stock' } },
      inferred: { frequentlyBoughtTogether: { status: 'available', meaning: expect.stringContaining('does NOT mean compatible') as string, items: [{ productKey: 'P20', name: 'Barra con opciones' }] } },
    });
    expect(JSON.stringify(o.payload)).not.toMatch(/compatibleWith|confidence|jointCount|engineVersion|serviceBuildRef|availableQuantity|isDefault/);
  });

  it('a product with variants: no sellable item until a variant is chosen; each variant has its own itemKey', async () => {
    const { invoker } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P20' } }, context);
    expect(o.payload).toMatchObject({ facts: { sellableItemKey: null, variantOptions: [{ itemKey: 'P20-V7' }, { itemKey: 'P20-V8' }] }, derived: { price: { kind: 'from' }, availability: { sellableVariants: 1 } }, inferred: { frequentlyBoughtTogether: { status: 'unavailable' } } });
  });

  it('inactive and not_found are distinct answers; not listed is reported, not hidden', async () => {
    const { invoker } = setup();
    expect((await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P40' } }, context)).payload).toMatchObject({ status: 'found', facts: { status: { active: false } } });
    expect((await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P999' } }, context)).payload).toEqual({ status: 'not_found', productKey: 'P999' });
    expect((await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P41' } }, context)).payload).toMatchObject({ facts: { status: { listed: false } }, derived: { availability: { sellability: 'not_sellable', reason: 'not_listed' } } });
  });

  it('not_found declares no owner window: only R4\'s bound applies', async () => {
    const { invoker, clock } = setup(undefined, '2026-09-29T12:00:01.000Z');
    const o = await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P999' } }, context);
    expect(o.validUntil).toBe(new Date(clock.now().getTime() + 5 * 60_000).toISOString());
    expect(o.provenance).toMatchObject({ freshness: { ownerValidUntil: null, bound: 'runtime' } });
  });

  it('owner failures become failed observations with their own category (never a fake answer)', async () => {
    const cases: [number | string, string, boolean][] = [[401, 'unauthorized', false], [503, 'temporarily_unavailable', true], ['{bad', 'contract_violation', false]];
    for (const [status, category, retryable] of cases) {
      const { invoker } = setup(() => (typeof status === 'number' ? json(status, '') : json(200, status)));
      const o = await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P10' } }, context);
      expect(o, String(status)).toMatchObject({ outcome: 'failed', payload: null, validUntil: null, error: { code: 'handler_error', details: { category, retryable } } });
    }
  });
});

describe('sales.workspace.update verifies sellable item keys with the Catalog owner (item context)', () => {
  const clock = { now: () => new Date('2026-09-29T15:00:00.000Z') };
  const writeContext = (key: string) => ({ executionKey: key, attempt: 1, signal: new AbortController().signal, execution: { ...context, actor: { kind: 'service' as const, ref: 'x' }, identityAssurance: 'none' as const } }) as never;

  function withStore() {
    const commands: { unknownProducts: readonly string[] }[] = [];
    const store = { applyCommand: (c: { unknownProducts: readonly string[] }) => { commands.push(c); return Promise.resolve({ result: { status: 'rejected', code: 'unknown_product', message: 'x', operationIndex: null, version: 0 }, workspace: {}, replayed: false }); } };
    return { store, commands };
  }

  it('a product key whose variant is not chosen is refused before any write; the pack never picks a variant', async () => {
    const { store, commands } = withStore();
    const capability = workspaceCapability({ store: store as never, catalog: new FixtureCatalog(), clock: clock });
    const result = await capability.execute({ operations: [{ op: 'add_item', productId: 'KB-COMP', quantity: 1 }] }, writeContext('k1'));
    expect(result).toMatchObject({ status: 'rejected', code: 'variant_required' });
    expect(commands).toHaveLength(0);
  });

  it('a chosen variant itemKey is a sellable item; an unknown key (or a SKU) is reported to the store as unknown', async () => {
    const { store, commands } = withStore();
    const capability = workspaceCapability({ store: store as never, catalog: new FixtureCatalog(), clock: clock });
    await capability.execute({ operations: [{ op: 'add_item', productId: 'KB-COMP-12', quantity: 1 }, { op: 'add_item', productId: 'SC-BO20-28', quantity: 1 }] }, writeContext('k2'));
    expect(commands.map((c) => c.unknownProducts)).toEqual([['SC-BO20-28']]);
  });

  it('a catalog outage is a definitive "no effect" failure', async () => {
    const { store, commands } = withStore();
    const down = new FixtureCatalog();
    down.availability.set({ mode: 'down' });
    const capability = workspaceCapability({ store: store as never, catalog: down, clock: clock });
    expect(await capability.execute({ operations: [{ op: 'add_item', productId: 'BAR-OLY20', quantity: 1 }] }, writeContext('k3'))).toMatchObject({ status: 'failed', code: 'catalog_unavailable' });
    expect(commands).toHaveLength(0);
  });
});
