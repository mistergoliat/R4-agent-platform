import { describe, expect, it } from 'vitest';
import { applyChanges, checkClassification, checkPlan, checkReview, presentProposal, productGraphSchema, relationsOfProducts, revertChange, type GraphChange, type ProductSheetView } from '@r4-graph/curator';

/**
 * ADR-058 Decision 11 (G7b): retyping a relation (and undoing it), the plan check, and signed criteria as evidence.
 * These cases are their regression set.
 */
const graph = productGraphSchema.parse({
  schemaVersion: 1,
  labels: { 'ld:a': 'Discos para cargarla', 'ld:b': 'Máquinas e implementos que carga', 'ec:a': 'Se usa junto con', 'ec:b': 'Se usa junto con' },
  products: { P1: { n: 'Deadlift Jack Bar', act: true, price: 1, kind: 'JACK' }, P2: { n: 'Barra Elite', act: true, price: 1, kind: 'OLY_BAR' }, P3: { n: 'Barra Training', act: true, price: 1, kind: 'OLY_BAR' } },
  view: { P1: { 'ld:a': ['P2', 'P3'] }, P2: { 'ld:b': ['P1'] }, P3: { 'ld:b': ['P1'] } },
  unreviewed: [['ld', 'P1', 'P2'], ['ld', 'P1', 'P3']],
});
const retype: GraphChange = { op: 'retype_relations', from: 'ld', to: 'ec', relations: [['P1', 'P2']] };

describe('retype_relations', () => {
  it('moves the relation to the new type on both sides and clears its mark; undo puts it back with the mark', () => {
    const next = applyChanges(graph, [retype]);
    expect([next.view.P1, next.view.P2, next.unreviewed]).toEqual([{ 'ld:a': ['P3'], 'ec:a': ['P2'] }, { 'ec:b': ['P1'] }, [['ld', 'P1', 'P3']]]);
    const back = revertChange(next, graph, retype);
    expect([back.view.P1, back.view.P2]).toEqual([{ 'ld:a': ['P3', 'P2'] }, { 'ld:b': ['P1'] }]);
    expect(back.unreviewed).toContainEqual(['ld', 'P1', 'P2']);
  });

  it('ignores a relation that is not there with that type (idempotent: applying twice changes nothing more)', () => {
    const once = applyChanges(graph, [retype]);
    expect(applyChanges(once, [retype])).toEqual(once);
  });

  it('reads as a question with both labels', () => {
    expect(presentProposal(graph, { summary: '', change: { op: 'retype_relations', from: 'ld', to: 'ec', relations: [['P1', 'P2'], ['P1', 'P3']] } }, new Map())).toMatchObject({
      group: 'changes', yes: 'approve', question: '¿Cambiamos las 2 relaciones de «Deadlift Jack Bar» de «Discos para cargarla» a «Se usa junto con»?',
    });
  });
});

describe('the plan check', () => {
  const ctx = { graph, similarIds: new Set(['s1']), relations: relationsOfProducts(graph, ['P1']) };
  const sound = { summary: 'no las quito, cambio el tipo', proposal: 'reject', similar: [{ id: 's1', decision: 'reject', reason: 'igual' }], changes: [{ op: 'retype_relations', from: 'ld', to: 'ec', relations: [['P1', 'P2'], ['P1', 'P3']] }], criterion: 'Los soportes tipo jack se usan junto con las barras.' };

  it('passes a plan on the relations and open proposals of the task', () => {
    expect(relationsOfProducts(graph, ['P1']).map((r) => r.join('|')).sort()).toEqual(['ld|P1|P2', 'ld|P1|P3']);
    expect(checkPlan(sound, ctx)).toMatchObject({ ok: true });
  });

  it.each([
    ['a similar proposal that is not in the task', { similar: [{ id: 's9', decision: 'reject', reason: 'x' }] }, /s9 is not one of the open proposals/u],
    ['a relation the graph does not have', { changes: [{ op: 'retype_relations', from: 'ld', to: 'ec', relations: [['P2', 'P3']] }] }, /ld P2–P3 is not a relation/u],
    ['a type the graph does not have', { changes: [{ op: 'retype_relations', from: 'ld', to: 'zz', relations: [['P1', 'P2']] }] }, /a type the graph does not have/u],
    ['a change a plan may not make', { changes: [{ op: 'set_kind', key: 'P1', kind: 'X' }] }, /set_kind is not allowed/u],
    ['adding a relation outside the task products', { changes: [{ op: 'add_relations', relations: [['ec', 'P1', 'P9']] }] }, /outside the products/u],
  ])('refuses the whole plan with %s', (_n, over, reason) => {
    const r = checkPlan({ ...sound, ...over }, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.violations.join('; ')).toMatch(reason);
  });

  it('refuses a bad shape', () => {
    expect(checkPlan({ ...sound, proposal: 'maybe' }, ctx)).toMatchObject({ ok: false });
  });
});

describe('signed criteria count as evidence', () => {
  const sheet = (k: string): ProductSheetView => ({ productKey: k, found: true, name: k, category: null, active: true, specifications: [] });
  const sheets = new Map([['P1', sheet('P1')], ['P2', sheet('P2')]]);
  const keep = { area: 'ld', a: 'P1', b: 'P2', verdict: 'keep', reason: 'el criterio lo dice', evidence: [{ product: 'P1', field: 'Criterio', value: 'c-1' }] };

  it('in a review, only a criterion the task received', () => {
    expect(checkReview({ verdicts: [keep] }, [['ld', 'P1', 'P2']], sheets, new Set(['c-1']))).toMatchObject({ ok: true, refused: [] });
    expect(checkReview({ verdicts: [keep] }, [['ld', 'P1', 'P2']], sheets)).toMatchObject({ ok: true, refused: [{ reason: 'criterion c-1 is not a signed criterion of this task' }] });
  });

  it('in a classification, the same', () => {
    const c = { kind: 'JACK', muscles: [], evidence: [{ field: 'Criterio', value: 'c-1' }], confidence: 'high' };
    expect(checkClassification(c, sheet('P1'), new Set(['JACK']), new Set(['c-1']))).toMatchObject({ ok: true });
    expect(checkClassification(c, sheet('P1'), new Set(['JACK']))).toMatchObject({ ok: false });
  });
});
