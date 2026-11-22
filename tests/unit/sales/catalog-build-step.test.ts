import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CatalogPort } from '@r4-adapters/domains';
import { catalogBuildStepCapability, unitKg } from '../../../agents/sales/src/capabilities/catalog-build-step.js';

// EXPERIMENT ONLY (sequential builder): compatibility from the graph file, prices and sellability from Catalog.
const products: Record<string, { n: string; kind: string; price: number; sellable?: boolean }> = {
  P1: { n: 'Power Rack', kind: 'SQUAT_RACK', price: 200_000 },
  P2: { n: 'Rack caro', kind: 'SQUAT_RACK', price: 900_000 },
  P10: { n: 'Barra Olímpica 15kg', kind: 'OLY_BAR', price: 50_000 },
  P11: { n: 'Barra Olímpica 20kg', kind: 'OLY_BAR', price: 100_000 },
  P12: { n: 'Barra Olímpica 20kg Pro', kind: 'OLY_BAR', price: 150_000 },
  P13: { n: 'Barra que no apoya', kind: 'OLY_BAR', price: 40_000 },
  P20: { n: 'Par Bumper 10kg', kind: 'PLATE_OLY', price: 40_000 },
  P21: { n: 'Par Bumper 20kg', kind: 'PLATE_OLY', price: 90_000 },
  P22: { n: 'Pack 100kg Discos', kind: 'PLATE_OLY', price: 300_000, sellable: false },
  P30: { n: 'Banco Regulable', kind: 'BENCH', price: 120_000 },
  P31: { n: 'Banco Olímpico con soportes', kind: 'BENCH_STATION', price: 300_000 },
};
const graph = {
  products: Object.fromEntries(Object.entries(products).map(([k, p]) => [k, { n: p.n, act: true, price: p.price, kind: p.kind }])),
  view: {
    P1: { 'rb:a': ['P10', 'P11', 'P12'], 'br:b': ['P30'] },
    P2: { 'rb:a': ['P10', 'P11', 'P12'] },
    P10: { 'bpc:a': ['P20', 'P21', 'P22'], 'rb:b': ['P1'] },
    P11: { 'bpc:a': ['P20', 'P21', 'P22'], 'nu:a': ['P31'] },
    P12: { 'bpc:a': ['P20', 'P21', 'P22'] },
  },
};
// Live price that differs from the graph snapshot (a price change or an offer since the graph was built).
const livePrice: Record<string, number> = {};
const catalog = {
  getProductContext: (key: string) => {
    const p = products[key];
    if (!p) return Promise.resolve({ status: 'not_found', productKey: key });
    return Promise.resolve({ status: 'found', productKey: key, facts: { name: p.n }, derived: { priceSummary: { finalGross: { amount: livePrice[key] ?? p.price } }, availability: { sellability: p.sellable === false ? 'not_sellable' : 'sellable' } }, freshness: { validUntil: '2026-11-19T20:00:00.000Z' } });
  },
} as unknown as CatalogPort;
const file = join(mkdtempSync(join(tmpdir(), 'build-step-')), 'graph.json');
writeFileSync(file, JSON.stringify(graph));
const reports: { taskId: string; detail: string; products?: readonly string[] }[] = [];
const cap = catalogBuildStepCapability(catalog, file, (taskId, detail, products) => reports.push({ taskId, detail, ...(products ? { products } : {}) }));
const run = (input: Record<string, unknown>) => cap.handler(cap.input.parse(input), { signal: new AbortController().signal, execution: { correlationId: 'c', taskId: 't' } } as never);

