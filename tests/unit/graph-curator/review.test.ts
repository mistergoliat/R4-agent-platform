import { describe, expect, it } from 'vitest';
import { applyChanges, checkReview, productGraphSchema, proposalsFromReviews, revertChange, reviewTargets, type ProductSheetView } from '@r4-graph/curator';

/**
 * ADR-058 G4b: the deterministic check every relation review of the graph-curator agent passes before it becomes a
 * proposal. These cases are its regression set.
 */
const sheet = (productKey: string, name: string, specs: [string, string][] = []): ProductSheetView =>
  ({ productKey, found: true, name, category: 'Barras', active: true, specifications: specs.map(([n, value]) => ({ name: n, value })) });
const sheets = new Map([
  ['P1', sheet('P1', 'Barra Olímpica 20kg | HWM', [['Diámetro manguito', '50 mm']])],
  ['P2', sheet('P2', 'Disco Estándar 10kg', [['Diámetro interno', '28 mm']])],
  ['P3', sheet('P3', 'Disco Bumper 10kg', [['Diámetro interno', '50,4 mm']])],
]);
const relations = [['ld', 'P1', 'P2'], ['ld', 'P1', 'P3']] as const;
const remove = { area: 'ld', a: 'P1', b: 'P2', verdict: 'remove', reason: 'el disco es de 28 mm y la barra olímpica', evidence: [{ product: 'P2', field: 'Diámetro interno', value: '28 mm' }, { product: 'P1', field: 'Nombre', value: 'Barra Olímpica' }] };
const keep = { area: 'ld', a: 'P1', b: 'P3', verdict: 'keep', reason: 'calzan en 50 mm', evidence: [{ product: 'P3', field: 'diámetro interno', value: '50,4  MM' }] };

describe('graph-curator relation review check (regression set)', () => {
  it('accepts cited verdicts (loose matching), and unsure without evidence', () => {
    const check = checkReview({ verdicts: [remove, keep] }, relations, sheets);
    expect(check).toMatchObject({ ok: true, refused: [] });
    expect(check.ok && check.verdicts.map((v) => v.verdict)).toEqual(['remove', 'keep']);
    expect(checkReview({ verdicts: [{ ...keep, verdict: 'unsure', evidence: [] }] }, relations, sheets)).toMatchObject({ ok: true, refused: [] });
  });

  it.each([
    ['a relation the task did not ask about', { ...keep, b: 'P9' }, /not one of the relations/u],
    ['keep without evidence', { ...keep, evidence: [] }, /keep without evidence/u],
    ['evidence from a third product', { ...keep, evidence: [{ product: 'P2', field: 'Nombre', value: 'Disco' }] }, /not in the relation/u],
    ['a field the sheet does not have', { ...keep, evidence: [{ product: 'P3', field: 'Material', value: 'caucho' }] }, /«Material» is not in the sheet of P3/u],
    ['a value the sheet does not say', { ...remove, evidence: [{ product: 'P2', field: 'Diámetro interno', value: '25 mm' }] }, /does not appear in the sheet of P2/u],
  ])('refuses only the verdict with %s', (_name, bad, reason) => {
    const check = checkReview({ verdicts: [bad, ...(bad.b === 'P2' ? [keep] : [remove])] }, relations, sheets);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.verdicts).toHaveLength(1);
    expect(check.refused[0]!.reason).toMatch(reason);
  });

  it('«Categoría» matches the store category or the sheet specification of that name (prod 2026-11-25)', () => {
    const olympic = new Map([...sheets, ['P3', sheet('P3', 'Disco Bumper 10kg', [['Categoría', 'Olímpico']])]]);
    const cite = (value: string) => checkReview({ verdicts: [{ ...keep, evidence: [{ product: 'P3', field: 'Categoría', value }] }] }, relations, olympic);
    expect(cite('Olímpico')).toMatchObject({ ok: true, refused: [] });
    expect(cite('Barras')).toMatchObject({ ok: true, refused: [] });
    expect(cite('Estándar')).toMatchObject({ ok: true, refused: [{ reason: expect.stringMatching(/does not appear in the sheet of P3/u) }] });
  });

  it('refuses a second verdict for the same relation', () => {
    const check = checkReview({ verdicts: [keep, keep] }, relations, sheets);
    expect(check.ok && check.refused.map((r) => r.reason)).toEqual(['a second verdict for the same relation']);
  });

  it.each([
    ['extra fields', { verdicts: [{ ...keep, price: 1 }] }],
    ['an unknown verdict', { verdicts: [{ ...keep, verdict: 'maybe' }] }],
    ['a missing result', undefined],
  ])('refuses the whole result with %s', (_name, data) => {
    expect(checkReview(data, relations, sheets)).toMatchObject({ ok: false });
  });
});

