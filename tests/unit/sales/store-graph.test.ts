import { describe, expect, it } from 'vitest';
import type { CatalogPort } from '@r4-adapters/domains';
import { createSilentLogger } from '@r4/observability';
import { catalogBuildStepCapability } from '../../../agents/sales/src/capabilities/catalog-build-step.js';
import { SignedStoreGraph } from '../../../agents/sales/src/production/store-graph.js';

/** ADR-058 G5: the web tools read the owner-signed store graph, refreshed in the background, never half a graph. */
const graph = (barKey: string) => ({
  schemaVersion: 1, labels: {}, unreviewed: [],
  products: { P1: { n: 'Power Rack', act: true, price: 200_000, kind: 'SQUAT_RACK' }, [barKey]: { n: `Barra ${barKey}`, act: true, price: 100_000, kind: 'OLY_BAR' } },
  view: { P1: { 'rb:a': [barKey] }, [barKey]: { 'rb:b': ['P1'] } },
});
const signed = { version: 1, content: graph('P10') as unknown };
let failNext = false;
const read = () => {
  if (failNext) { failNext = false; return Promise.reject(new Error('db down')); }
  return Promise.resolve(signed);
};
const catalog = {
  getProductContext: (key: string) => Promise.resolve({ status: 'found', productKey: key, facts: { name: `Producto ${key}`, specifications: [] }, derived: { priceSummary: { finalGross: { amount: 100_000 } }, availability: { sellability: 'sellable' } }, freshness: { validUntil: null } }),
} as unknown as CatalogPort;

describe('signed store graph (ADR-058 G5)', () => {
  it('nothing signed: null (the worker falls back to the exported file)', async () => {
    expect(await SignedStoreGraph.load(() => Promise.resolve(null), createSilentLogger())).toBeNull();
  });

  it('a malformed signed version stops the start', async () => {
    await expect(SignedStoreGraph.load(() => Promise.resolve({ version: 1, content: { products: { P1: { n: 'x' } }, view: {} } }), createSilentLogger())).rejects.toThrow(/store graph product-graph v1 is malformed/u);
  });

  it('the tools read the version the source holds; a newer one swaps in, a failed or malformed refresh keeps it', async () => {
    const source = (await SignedStoreGraph.load(read, createSilentLogger()))!;
    const cap = catalogBuildStepCapability(catalog, source);
    const bars = async () => ((await cap.handler(cap.input.parse({ step: 'barra', budgetMaxClp: 1_000_000, selected: [{ productKey: 'P1', quantity: 1 }] }), { signal: new AbortController().signal, execution: { correlationId: 'c', taskId: 't' } } as never)) as { options: { productKey: string }[] }).options.map((o) => o.productKey);
    expect(await bars()).toEqual(['P10']);
    expect(await source.refresh()).toBe(false); // same version

    signed.version = 2; signed.content = graph('P11');
    expect(await source.refresh()).toBe(true);
    expect([source.version, await bars()]).toEqual([2, ['P11']]);

    failNext = true;
    expect(await source.refresh()).toBe(false);
    signed.version = 3; signed.content = { products: {}, view: 'broken' };
    expect(await source.refresh()).toBe(false);
    expect([source.version, await bars()]).toEqual([2, ['P11']]);
  });
});
