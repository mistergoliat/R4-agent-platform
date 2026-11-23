import { describe, expect, it } from 'vitest';
import { curate, productGraphSchema, walkCatalog, type CatalogFact, type ProductSheetPort } from '@r4-graph/curator';

const graph = productGraphSchema.parse({
  schemaVersion: 1,
  labels: { 'ld:a': 'Discos', 'ld:b': 'Barras', 'sub:a': 'Lo reemplaza', 'sub:b': 'Lo reemplaza', 'nu:a': 'Se usa con', 'nu:b': 'Se usa con' },
  products: {
    P1: { n: 'Barra olímpica', act: true, price: 150000, kind: 'OLY_BAR' },
    P2: { n: 'Disco 20 kg', act: true, price: 60000, kind: 'PLATE_OLY' },
    P3: { n: 'Disco 10 kg', act: true, price: 40000, kind: 'PLATE_OLY' },
    P4: { n: 'Barra vieja', act: true, price: 90000, kind: 'OLY_BAR' },
    P5: { n: 'Rack', act: false, price: 500000, kind: 'SQUAT_RACK' },
    P6: { n: 'Mancuerna', act: true, price: 20000, kind: 'DB' },
  },
  view: {
    P1: { 'ld:a': ['P2', 'P3'], 'sub:a': ['P4'] },
    P2: { 'ld:b': ['P1', 'P4'], 'sub:b': ['P6'], 'nu:b': ['P6'] },
    P3: { 'ld:b': ['P1'] },
    P4: { 'ld:a': ['P2'], 'sub:b': ['P1'] },
    P6: { 'sub:a': ['P2'], 'nu:a': ['P2'] },
  },
});
const sheet = (over: Partial<CatalogFact> = {}): CatalogFact => ({ name: 'x', active: true, sellable: true, category: null, price: 1, specs: {}, ...over });
const rules = (catalog: Map<string, CatalogFact | 'not_found' | 'failed'>) => curate(graph, catalog).map((f) => `${f.rule} ${f.productKey}${f.relatedKey ? `-${f.relatedKey}` : ''}`).sort();

describe('curator rules (ADR-058 G2)', () => {
  it('reports new, discontinued, reactivated and renamed products, missing data and inconsistencies', () => {
    const catalog = new Map<string, CatalogFact | 'not_found' | 'failed'>([
      ['P1', sheet({ name: 'Barra olímpica | HWM', specs: { 'Diámetro de manga': '50 mm', 'Largo de agarre': '131 cm' } })],
      ['P2', sheet({ name: 'Disco 20 kg', sellable: false })], // out of stock; its only substitute (P6) is sellable
      ['P3', sheet({ name: 'Disco de 10 kg', specs: { 'Diámetro interno': '50 mm' } })], // renamed
      ['P4', 'not_found'], // discontinued
      ['P5', sheet({ name: 'Rack', specs: { Perfiles: '60x60' } })], // reactivated, no relations
      ['P6', 'failed'], // a failed read concludes nothing
      ['P7', sheet({ name: 'Collarín nuevo' })], // new
    ]);
    expect(rules(catalog)).toEqual([
      'DISCONTINUED P4',
      'NOT_IN_GRAPH P7',
      'REACTIVATED P5',
      'RENAMED P3',
      'SELLABLE_UNRELATED P5',
      'SPEC_MISSING P2',
      'SUBSTITUTE_AND_COMPLEMENT P2-P6',
      'SUBSTITUTE_KIND_MISMATCH P2-P6',
    ]);
    const missing = curate(graph, catalog).find((f) => f.rule === 'SPEC_MISSING')!;
    expect(missing.evidence).toEqual({ kind: 'PLATE_OLY', missing: ['Diámetro interno'], sellable: false });
  });

  it('an unsellable product with no sellable substitute, and an inactive one still related to active products', () => {
    const catalog = new Map<string, CatalogFact | 'not_found' | 'failed'>([
      ['P1', sheet({ sellable: false, name: 'Barra olímpica', specs: { 'Diámetro de manga': '50', 'Largo de agarre': '131' } })],
      ['P4', sheet({ name: 'Barra vieja', active: false, sellable: false })],
      ['P2', sheet({ name: 'Disco 20 kg', specs: { 'Diámetro interno': '50' } })],
    ]);
    const found = rules(catalog);
    expect(found).toContain('NO_SELLABLE_SUBSTITUTE P1');
    expect(found).toContain('DISCONTINUED P4');
    expect(found).toContain('INACTIVE_WITH_RELATIONS P4');
  });
});

describe('catalog walk', () => {
  const port = (known: Record<string, 'found' | 'fail'>): ProductSheetPort & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      getProductContext(key) {
        calls.push(key);
        if (known[key] === 'fail') return Promise.reject(new Error('boom'));
        if (known[key] !== 'found') return Promise.resolve({ status: 'not_found' as const });
        return Promise.resolve({ status: 'found' as const, facts: { name: key, status: { active: true }, category: null, specifications: [{ name: 'Material', value: 'acero' }] }, derived: { availability: { sellability: 'sellable' }, priceSummary: { finalGross: { amount: 1000 } } } });
      },
    };
  };

  it('reads every key up to the graph maximum, then above it until enough consecutive misses', async () => {
    const p = port({ P2: 'found', P3: 'fail', P6: 'found', P9: 'found' });
    const walk = await walkCatalog(p, ['P2', 'P4'], { concurrency: 1, tailMisses: 3 });
    // P1..P4, then P5.. above: P6 found resets, P9 found resets, stops after P10..P12 miss.
    expect([...p.calls].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12']);
    expect(walk.counts).toEqual({ scanned: 12, found: 3, notFound: 8, failed: 1 });
    expect(walk.sheets.get('P2')).toEqual({ name: 'P2', active: true, sellable: true, category: null, price: 1000, specs: { Material: 'acero' } });
  });

  it('a catalog outage ends the walk (failed reads count as misses)', async () => {
    const all = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`P${i + 1}`, 'fail' as const]));
    const walk = await walkCatalog(port(all), ['P2'], { concurrency: 2, tailMisses: 4 });
    expect(walk.counts.failed).toBe(walk.counts.scanned);
    expect(walk.counts.scanned).toBeLessThan(10);
  });
});
