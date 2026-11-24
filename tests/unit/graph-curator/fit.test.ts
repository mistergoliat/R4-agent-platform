import { describe, expect, it } from 'vitest';
import { applyChanges, barCollar, barPlate, changeOf, curate, physicalFit, productGraphSchema, rackBar, revertChange, type CatalogFact } from '@r4-graph/curator';

const sheet = (name: string, specs: Record<string, string> = {}): CatalogFact => ({ name, active: true, sellable: true, category: null, price: 1, specs });

describe('physical fit rules (ADR-058 G2b-2)', () => {
  it('bar ↔ plate: declared clearance 0–3 mm, light bars only with rubber, a pair within the bar capacity', () => {
    const bar = sheet('Barra Olímpica 20kg', { 'Diámetro de manga': '50 mm', 'Peso máximo de carga': '150 kg' });
    expect(barPlate(bar, sheet('Par Bumper 20kg', { 'Diámetro interno': '50.4 mm' }))).toMatchObject({ verdict: 'fit', reason: 'DECLARED_FIT' });
    expect(barPlate(bar, sheet('Disco 20kg', { 'Diámetro interno': '28 mm' }))).toMatchObject({ verdict: 'unfit', reason: 'BORE_SMALLER_THAN_SLEEVE' });
    expect(barPlate(bar, sheet('Disco 20kg', { 'Diámetro interno': '55 mm' }))).toMatchObject({ verdict: 'unfit', reason: 'CLEARANCE_TOO_LARGE' });
    expect(barPlate(bar, sheet('Par Discos 100kg', { 'Diámetro interno': '50 mm' }))).toMatchObject({ verdict: 'unfit', reason: 'OVER_BAR_CAPACITY' });
    expect(barPlate(sheet('Barra Technique 10kg', { 'Diámetro de manga': '50 mm' }), sheet('Disco Acero 10kg', { 'Diámetro interno': '50 mm' }))).toMatchObject({ verdict: 'unfit', reason: 'LIGHT_BAR_NEEDS_RUBBER' });
    expect(barPlate(sheet('Barra'), sheet('Disco'))).toEqual({ verdict: 'needs', missing: [{ side: 'a', field: 'Diámetro de manga' }, { side: 'b', field: 'Diámetro interno' }] });
    expect(barPlate(bar, sheet('Pack 100kg Discos'))).toEqual({ verdict: 'skip' });
  });

  it('bar ↔ collar and rack ↔ bar', () => {
    const bar = sheet('Barra Olímpica', { 'Diámetro de manga': '48 mm', 'Largo de agarre': '131 cm' });
    expect(barCollar(bar, sheet('Collarín', { 'Diámetro interno': '48.5 mm' }))).toMatchObject({ verdict: 'fit', reason: 'DECLARED_FIT' });
    expect(barCollar(bar, sheet('Collarín', { 'Diámetro interno': '50 mm' }))).toMatchObject({ verdict: 'fit', reason: 'CLAMP_COVERS' });
    expect(barCollar(bar, sheet('Collarín', { 'Diámetro interno': '30 mm' }))).toMatchObject({ verdict: 'unfit' });
    const rack = sheet('Power Rack', { 'Dimensiones del producto armado': 'Largo: 140 cm Ancho: 123 cm Alto: 220 cm' });
    expect(rackBar(rack, bar)).toMatchObject({ verdict: 'fit', reason: 'STANDARD_BAR' });
    expect(rackBar(sheet('Rack', { 'Dimensiones del producto': 'Largo: 120 Ancho: 110' }), bar)).toMatchObject({ verdict: 'fit', reason: 'DECLARED_DIMENSIONS_FIT' });
    expect(rackBar(rack, sheet('Barra Corta', { 'Largo de agarre': '90 cm' }))).toMatchObject({ verdict: 'unfit', reason: 'SHORT_BAR_WIDE_FRAME' });
    expect(rackBar(rack, sheet('Barra Junior', { 'Largo de agarre': '131 cm' }))).toMatchObject({ verdict: 'unfit', reason: 'KIDS_BAR' });
    expect(rackBar(rack, sheet('Barra', { 'Largo de agarre': 'No apta para racks' }))).toMatchObject({ verdict: 'unfit', reason: 'BAR_DECLARES_NOT_FOR_RACKS' });
    expect(rackBar(rack, sheet('Barra'))).toEqual({ verdict: 'needs', missing: [{ side: 'b', field: 'Largo de agarre' }] });
  });
});

// Bar P1 fits plate P2 (missing in the graph) and not plate P3 (published); bar P4 lacks its sleeve (blocks P2 and P3).
const graph = productGraphSchema.parse({
  schemaVersion: 1,
  labels: { 'bpc:a': 'Discos sugeridos', 'bpc:b': 'Barras sugeridas' },
  products: {
    P1: { n: 'Barra Olímpica', act: true, price: 1, kind: 'OLY_BAR' }, P4: { n: 'Barra Power', act: true, price: 1, kind: 'OLY_BAR' },
    P2: { n: 'Disco 10kg', act: true, price: 1, kind: 'PLATE_OLY' }, P3: { n: 'Disco 28mm', act: true, price: 1, kind: 'PLATE_OLY' },
  },
  view: { P1: { 'bpc:a': ['P3'] }, P3: { 'bpc:b': ['P1'] } },
});
const catalog = new Map<string, CatalogFact | 'not_found' | 'failed'>([
  ['P1', sheet('Barra Olímpica', { 'Diámetro de manga': '50 mm', 'Largo de agarre': '131 cm' })],
  ['P4', sheet('Barra Power', { 'Largo de agarre': '131 cm' })],
  ['P2', sheet('Disco 10kg', { 'Diámetro interno': '50 mm' })],
  ['P3', sheet('Disco 28mm', { 'Diámetro interno': '28 mm' })],
]);

describe('fit findings (ADR-058 G2b-2)', () => {
  it('a declared fit the graph lacks, a published relation the data contradicts, and what a missing field unblocks', () => {
    const report = physicalFit(graph, catalog);
    expect(report.findings.map((f) => `${f.rule} ${f.productKey}${f.relatedKey ? `-${f.relatedKey}` : ''}`).sort()).toEqual(['FIT_CONTRADICTED P1-P3', 'FIT_MISSING_PLATES P1']);
    expect(report.unblocks.get('P4')?.get('Diámetro de manga')).toBe(2);
    const missing = curate(graph, catalog).find((f) => f.rule === 'SPEC_MISSING' && f.productKey === 'P4')!;
    expect([missing.summary, missing.evidence.unblocks]).toEqual(['Barra Power: falta Diámetro de manga en la ficha (desbloquea 2 relaciones)', 2]);
  });

  it('an approved fit proposal adds its relations both ways; undo takes away only what the base lacked', () => {
    const add = physicalFit(graph, catalog).findings.find((f) => f.rule === 'FIT_MISSING_PLATES')!;
    const change = changeOf(add).change!;
    expect(change).toEqual({ op: 'add_relations', relations: [['bpc', 'P1', 'P2']] });
    const after = applyChanges(graph, [change]);
    expect([after.view.P1!['bpc:a'], after.view.P2!['bpc:b']]).toEqual([['P3', 'P2'], ['P1']]);
    const undone = revertChange(after, graph, change);
    expect(undone.view).toEqual(graph.view);
    const remove = physicalFit(graph, catalog).findings.find((f) => f.rule === 'FIT_CONTRADICTED')!;
    expect(changeOf(remove).change).toEqual({ op: 'remove_relation', area: 'bpc', a: 'P1', b: 'P3' });
  });
});
