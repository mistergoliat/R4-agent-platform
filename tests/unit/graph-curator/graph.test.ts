import { describe, expect, it } from 'vitest';
import { graphStats, productGraphSchema } from '@r4-graph/curator';

const base = () => ({
  schemaVersion: 1,
  labels: { 'nu:a': 'Se usa con', 'nu:b': 'Se usa con' },
  products: { P1: { n: 'A', act: true, price: 1000, kind: null }, P2: { n: 'B', act: false, price: null, kind: 'X' } },
  view: { P1: { 'nu:a': ['P2'] }, P2: { 'nu:b': ['P1'] } } as Record<string, Record<string, string[]>>,
});

describe('product graph schema (ADR-058)', () => {
  it('accepts a consistent graph and counts each relation once', () => {
    const g = productGraphSchema.parse({ ...base(), unreviewed: [['nu', 'P1', 'P2']] });
    expect(graphStats(g)).toEqual({ products: 2, relations: 1, unreviewed: 1 });
  });

  it.each([
    ['a neighbour that is not a product', (g: ReturnType<typeof base>) => { g.view.P1!['nu:a'] = ['P3']; }, /not a product/u],
    ['an area without a label', (g: ReturnType<typeof base>) => { g.view.P1!['zz:a'] = ['P2']; }, /has no label/u],
    ['a key that is not a product key', (g: ReturnType<typeof base>) => { g.view['X1'] = {}; }, /./u],
  ])('rejects %s', (_name, mutate, message) => {
    const g = base();
    mutate(g);
    expect(() => productGraphSchema.parse(g)).toThrow(message);
  });

  it('an unreviewed mark must exist in both directions', () => {
    expect(() => productGraphSchema.parse({ ...base(), unreviewed: [['nu', 'P2', 'P1']] })).toThrow(/not a published relation/u);
  });
});
