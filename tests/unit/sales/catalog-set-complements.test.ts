import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CatalogPort } from '@r4-adapters/domains';
import { catalogSetComplementsCapability, spread } from '../../../agents/sales/src/capabilities/catalog-set-complements.js';

// EXPERIMENT ONLY (graph A/B): relations come from the exported file, price and sellability from Catalog.
const graph = {
  labels: { 'rb:a': 'Barras que apoyan en este rack', 'nu:b': 'Complementos (nueva)', 'bpc:a': 'Discos sugeridos' },
  products: {
    R: { n: 'Rack', act: true, price: 500_000 },
    B1: { n: 'Barra cara', act: true, price: 300_000 },
    B2: { n: 'Barra barata', act: true, price: 90_000 },
    B3: { n: 'Barra inactiva', act: false, price: 50_000 },
    B4: { n: 'Barra agotada', act: true, price: 95_000 },
    F: { n: 'Piso', act: true, price: 20_000 },
  },
  view: { P1: { 'rb:a': ['P11', 'P12', 'P13', 'P14'], 'nu:b': ['P20'], 'bpc:a': [] } },
};
const keyed = (g: typeof graph): unknown => JSON.parse(JSON.stringify(g).replace(/"R"/g, '"P1"').replace(/"B(\d)"/g, '"P1$1"').replace(/"F"/g, '"P20"'));

const live: Record<string, { name: string; price: number; sellability: string }> = {
  P11: { name: 'Barra cara', price: 310_000, sellability: 'sellable' },
  P12: { name: 'Barra barata', price: 89_990, sellability: 'sellable' },
  P14: { name: 'Barra agotada', price: 95_000, sellability: 'not_sellable' },
  P20: { name: 'Piso', price: 19_990, sellability: 'sellable' },
};
const reads: string[] = [];
const catalog = {
  getProductContext: (key: string) => {
    reads.push(key);
    const l = live[key];
    if (!l) return Promise.resolve({ status: 'not_found', productKey: key });
    return Promise.resolve({ status: 'found', productKey: key, facts: { name: l.name }, derived: { priceSummary: { finalGross: { amount: l.price } }, availability: { sellability: l.sellability } }, freshness: { validUntil: '2026-11-18T20:00:00.000Z' } });
  },
} as unknown as CatalogPort;

function capability() {
  const file = join(mkdtempSync(join(tmpdir(), 'graph-ab-')), 'graph.json');
  writeFileSync(file, JSON.stringify(keyed(graph)));
  return catalogSetComplementsCapability(catalog, file);
}
const run = (input: Record<string, unknown>) => capability().handler(input as never, { signal: new AbortController().signal, execution: { correlationId: 'c', taskId: 't' } } as never);

describe('catalog.set_complements (experiment)', () => {
  it('returns only active, sellable candidates, cheapest first, with live prices; inactive never read', async () => {
    reads.length = 0;
    const out = await run({ anchorKeys: ['P1'], perRelation: 3 });
    expect(out.relations.map((r) => r.relation)).toEqual(['Barras que apoyan en este rack', 'Complementos']);
    expect(out.relations[0]!.candidates).toEqual([
      { productKey: 'P12', name: 'Barra barata', finalGrossClp: 89_990, sellability: 'sellable' },
      { productKey: 'P11', name: 'Barra cara', finalGrossClp: 310_000, sellability: 'sellable' },
    ]);
    expect(reads).not.toContain('P13');
    expect(out.validUntil).toBe('2026-11-18T20:00:00.000Z');
  });

  it('drops candidates above the budget, by snapshot and by live price', async () => {
    const out = await run({ anchorKeys: ['P1'], perRelation: 3, maxUnitPriceClp: 100_000 });
    expect(out.relations[0]!.candidates.map((c) => c.productKey)).toEqual(['P12']);
  });

  it('says when an anchor is not in the graph', async () => {
    const out = await run({ anchorKeys: ['P999'], perRelation: 3 });
    expect(out.anchors).toEqual([{ productKey: 'P999', name: null, inGraph: false }]);
    expect(out.relations).toEqual([]);
  });

  it('spreads picks over the price range', () => {
    expect(spread([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([1, 4, 7]);
    expect(spread([1, 2], 3)).toEqual([1, 2]);
  });
});
