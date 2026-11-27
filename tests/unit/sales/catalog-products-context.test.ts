import { describe, expect, it } from 'vitest';
import type { Observation } from '@r4/contracts';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { DomainError, FixtureCatalog, type CatalogPort, type CatalogProductContext } from '@r4-adapters/domains';
import { LANE_CAPABILITY_IDS, PRODUCTS_CONTEXT_MAX_KEYS, catalogCapabilities, catalogDescriptiveItems, catalogProductsContextCapability, deskSignalsOf } from '@r4-sales/agent';
import { withWebProgress, type WebProgressReporter } from '@r4-sales/agent/production';
import { FakeClock, idsFrom } from '../../support/deterministic.js';
import { InMemoryObservationStore } from '../../support/memory-observation-store.js';

/**
 * (sales-web@24) catalog.get_products_context: up to 8 products in one read, in parallel, each exactly what
 * catalog.get_product_context returns for it; a product that fails is reported per item. Fake Catalog port, no network.
 */
const execution = { taskId: '0190a0a0-0000-7000-8000-0000000000aa', runId: '0190a0a0-0000-7000-8000-0000000000bb', agentId: 'sales-web', agentVersion: 24, correlationId: 'corr-batch', grantedScopes: ['catalog.read'] };
const NOW = '2026-11-26T15:00:00.000Z';
const BATCH = LANE_CAPABILITY_IDS.catalogProductsContext;
/** The options a web profile reads with (composition.ts): per-variant sellability and the promotion annotation. */
const WEB_READS = { variantAvailability: true, stockCount: false, promotions: { eligibility: { promotionsAllowed: false }, now: () => new Date(NOW) } };

function setup(port: (fixture: FixtureCatalog) => CatalogPort = (f) => f) {
  const clock = new FakeClock(NOW);
  const catalog = port(new FixtureCatalog({ now: () => clock.now() }));
  const registry = new CapabilityRegistry();
  for (const r of catalogCapabilities(catalog, WEB_READS)) registry.register(r as never);
  registry.register(catalogProductsContextCapability(catalog, WEB_READS) as never);
  const invoker = new CapabilityInvoker({ registry, observations: new InMemoryObservationStore(), ids: idsFrom(clock), clock, logger: createSilentLogger() });
  return { clock, read: (capabilityId: string, args: Record<string, unknown>) => invoker.invoke({ capabilityId, arguments: args }, execution) };
}

