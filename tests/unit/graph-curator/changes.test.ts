import { describe, expect, it } from 'vitest';
import { applyChanges, changeOf, graphStats, productGraphSchema, type Finding } from '@r4-graph/curator';

const graph = productGraphSchema.parse({
  schemaVersion: 1,
  labels: { 'sub:a': 'Lo reemplaza', 'sub:b': 'Lo reemplaza', 'nu:a': 'Se usa con', 'nu:b': 'Se usa con' },
  products: { P1: { n: 'A', act: true, price: 1, kind: 'X' }, P2: { n: 'B', act: true, price: 1, kind: 'Y' }, P3: { n: 'C', act: true, price: 1, kind: 'X' } },
  view: {
    P1: { 'sub:a': ['P2'], 'nu:a': ['P3'] },
    P2: { 'sub:b': ['P1'], 'nu:a': ['P3'] },
    P3: { 'nu:b': ['P1', 'P2'] },
  },
  unreviewed: [['nu', 'P1', 'P3'], ['sub', 'P1', 'P2']],
});
const finding = (rule: string, extra: Partial<Finding> = {}): Finding => ({ task: 'inconsistency', rule, productKey: 'P1', relatedKey: null, summary: 's', evidence: {}, ...extra });

describe('graph changes (ADR-058 G3)', () => {
  it('maps each rule to its change; informational findings change nothing', () => {
    expect(changeOf(finding('DISCONTINUED', { evidence: { relations: 2 } }))).toEqual({ change: { op: 'deactivate', key: 'P1' }, effect: 'Al aprobar: queda inactivo en el grafo y se quitan sus 2 relaciones.' });
    expect(changeOf(finding('RENAMED', { evidence: { after: 'Nuevo | HWM' } })).change).toEqual({ op: 'rename', key: 'P1', name: 'Nuevo' });
    expect(changeOf(finding('SUBSTITUTE_KIND_MISMATCH', { relatedKey: 'P2' })).change).toEqual({ op: 'remove_relation', area: 'sub', a: 'P1', b: 'P2' });
    for (const rule of ['SPEC_MISSING', 'NO_SELLABLE_SUBSTITUTE', 'NOT_IN_GRAPH', 'SELLABLE_UNRELATED']) expect(changeOf(finding(rule)).change).toBeNull();
  });

  it('deactivating drops every relation of the product (both sides) and its unreviewed marks', () => {
    const g = applyChanges(graph, [{ op: 'deactivate', key: 'P1' }]);
    expect(g.products.P1!.act).toBe(false);
    expect(g.view).toEqual({ P2: { 'nu:a': ['P3'] }, P3: { 'nu:b': ['P2'] } });
    expect(g.unreviewed).toEqual([]);
    expect(graphStats(g).relations).toBe(1);
  });

  it('removing a relation touches only that area; changes are idempotent; the input is not mutated', () => {
    const once = applyChanges(graph, [{ op: 'remove_relation', area: 'sub', a: 'P2', b: 'P1' }, { op: 'rename', key: 'P3', name: 'C2' }]);
    const twice = applyChanges(once, [{ op: 'remove_relation', area: 'sub', a: 'P1', b: 'P2' }]);
    expect(twice).toEqual(once);
    expect(once.view.P1).toEqual({ 'nu:a': ['P3'] });
    expect(once.unreviewed).toEqual([['nu', 'P1', 'P3']]);
    expect(once.products.P3!.n).toBe('C2');
    expect(graph.view.P1).toEqual({ 'sub:a': ['P2'], 'nu:a': ['P3'] });
  });
});