describe('what the review takes, and what approving it does', () => {
  const graph = productGraphSchema.parse({
    schemaVersion: 1, labels: { 'ld:a': 'Discos para cargarla', 'ld:b': 'Máquinas que carga', 'st:a': 'Guarda', 'st:b': 'Se guarda en' },
    products: { P1: { n: 'a', act: true, price: 1 }, P2: { n: 'b', act: true, price: 1 }, P3: { n: 'c', act: true, price: 1 }, P4: { n: 'd', act: true, price: 1 } },
    view: { P1: { 'ld:a': ['P2', 'P3'] }, P2: { 'ld:b': ['P1'], 'st:b': ['P4'] }, P3: { 'ld:b': ['P1'] }, P4: { 'st:a': ['P2'] } },
    unreviewed: [['ld', 'P1', 'P2'], ['ld', 'P1', 'P3'], ['st', 'P4', 'P2']],
  });

  it('groups by the end most asked to Pesín, skips what a review already judged, chunks by size', () => {
    expect(reviewTargets(graph, new Map([['P2', 5]]), new Set(), 10)).toEqual([
      { anchor: 'P2', relations: [['ld', 'P1', 'P2'], ['st', 'P4', 'P2']] },
      { anchor: 'P1', relations: [['ld', 'P1', 'P3']] },
    ]);
    expect(reviewTargets(graph, new Map(), new Set(['ld|P1|P2']), 1)).toEqual([
      { anchor: 'P1', relations: [['ld', 'P1', 'P3']] },
      { anchor: 'P4', relations: [['st', 'P4', 'P2']] },
    ]);
  });

  it('a recheck turns stored results into the same proposals a run would (same fingerprints), without the model', async () => {
    const stored = { status: 'completed', result: { data: { verdicts: [keep, remove] } } };
    const { proposals, refused, counts, completed } = await proposalsFromReviews(graph, [
      { hash: 'h1', taskId: 't1', anchor: 'P1', relations: [['ld', 'P1', 'P2'], ['ld', 'P1', 'P3']], ...stored },
      { hash: 'h2', taskId: 't2', anchor: 'P4', relations: [['st', 'P4', 'P2']], status: 'blocked', result: null },
    ], (k) => Promise.resolve(sheets.get(k)!));
    expect({ refused, counts, completed }).toEqual({ refused: [{ relation: 'P4 (1)', reason: 'task blocked' }], counts: { keep: 1, remove: 1, unsure: 0 }, completed: 1 });
    expect(proposals.map((p) => p.fingerprint)).toEqual(['inconsistency|AGENT_REMOVE_RELATION|P1|P2|ld', 'inconsistency|AGENT_CONFIRM_RELATIONS|P1|h1']);
    expect(proposals[1]!.change).toEqual({ op: 'mark_reviewed', relations: [['ld', 'P1', 'P3']] });
  });

  it('mark_reviewed clears the marks and keeps the relations; undo brings the marks back', () => {
    const next = applyChanges(graph, [{ op: 'mark_reviewed', relations: [['ld', 'P1', 'P2']] }]);
    expect(next.unreviewed).toEqual([['ld', 'P1', 'P3'], ['st', 'P4', 'P2']]);
    expect(next.view.P1).toEqual(graph.view.P1);
    expect(revertChange(next, graph, { op: 'mark_reviewed', relations: [['ld', 'P1', 'P2']] }).unreviewed).toContainEqual(['ld', 'P1', 'P2']);
  });
});