describe('catalog.build_step (experiment)', () => {
  it('tells the store chat what it is doing: search, reserve, count, the picks', async () => {
    reports.length = 0;
    await run({ step: 'barra', selected: [{ productKey: 'P1', quantity: 1 }], budgetMaxClp: 1_000_000 });
    expect(reports.map((r) => r.detail)).toEqual([
      'Buscando barras que calcen con Power Rack…',
      'Guardo $80.000 para discos',
      '3 barras compatibles en tu presupuesto · revisando precio y stock',
      'Elegí 3 opciones, de menor a mayor precio',
    ]);
    expect(reports.at(-1)?.products).toEqual(['P10', 'P11', 'P12']);
    expect(reports.every((r) => r.taskId === 't' && r.detail.length <= 80)).toBe(true);
  });

  it('a progress reporter that throws never fails the step', async () => {
    const throwing = catalogBuildStepCapability(catalog, file, () => { throw new Error('edge down'); });
    const out = await throwing.handler(throwing.input.parse({ step: 'barra', selected: [{ productKey: 'P1', quantity: 1 }], budgetMaxClp: 1_000_000 }), { signal: new AbortController().signal, execution: { correlationId: 'c', taskId: 't' } } as never);
    expect(out.options).toHaveLength(3);
  });

  it('plates that cannot reach the load with 4 units are not offered', async () => {
    const out = await run({ step: 'discos', selected: [{ productKey: 'P1', quantity: 1 }, { productKey: 'P11', quantity: 1 }], budgetMaxClp: 1_000_000, targetPlateKg: 100 });
    expect(out.options.map((o) => [o.productKey, o.quantity, o.totalKg])).toEqual([['P21', 3, 120]]); // «Par 10kg» × 4 = 80 kg < 100: out
  });

  it('a rack reserves its bar and plates: a rack that leaves no room for them is not offered', async () => {
    const out = await run({ step: 'rack', budgetMaxClp: 400_000 });
    expect(out.stillNeeded).toEqual(['barra', 'discos']);
    expect(out.reservedForNeededClp).toBe(120_000); // cheapest bar (P13, 40k: no rack chosen yet) + 40 kg of plates (2 × «Par 10kg» = 80k)
    expect(out.options.map((o) => o.productKey)).toEqual(['P1']);
  });

  it('a variant key from the cart counts as its product', async () => {
    const out = await run({ step: 'barra', selected: [{ productKey: 'P1-V7', quantity: 1 }], budgetMaxClp: 1_000_000 });
    expect(out.options.map((o) => o.productKey)).toEqual(['P10', 'P11', 'P12']);
  });

  it('the bar must rest on the chosen rack; labels follow the price', async () => {
    const out = await run({ step: 'barra', selected: [{ productKey: 'P1', quantity: 1 }], budgetMaxClp: 1_000_000 });
    expect(out.options.map((o) => [o.tier, o.productKey])).toEqual([['menor precio', 'P10'], ['precio medio', 'P11'], ['mayor precio', 'P12']]);
    expect(out.remainingBudgetClp).toBe(800_000);
  });

  it('the labels follow the live price, not the graph snapshot (owner 2026-11-22: price order only)', async () => {
    livePrice.P10 = 160_000; // was the cheapest in the graph; now the most expensive
    try {
      const out = await run({ step: 'barra', selected: [{ productKey: 'P1', quantity: 1 }], budgetMaxClp: 1_000_000 });
      expect(out.options.map((o) => [o.tier, o.productKey, o.totalClp])).toEqual([['menor precio', 'P11', 100_000], ['precio medio', 'P12', 150_000], ['mayor precio', 'P10', 160_000]]);
    } finally {
      delete livePrice.P10;
    }
  });

  it('plates reach the target load, skip unsellable packs and stay within the budget', async () => {
    const out = await run({ step: 'discos', selected: [{ productKey: 'P1', quantity: 1 }, { productKey: 'P11', quantity: 1 }], budgetMaxClp: 500_000, targetPlateKg: 40 });
    expect(out.options.map((o) => [o.productKey, o.quantity, o.totalKg, o.totalClp])).toEqual([['P20', 2, 40, 80_000], ['P21', 1, 40, 90_000]]);
    expect(out.options.map((o) => o.tier)).toEqual(['menor precio', 'mayor precio']);
  });

  it('the bench is constrained by the rack only, not by the bench relations of the bar', async () => {
    const out = await run({ step: 'banco', selected: [{ productKey: 'P1', quantity: 1 }, { productKey: 'P11', quantity: 1 }, { productKey: 'P21', quantity: 1 }], budgetMaxClp: 1_000_000 });
    expect(out.options.map((o) => o.productKey)).toEqual(['P30']);
  });

  it('a rack chosen after its bar must hold that bar', async () => {
    const out = await run({ step: 'rack', selected: [{ productKey: 'P10', quantity: 1 }], budgetMaxClp: 5_000_000 });
    expect(out.options.map((o) => o.productKey)).toEqual(['P1']);
  });

  it('a bench with its own bar rests is not offered before a bar is chosen', async () => {
    const out = await run({ step: 'banco', budgetMaxClp: 5_000_000 });
    expect(out.options.map((o) => o.productKey)).toEqual(['P30']);
  });

  it('says why when the budget is used up', async () => {
    const out = await run({ step: 'discos', selected: [{ productKey: 'P2', quantity: 1 }, { productKey: 'P12', quantity: 1 }], budgetMaxClp: 1_000_000 });
    expect(out.options).toEqual([]);
    expect(out.reason).toMatch(/budget/u);
  });

  it('reads plate weight from the name', () => {
    expect(unitKg('Par Bumper Plates Eco 10kg')).toBe(20);
    expect(unitKg('Pack 150kg Classic Black')).toBe(150);
    expect(unitKg('Par Discos Olímpicos 45 lb')).toBeCloseTo(40.8, 1);
  });
});
