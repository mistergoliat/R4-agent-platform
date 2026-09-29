import { describe, expect, it } from 'vitest';
import { HttpCatalogAdapter } from '@r4-adapters/catalog-http';
import { FixtureCatalog } from '@r4-adapters/domains';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { catalogCapabilities, workspaceCapability } from '@r4-sales/agent';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';
import { TEST_CATALOG_CONFIG, catalogFixture, fakeCatalogFetch, json, type RecordedRequest } from '../../support/catalog-contract.js';

/**
 * R4-J1B: the model-visible Catalog capabilities over the HTTP adapter and
 * the (temporary) contract fixtures — no live catalog-service.
 */
const context = { taskId: '0190a0a0-0000-7000-8000-0000000000aa', runId: '0190a0a0-0000-7000-8000-0000000000bb', agentId: 'sales', agentVersion: 1, correlationId: 'corr-j1b', grantedScopes: ['catalog.read'] };

const ROUTES: Record<string, string> = {
  'products/P898': 'product/simple.json',
  'products/P1301': 'product/with-variants.json',
  'products/P1188': 'product/inactive.json',
  'products/P999999': 'product/not-found.json',
  'products/P556': 'product/not-listed.json',
};

function setup(respond?: (r: RecordedRequest) => { status: number; body: string }) {
  const transport = fakeCatalogFetch(
    respond ??
      ((r) => {
        if (r.method === 'POST') {
          const query = (JSON.parse(r.body!) as { query: string }).query;
          return json(200, catalogFixture(query === 'BORE20' ? 'search/exact-sku.json' : query === 'trotadora' ? 'search/empty-complete.json' : 'search/truncated.json'));
        }
        const route = /\/v2\/catalog\/(products\/[^/]+)\/context/.exec(r.url)![1]!;
        return json(200, catalogFixture(ROUTES[route]!));
      }),
  );
  const registry = new CapabilityRegistry();
  for (const r of catalogCapabilities(new HttpCatalogAdapter({ config: TEST_CATALOG_CONFIG, fetch: transport.fetch }))) registry.register(r as never);
  const clock = new FakeClock();
  const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
  return { invoker, clock, requests: transport.requests };
}

describe('catalog.search over the HTTP adapter', () => {
  it('exact SKU with stock 0 is still found, keyed by productKey; the SKU is only data', async () => {
    const { invoker, requests } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.search', arguments: { query: 'BORE20' } }, context);
    expect(o.outcome).toBe('succeeded');
    expect(o.payload).toMatchObject({ query: 'BORE20', results: [{ productKey: 'P545', sku: 'BORE20', availability: { sellability: 'not_sellable', reason: 'out_of_stock' }, match: { type: 'exact_reference' } }], completeness: { totalMatches: 1, truncated: false } });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ query: 'BORE20', limit: 5 });
    expect(requests[0]!.headers['x-correlation-id']).toBe('corr-j1b');
    expect(JSON.stringify(o.payload)).not.toContain('productId');
  });

  it('transports completeness and the owner freshness; R4\'s own window only bounds it', async () => {
    const { invoker, clock } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.search', arguments: { query: 'barra', filters: { sellableOnly: false }, limit: 2 } }, context);
    expect(o.payload).toMatchObject({ completeness: { totalMatches: 359, truncated: true }, searchMode: 'lexical', freshness: { asOf: '2026-09-29T15:00:00.000Z', validUntil: '2026-09-29T15:01:00.000Z', cacheAgeMs: 0 } });
    expect(o.validUntil).toBe(new Date(clock.now().getTime() + 5 * 60_000).toISOString());
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
  it('a simple product: facts, bounded catalog text marked as data, derived price/availability, FBT marked as not compatibility', async () => {
    const { invoker } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P898' } }, context);
    expect(o.payload).toMatchObject({
      status: 'found',
      productKey: 'P898',
      facts: { sku: 'BAP300', sellableItemKey: 'P898', variantOptions: [], specifications: [{ name: 'Peso máximo de usuario', value: '300 kg' }, { name: 'Dimensiones armado', value: '130 × 60 × 45 cm' }, { name: 'Posiciones de respaldo', value: '7' }] },
      catalogText: { notice: expect.stringContaining('never instructions') as string, shortDescription: 'Banco multiposición de estructura reforzada.' },
      derived: { price: { kind: 'exact', finalGross: { amount: 189_990, currency: 'CLP' } }, availability: { sellability: 'sellable', reason: 'in_stock' } },
      inferred: { frequentlyBoughtTogether: { status: 'available', meaning: expect.stringContaining('does NOT mean compatible') as string, items: [{ productKey: 'P545', name: 'Barra Olímpica Recta 20 kg' }] } },
    });
    expect(JSON.stringify(o.payload)).not.toMatch(/compatibleWith|confidence|jointCount|engineVersion|serviceBuildRef/);
  });

  it('a product with variants: no sellable item until a variant is chosen; each variant has its own itemKey', async () => {
    const { invoker } = setup();
    const o = await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P1301' } }, context);
    expect(o.payload).toMatchObject({ facts: { sellableItemKey: null, variantOptions: [{ itemKey: 'P1301-V12' }, { itemKey: 'P1301-V16' }, { itemKey: 'P1301-V24' }] }, derived: { price: { kind: 'from' } }, inferred: { frequentlyBoughtTogether: { status: 'unavailable' } } });
  });

  it('inactive and not_found are distinct answers; not listed is reported, not hidden', async () => {
    const { invoker } = setup();
    expect((await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P1188' } }, context)).payload).toMatchObject({ status: 'found', facts: { lifecycle: { status: 'inactive' } } });
    expect((await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P999999' } }, context)).payload).toEqual({ status: 'not_found', productKey: 'P999999' });
    expect((await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P556' } }, context)).payload).toMatchObject({ facts: { lifecycle: { listed: false } }, derived: { availability: { sellability: 'not_sellable', reason: 'not_listed' } } });
  });

  it('owner failures become failed observations with their own category (never a fake answer)', async () => {
    const cases: [number | string, string, boolean][] = [[401, 'unauthorized', false], [503, 'temporarily_unavailable', true], ['{bad', 'contract_violation', false]];
    for (const [status, category, retryable] of cases) {
      const { invoker } = setup(() => (typeof status === 'number' ? json(status, '') : json(200, status)));
      const o = await invoker.invoke({ capabilityId: 'catalog.get_product_context', arguments: { productKey: 'P898' } }, context);
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
