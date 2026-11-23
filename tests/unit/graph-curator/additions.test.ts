import { describe, expect, it } from 'vitest';
import { additionFor, applyChanges, changeOf, curate, kindByName, kindBySiblings, muscleGroups, productGraphSchema, substituteGroups, type CatalogFact } from '@r4-graph/curator';

const sheet = (name: string, over: Partial<CatalogFact> = {}): CatalogFact => ({ name, active: true, sellable: true, category: 'Rodilleras', price: 20000, specs: {}, ...over });

describe('classification (ADR-058 G2b)', () => {
  it('kind by name or category; else the kind most catalog siblings have', () => {
    expect(kindByName('Rodilleras Neopreno 7mm | HWM', null)).toBe('KNEE');
    expect(kindByName('Prensa 45°', 'Máquinas con Carga de Discos')).toBe('PLATE_MACHINE');
    expect(kindByName('Producto raro', null)).toBeNull();
    expect(kindBySiblings(['DB', 'DB', 'DB', 'KB'])).toBe('DB');
    expect(kindBySiblings(['DB', 'KB', 'DB', 'KB'])).toBeNull(); // no 60 % majority
    expect(kindBySiblings(['DB', 'DB', null])).toBeNull(); // fewer than 3 known
  });

  it('substitute groups and muscle groups', () => {
    expect(substituteGroups('Kettlebell 16kg', 'KB')).toEqual(['kettlebell:16kg']);
    expect(substituteGroups('Pack 4 Kettlebells', 'KB')).toEqual([]);
    expect(substituteGroups('Dual Bíceps / Tríceps MO 2.0', 'SELECTORIZED')).toEqual(['musculo:biceps', 'musculo:triceps']);
    expect(muscleGroups('Dual Bíceps / Tríceps MO 2.0', 'SELECTORIZED')).toEqual(['brazos']);
    expect(muscleGroups('Polea Alta/Remo ZR Series', 'PLATE_MACHINE')).toEqual(['espalda']); // a specific group drops «cuerpo completo»
    expect(muscleGroups('Trotadora T8', 'TREADMILL')).toEqual(['cardio']);
    expect(muscleGroups('Collarín Pro', 'COLLAR')).toEqual([]); // accessories inherit
  });
});

// Five knee sleeves already in the graph, four of them «used with» the two racks; a new one should get the same.
const graph = productGraphSchema.parse({
  schemaVersion: 1,
  labels: { 'nu:a': 'Se usa con', 'nu:b': 'Complementos', 'sub:a': 'Lo reemplaza', 'sub:b': 'Lo reemplaza', 'rb:a': 'Barras', 'rb:b': 'Racks' },
  products: {
    P1: { n: 'Rodilleras A', act: true, price: 19000, kind: 'KNEE' }, P2: { n: 'Rodilleras B', act: true, price: 21000, kind: 'KNEE' },
    P3: { n: 'Rodilleras C', act: true, price: 30000, kind: 'KNEE' }, P4: { n: 'Rodilleras D', act: true, price: 50000, kind: 'KNEE' },
    P5: { n: 'Rodilleras E', act: true, price: 60000, kind: 'KNEE' },
    P10: { n: 'Rack 1', act: true, price: 500000, kind: 'SQUAT_RACK' }, P11: { n: 'Rack 2', act: true, price: 600000, kind: 'SQUAT_RACK' }, P12: { n: 'Barra', act: true, price: 1, kind: 'OLY_BAR' },
  },
  view: {
    P1: { 'nu:a': ['P10', 'P11'] }, P2: { 'nu:a': ['P10', 'P11'] }, P3: { 'nu:a': ['P10'] }, P4: { 'nu:a': ['P10'] },
    P10: { 'nu:b': ['P1', 'P2', 'P3', 'P4'], 'rb:a': ['P12'] }, P11: { 'nu:b': ['P1', 'P2'], 'rb:a': ['P12'] }, P12: { 'rb:b': ['P10', 'P11'] },
  },
});
const catalog = new Map<string, CatalogFact | 'not_found' | 'failed'>([
  ...['P1', 'P2', 'P3', 'P4', 'P5'].map((k) => [k, sheet(`Rodilleras ${k}`, { price: graph.products[k]!.price })] as const),
  ['P10', sheet('Rack 1', { category: 'Racks' })], ['P11', sheet('Rack 2', { category: 'Racks' })], ['P12', sheet('Barra', { category: 'Barras' })],
  ['P20', sheet('Rodilleras Nuevas 5mm', { price: 20000 })],
  ['P21', sheet('Servicio de armado', { category: 'Servicios' })],
]);

describe('additions by analogy (ADR-058 G2b)', () => {
  it('a new product gets what at least half of its peers have (never physical fit) plus sellable substitutes', () => {
    const a = additionFor(graph, catalog, 'P20', catalog.get('P20') as CatalogFact)!;
    expect(a).toMatchObject({ kind: 'KNEE', kindBy: 'nombre', peers: 5 });
    // P10 is in 4 of 5 peers, P11 in 2 of 5 (below half): only P10. Rack–bar (rb) is never copied.
    expect(a.relations.filter(([area]) => area !== 'sub')).toEqual([['nu', 'P20', 'P10']]);
    expect(a.reasons[0]).toBe('Rack 1: 4 de 5 productos parecidos ya lo tienen');
  });

  it('a product the graph leaves out on purpose, or with nothing to add, stays a notice', () => {
    const rules = curate(graph, catalog).filter((f) => f.productKey === 'P20' || f.productKey === 'P21').map((f) => f.rule).sort();
    expect(rules).toEqual(['ADD_PRODUCT', 'NOT_IN_GRAPH']);
  });

  it('an approved addition enters the graph with its relations both ways; muscle groups are set', () => {
    const add = curate(graph, catalog).find((f) => f.rule === 'ADD_PRODUCT')!;
    const g = applyChanges(graph, [changeOf(add).change!, { op: 'set_muscles', key: 'P10', muscles: ['cuerpo_completo'] }]);
    expect(g.products.P20).toMatchObject({ n: 'Rodilleras Nuevas 5mm', act: true, kind: 'KNEE' });
    expect(g.view.P20!['nu:a']).toEqual(['P10']);
    expect(g.view.P10!['nu:b']).toContain('P20');
    expect(g.products.P10!.muscles).toEqual(['cuerpo_completo']);
  });

  it('a cross-kind substitute is fine when both train a specific shared group, flagged otherwise', () => {
    const subs = productGraphSchema.parse({
      schemaVersion: 1, labels: { 'sub:a': 'Lo reemplaza', 'sub:b': 'Lo reemplaza' },
      products: { P1: { n: 'Lat Pulldown', act: true, price: 1, kind: 'CABLE_STATION', muscles: ['espalda'] }, P2: { n: 'Remo', act: true, price: 1, kind: 'PLATE_MACHINE', muscles: ['espalda'] }, P3: { n: 'Multiestación', act: true, price: 1, kind: 'SELECTORIZED', muscles: ['cuerpo_completo'] } },
      view: { P1: { 'sub:a': ['P2', 'P3'] }, P2: { 'sub:b': ['P1'] }, P3: { 'sub:b': ['P1'] } },
    });
    const found = curate(subs, new Map()).filter((f) => f.rule === 'SUBSTITUTE_KIND_MISMATCH').map((f) => `${f.productKey}-${f.relatedKey}`);
    expect(found).toEqual(['P1-P3']);
  });
});
