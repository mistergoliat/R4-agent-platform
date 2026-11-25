import { describe, expect, it } from 'vitest';
import { checkClassification, classificationTargets, productGraphSchema, tasksWithinBudget, type ProductSheetView } from '@r4-graph/curator';

/**
 * ADR-058 G4a: the deterministic check every graph-curator agent result passes before it becomes a proposal. These
 * cases are its regression set: a result the model could return, and whether the curator may propose it.
 */
const sheet: ProductSheetView = { productKey: 'P1', found: true, name: 'Banco Scott Pro | HWM', category: 'Bancos', active: true, specifications: [{ name: 'Uso', value: 'Curl de bíceps con barra' }] };
const vocabulary = new Set(['SCOTT', 'DB', 'BENCH']);
const result = (over: Record<string, unknown> = {}) => ({ kind: 'SCOTT', muscles: ['brazos'], evidence: [{ field: 'Nombre', value: 'Banco Scott' }], confidence: 'high', ...over });

describe('graph-curator agent result check (regression set)', () => {
  it.each([
    ['a cited classification from the closed list', result(), true],
    ['evidence matched loosely (case, spacing) inside the value', result({ evidence: [{ field: 'uso', value: 'curl  de BÍCEPS' }] }), true],
    ['the category as evidence', result({ evidence: [{ field: 'Categoría', value: 'Bancos' }] }), true],
    ['nothing classified needs no evidence', result({ kind: null, muscles: [], evidence: [] }), true],
  ])('accepts %s', (_name, data, ok) => {
    expect(checkClassification(data, sheet, vocabulary).ok).toBe(ok);
  });

  it.each([
    ['a kind outside the closed list', result({ kind: 'INVENTED' }), /not in the closed list/u],
    ['a classification without evidence', result({ evidence: [] }), /without evidence/u],
    ['evidence from a field the sheet does not have', result({ evidence: [{ field: 'Material', value: 'acero' }] }), /«Material» is not in the sheet/u],
    ['evidence whose value the sheet does not say', result({ evidence: [{ field: 'Uso', value: 'press de banca' }] }), /does not appear in the sheet/u],
    ['a muscle group outside the closed list', result({ muscles: ['antebrazos'] }), /shape/u],
    ['extra fields (strict shape)', result({ price: 1 }), /shape/u],
    ['a missing result', undefined, /shape/u],
  ])('refuses %s', (_name, data, reason) => {
    const check = checkClassification(data, sheet, vocabulary);
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.violations.join('; ')).toMatch(reason);
  });

  it('a product without a sheet is refused whatever the result says', () => {
    expect(checkClassification(result(), { ...sheet, found: false, name: null, category: null, specifications: [] }, vocabulary).ok).toBe(false);
  });
});

describe('what the agent classifies, and how much the cap allows', () => {
  const graph = productGraphSchema.parse({
    schemaVersion: 1, labels: { 'nu:a': 'x', 'nu:b': 'y' },
    products: { P1: { n: 'a', act: true, price: 1, kind: null }, P2: { n: 'b', act: true, price: 1, kind: null }, P3: { n: 'c', act: false, price: 1, kind: null }, P4: { n: 'd', act: true, price: 1, kind: 'DB' }, P5: { n: 'e', act: true, price: 1, kind: null } },
    view: { P5: { 'nu:a': ['P4'] }, P4: { 'nu:b': ['P5'] } },
  });

  it('only active products without a kind; most asked to Pesín first, then the most related', () => {
    expect(classificationTargets(graph, new Map([['P2', 4]]), () => false, 10)).toEqual(['P2', 'P5', 'P1']);
    expect(classificationTargets(graph, new Map(), () => false, 1)).toEqual(['P5']);
  });

  it('the US$ cap converts to whole tasks, each with its full token budget', () => {
    expect(tasksWithinBudget(1, 2, 30_000)).toBe(16); // US$1 at US$2 per million tokens → 500k tokens → 16 tasks
    expect(tasksWithinBudget(1, 100, 30_000)).toBe(0);
    expect(tasksWithinBudget(0, 2, 30_000)).toBe(0);
  });
});