/** A port that records each product request and answers only when released (in the order given). */
function gated(fixture: FixtureCatalog) {
  const requested: string[] = [];
  const waiting = new Map<string, () => void>();
  const port: CatalogPort = {
    search: (r, o) => fixture.search(r, o),
    getItemContext: (r, o) => fixture.getItemContext(r, o),
    getProductContext: (key, o) => {
      requested.push(key);
      return new Promise<void>((resolve) => waiting.set(key, resolve)).then(() => fixture.getProductContext(key, o));
    },
  };
  return { port, requested, release: (keys: readonly string[]) => keys.forEach((k) => waiting.get(k)!()) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const products = (o: Observation) => (o.payload as { products: { productKey: string; status: string }[] }).products;

describe('catalog.get_products_context', () => {
  it('asks Catalog for every key before any answer arrives (parallel) and keeps the input order whatever order they answer in', async () => {
    let gate!: ReturnType<typeof gated>;
    const { read } = setup((f) => (gate = gated(f)).port);
    const pending = read(BATCH, { productKeys: ['KB-COMP', 'BAR-OLY20', 'DB-ADJ-24'] });
    await flush();
    expect(gate.requested).toEqual(['KB-COMP', 'BAR-OLY20', 'DB-ADJ-24']);
    gate.release(['DB-ADJ-24', 'BAR-OLY20', 'KB-COMP']);
    const o = await pending;
    expect(o.outcome).toBe('succeeded');
    expect(products(o).map((p) => p.productKey)).toEqual(['KB-COMP', 'BAR-OLY20', 'DB-ADJ-24']);
  });

  it('reads a repeated key once', async () => {
    let gate!: ReturnType<typeof gated>;
    const { read } = setup((f) => (gate = gated(f)).port);
    const pending = read(BATCH, { productKeys: ['BAR-OLY20', 'KB-16', 'BAR-OLY20'] });
    await flush();
    gate.release(['BAR-OLY20', 'KB-16']);
    expect(products(await pending).map((p) => p.productKey)).toEqual(['BAR-OLY20', 'KB-16']);
    expect(gate.requested).toEqual(['BAR-OLY20', 'KB-16']);
  });

  it('each item is exactly what catalog.get_product_context returns for it (variants, promotion annotation, not_found)', async () => {
    const { read } = setup();
    const keys = ['KB-COMP', 'BAR-OLY20', 'NOPE-1'];
    const batch = await read(BATCH, { productKeys: keys });
    const singles = await Promise.all(keys.map((productKey) => read('catalog.get_product_context', { productKey })));
    expect(products(batch)).toEqual(singles.map((s) => s.payload));
    expect(products(batch)[2]).toEqual({ status: 'not_found', productKey: 'NOPE-1' });
    // The per-variant availability the single read adds is there too (KB-COMP has several variants).
    const first = products(batch)[0] as unknown as { status: string; facts: { variantOptions: { availability: { status: string } }[] } };
    expect(first.status).toBe('found');
    expect(first.facts.variantOptions.length).toBeGreaterThanOrEqual(2);
    expect(first.facts.variantOptions.every((v) => v.availability.status === 'reported')).toBe(true);
  });

  it('a product Catalog fails for is reported on its own (the owner category) and the others are still answered', async () => {
    const { read } = setup((f) => ({ ...f, search: f.search.bind(f), getItemContext: f.getItemContext.bind(f), getProductContext: (key, o) => (key === 'KB-16' ? Promise.reject(new DomainError('temporarily_unavailable', 'catalog_503', 'catalog 503')) : f.getProductContext(key, o)) }));
    const o = await read(BATCH, { productKeys: ['BAR-OLY20', 'KB-16'] });
    expect(o.outcome).toBe('succeeded');
    expect(products(o)).toEqual([expect.objectContaining({ status: 'found', productKey: 'BAR-OLY20' }), { status: 'failed', productKey: 'KB-16', error: { category: 'temporarily_unavailable', code: 'catalog_503', retryable: true } }]);
  });

  it('when no product can be read the call fails like a single read (a failed observation with the owner category)', async () => {
    const down = (): Promise<CatalogProductContext> => Promise.reject(new DomainError('temporarily_unavailable', 'catalog_503', 'catalog 503'));
    const { read } = setup((f) => ({ search: f.search.bind(f), getItemContext: f.getItemContext.bind(f), getProductContext: down }));
    expect(await read(BATCH, { productKeys: ['BAR-OLY20', 'KB-16'] })).toMatchObject({ outcome: 'failed', payload: null, error: { code: 'handler_error', details: { category: 'temporarily_unavailable', retryable: true } } });
  });

  it(`refuses more than ${PRODUCTS_CONTEXT_MAX_KEYS} keys, none, an invalid key or unknown fields, before asking Catalog`, async () => {
    let gate!: ReturnType<typeof gated>;
    const { read } = setup((f) => (gate = gated(f)).port);
    const nine = Array.from({ length: PRODUCTS_CONTEXT_MAX_KEYS + 1 }, (_, i) => `P${i + 1}`);
    for (const args of [{ productKeys: nine }, { productKeys: [] }, { productKeys: ['no spaces'] }, { productKey: 'P1' }, { productKeys: ['P1'], extra: true }]) {
      expect(await read(BATCH, args), JSON.stringify(args)).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_arguments' } });
    }
    expect(gate.requested).toEqual([]);
    // The model is told the limit.
    expect(catalogProductsContextCapability(new FixtureCatalog()).definition.description).toContain(`up to ${PRODUCTS_CONTEXT_MAX_KEYS} products`);
  });

  it('ADR-030: one observation, valid until the EARLIEST owner window of its products; each item keeps its own freshness', async () => {
    const until: Record<string, string> = { 'BAR-OLY20': '2026-11-26T15:00:40.000Z', 'KB-16': '2026-11-26T15:00:15.000Z' };
    const { read } = setup((f) => ({ search: f.search.bind(f), getItemContext: f.getItemContext.bind(f), getProductContext: async (key, o) => { const c = await f.getProductContext(key, o); return c.status === 'found' ? { ...c, freshness: { ...c.freshness, validUntil: until[key]! } } : c; } }));
    const o = await read(BATCH, { productKeys: ['BAR-OLY20', 'KB-16'] });
    expect(o.validUntil).toBe('2026-11-26T15:00:15.000Z');
    expect(o.provenance).toMatchObject({ freshness: { ownerValidUntil: '2026-11-26T15:00:15.000Z', bound: 'owner' } });
    expect(products(o).map((p) => (p as unknown as { freshness: { validUntil: string } }).freshness.validUntil)).toEqual([until['BAR-OLY20'], until['KB-16']]);
  });

  it('with the descriptive window, each found product of an expired batch read keeps its own descriptive item (no price or stock)', async () => {
    const { read, clock } = setup();
    const o = await read(BATCH, { productKeys: ['BAR-OLY20', 'NOPE-1', 'KB-16'] });
    const later = new Date(clock.now().getTime() + 6 * 60_000);
    const items = catalogDescriptiveItems([o], later, 30 * 60_000);
    expect(items.map((i) => i.itemId)).toEqual([`sales_catalog_descriptive:${o.observationId}:BAR-OLY20`, `sales_catalog_descriptive:${o.observationId}:KB-16`]);
    expect(items.map((i) => (i.content as { descriptive: { productKey: string } }).descriptive.productKey)).toEqual(['BAR-OLY20', 'KB-16']);
    expect(JSON.stringify(items)).not.toMatch(/"(price|derived|availability|sellability)":/u);
  });

  it('counts as a product read for the desk signals, and the web chat shows the names it found', async () => {
    const { read } = setup();
    const o = await read(BATCH, { productKeys: ['BAR-OLY20', 'KB-16'] });
    expect(deskSignalsOf([o], 'conversacion')).toEqual(['producto']);
    const calls: (string | null)[] = [];
    const reporter: WebProgressReporter = { report: (_t, step, detail) => calls.push(`${step}:${detail}`) };
    const registration = withWebProgress(catalogProductsContextCapability(new FixtureCatalog()), reporter);
    await registration.handler({ productKeys: ['BAR-OLY20', 'KB-16'] }, { execution: { ...execution, actor: { kind: 'service', ref: 'x' } }, signal: new AbortController().signal } as never);
    expect(calls).toEqual(['product:Barra olímpica 20 kg (2,2 m), Kettlebell 16 kg']);
  });
});
