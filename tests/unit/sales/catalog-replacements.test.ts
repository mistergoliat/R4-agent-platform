import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CatalogPort } from '@r4-adapters/domains';
import { catalogReplacementsCapability } from '../../../agents/sales/src/capabilities/catalog-build-step.js';

// EXPERIMENT ONLY: «lo reemplaza» from the graph file, status and prices from Catalog.
const products: Record<string, { n: string; price: number; sellable: boolean; act?: boolean }> = {
  P1: { n: 'Dual Bíceps ZR', price: 200_000, sellable: false },
  P2: { n: 'Banco Scott V8', price: 360_000, sellable: true },
  P3: { n: 'Preacher Pad', price: 28_000, sellable: true },
  P4: { n: 'Banco Scott MO', price: 500_000, sellable: false },
  P5: { n: 'Arm Blaster', price: 16_000, sellable: true },
  P6: { n: 'Dual Bíceps MO (inactivo)', price: 190_000, sellable: true, act: false },
  P7: { n: 'Dual Bíceps ZR - 2da Selección', price: 150_000, sellable: true },
};
const graph = {
  products: Object.fromEntries(Object.entries(products).map(([k, p]) => [k, { n: p.n, act: p.act ?? true, price: p.price, kind: null }])),
  view: { P1: { 'sub:a': ['P2', 'P3', 'P4', 'P6'], 'sub:b': ['P5'], 'vr:b': ['P7'] } },
};
const reports: string[] = [];
const catalog = {
  getProductContext: (key: string) => {
    const p = products[key];
    if (!p) return Promise.resolve({ status: 'not_found', productKey: key });
    return Promise.resolve({ status: 'found', productKey: key, facts: { name: p.n }, derived: { priceSummary: { finalGross: { amount: p.price } }, availability: { sellability: p.sellable ? 'sellable' : 'not_sellable' } }, freshness: { validUntil: '2026-11-20T23:00:00.000Z' } });
  },
} as unknown as CatalogPort;
const file = join(mkdtempSync(join(tmpdir(), 'replacements-')), 'graph.json');
writeFileSync(file, JSON.stringify(graph));
const cap = catalogReplacementsCapability(catalog, file, (_t, detail) => reports.push(detail));
const run = (input: Record<string, unknown>) => cap.handler(cap.input.parse(input), { signal: new AbortController().signal, execution: { correlationId: 'c', taskId: 't' } } as never);

describe('catalog.replacements (experiment)', () => {
  it('an unavailable product: its second selection and sellable replacements, closest in price first', async () => {
    reports.length = 0;
    const out = await run({ productKey: 'P1' });
    expect(out.product).toEqual({ productKey: 'P1', name: 'Dual Bíceps ZR', finalGrossClp: 200_000, sellable: false });
    expect(out.secondSelection.map((r) => r.productKey)).toEqual(['P7']);
    // P2 (160k away) before P3 (172k) and P5 (184k); P4 is not sellable; P6 is inactive.
    expect(out.replacements.map((r) => r.productKey)).toEqual(['P2', 'P3', 'P5']);
    expect(reports[0]).toBe('Buscando reemplazos para Dual Bíceps ZR…');
    expect(reports.at(-1)).toBe('Encontré 4 opciones disponibles');
  });

  it('respects the limit and the price ceiling', async () => {
    const out = await run({ productKey: 'P1', limit: 1, maxUnitPriceClp: 30_000 });
    expect(out.replacements.map((r) => r.productKey)).toEqual(['P3']);
    expect(out.secondSelection).toEqual([]);
  });

  it('a product outside the graph: no replacements, and says so', async () => {
    const out = await run({ productKey: 'P99' });
    expect(out).toMatchObject({ product: null, inGraph: false, secondSelection: [], replacements: [] });
  });
});
