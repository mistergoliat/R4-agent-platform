import { describe, expect, it } from 'vitest';
import { COMPATIBILITY_CAPABILITY_ID, SalesCatalogEvidenceEvaluator, SalesFixture, SalesSetCompatibilityEvaluator, salesEvaluationDefinition } from '@r4-sales/agent/evaluations';

/**
 * Home Gym set scenarios (owner mandate 2026-11-16, phase 5) against the Catalog owner's compatibility verdicts, in
 * the shape of the PROPOSED contract `compat-v1` (catalog.assess_compatibility, not published yet). R4 computes no
 * compatibility: every verdict below is what the owner would answer. Synthetic data, P-keys as Catalog V2 issues them.
 */
const evaluator = new SalesSetCompatibilityEvaluator();
let seq = 0;
const fixture = () => new SalesFixture({ id: `set-compatibility-${(seq += 1)}` });
type V = 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNKNOWN';
const assessment = (pairs: { subject: string; object: string; relation: string; verdict: V; reasonCode: string; approval?: 'APPROVED' | 'PROPOSED' | null }[]) => ({
  schemaVersion: 1, contractVersion: 'compat-v1', requestId: 'req', assessedAt: '2026-11-16T18:00:00Z',
  lineage: { rulesVersion: 'fixture', ruleContentHash: 'a'.repeat(64), projectionBundleId: 'bundle-fixture', sourceExtractionId: 'extraction-fixture' },
  assessments: pairs.map((p) => ({ subject: p.subject, object: p.object, relation: p.relation, verdict: p.verdict, reasonCode: p.reasonCode, rule: p.approval === null ? null : { id: `rule-${p.relation.toLowerCase()}`, version: 1, approval: p.approval ?? 'APPROVED' }, evidence: [] })),
  notApplicable: [],
});
const run = (turn: string, pairs: Parameters<typeof assessment>[0], reply: string) => {
  const f = fixture().turn(turn);
  f.read(COMPATIBILITY_CAPABILITY_ID, { items: [], pairs: 'all' }, assessment(pairs), { validForMs: null });
  f.respond(reply).wait();
  return evaluator.evaluate(f.build());
};
const sets = (r: ReturnType<typeof run>) => (r.data!.sets as { class: string }[]).map((s) => s.class);

describe('sales.set_compatibility — Home Gym sets against the owner\'s verdicts', () => {
  it('is registered, and its code is in the Sales taxonomy', () => {
    const definition = salesEvaluationDefinition();
    expect(definition.evaluators.some((e) => e.descriptor.ref.id === 'sales.set_compatibility')).toBe(true);
    expect(definition.taxonomy.get('set_with_demonstrated_incompatibility')?.origin).toBe('sales');
  });

  it('1. a complete strength set whose pairs are all COMPATIBLE by approved rules is VALID', () => {
    const r = run('Fuerza', [
      { subject: 'P32', object: 'P1538', relation: 'BAR_ON_RACK', verdict: 'COMPATIBLE', reasonCode: 'GRIP_SPANS_SUPPORTS' },
      { subject: 'P573', object: 'P32', relation: 'PLATE_ON_BAR', verdict: 'COMPATIBLE', reasonCode: 'BORE_FITS_SLEEVE' },
      { subject: 'P1447', object: 'P1538', relation: 'BENCH_IN_RACK', verdict: 'COMPATIBLE', reasonCode: 'FITS_INSIDE' },
    ], 'Te propongo este set.\n[[P1538]]\n[[P32]]\n[[P573 x2]]\n[[P1447]]');
    expect(r.findings).toEqual([]);
    expect(sets(r)).toEqual(['VALID']);
  });

  it('2. a bar the owner assessed INCOMPATIBLE with the rack makes the set INVALID (the 150 cm bar case)', () => {
    const r = run('Fuerza', [
      { subject: 'P43', object: 'P1536', relation: 'BAR_ON_RACK', verdict: 'INCOMPATIBLE', reasonCode: 'GRIP_SHORTER_THAN_SUPPORT_SPACING' },
      { subject: 'P363', object: 'P43', relation: 'PLATE_ON_BAR', verdict: 'COMPATIBLE', reasonCode: 'BORE_FITS_SLEEVE' },
    ], 'Set económico.\n[[P1536]]\n[[P43]]\n[[P363]]');
    expect(r.findings.map((f) => f.code)).toEqual(['set_with_demonstrated_incompatibility']);
    expect(sets(r)).toEqual(['INVALID']);
  });

  it('3. plates the owner assessed INCOMPATIBLE with the bar make the set INVALID', () => {
    const r = run('barra y discos', [{ subject: 'P1494', object: 'P43', relation: 'PLATE_ON_BAR', verdict: 'INCOMPATIBLE', reasonCode: 'BORE_LARGER_THAN_SLEEVE' }], 'Barra y discos.\n[[P43]]\n[[P1494]]');
    expect(r.findings.map((f) => f.code)).toEqual(['set_with_demonstrated_incompatibility']);
  });

  it('3b. a proposal incompatible with what the visitor ALREADY has (cart in the browser note) is INVALID too', () => {
    const r = run('muéstrame otros discos y una barra porfa [Contexto informado por el navegador, no verificado: su carrito tiene P647 x1, P1494 x1.]',
      [{ subject: 'P1494', object: 'P43', relation: 'PLATE_ON_BAR', verdict: 'INCOMPATIBLE', reasonCode: 'BORE_LARGER_THAN_SLEEVE' }],
      'Te propongo esta barra y estos discos.\n[[P43]]\n[[P145]]');
    expect(r.findings.map((f) => f.details)).toEqual([expect.objectContaining({ subject: 'P43', object: 'P1494', ownedByVisitor: true })]);
    expect(sets(r)).toEqual(['INVALID']);
  });

  it('4. missing specifications give UNKNOWN: the set REQUIRES_TECHNICAL_CONFIRMATION, never VALID', () => {
    const r = run('Fuerza', [{ subject: 'P43', object: 'P1536', relation: 'BAR_ON_RACK', verdict: 'UNKNOWN', reasonCode: 'MISSING_ATTRIBUTE', approval: null }], 'Set.\n[[P1536]]\n[[P43]]');
    expect(r.findings).toEqual([]);
    expect(sets(r)).toEqual(['REQUIRES_TECHNICAL_CONFIRMATION']);
  });

  it('5. an out-of-stock product in a set is a card without sellable evidence (sales.catalog_evidence_use)', () => {
    const f = fixture().turn('set');
    f.read('catalog.search', { query: 'rack' }, { results: [{ productKey: 'P1536', availability: { sellability: 'sellable' }, price: { finalGross: { amount: 87_992 } } }, { productKey: 'P235', availability: { sellability: 'not_sellable' }, price: { finalGross: { amount: 56_995 } } }] }, { validForMs: 15_000 });
    f.respond('Set.\n[[P1536]]\n[[P235]]').wait();
    expect(new SalesCatalogEvidenceEvaluator().evaluate(f.build()).findings.map((x) => x.code)).toEqual(['card_without_sellable_evidence']);
  });

  it('6. completeness (a rack without a bar) is NOT evaluated: the owner publishes no REQUIRES relation yet', () => {
    const r = run('Fuerza', [{ subject: 'P1447', object: 'P1536', relation: 'BENCH_IN_RACK', verdict: 'COMPATIBLE', reasonCode: 'FITS_INSIDE' }], 'Rack y banco.\n[[P1536]]\n[[P1447]]');
    expect(r.findings).toEqual([]);
    expect(sets(r)).toEqual(['VALID']); // valid as far as the assessed pairs go; incompleteness is a known gap, not a pass
  });

  it('8. accessories with an interface out of the owner\'s vocabulary are UNKNOWN', () => {
    const r = run('accesorios para el rack', [{ subject: 'P2001', object: 'P1538', relation: 'ACCESSORY_ON_RACK', verdict: 'UNKNOWN', reasonCode: 'OUT_OF_VOCABULARY', approval: null }], 'Accesorios.\n[[P1538]]\n[[P2001]]');
    expect(sets(r)).toEqual(['REQUIRES_TECHNICAL_CONFIRMATION']);
  });

  it('10. a COMPATIBLE verdict from a rule still pending adjudication counts as UNKNOWN, never as verified', () => {
    const r = run('barra y discos', [{ subject: 'P830', object: 'P666', relation: 'PLATE_ON_BAR', verdict: 'COMPATIBLE', reasonCode: 'BORE_FITS_SLEEVE', approval: 'PROPOSED' }], 'Barra y bumpers.\n[[P666]]\n[[P830 x2]]');
    expect(sets(r)).toEqual(['REQUIRES_TECHNICAL_CONFIRMATION']);
    expect((r.data!.sets as { pairs: { reasonCode: string }[] }[])[0]!.pairs[0]!.reasonCode).toBe('RULE_NOT_APPROVED');
  });

  it('a set with no assessment is NOT_ASSESSED (today, without the owner\'s endpoint, every set)', () => {
    const f = fixture().turn('Fuerza');
    f.respond('Set.\n[[P1536]]\n[[P43]]').wait();
    const r = evaluator.evaluate(f.build());
    expect(sets(r)).toEqual(['NOT_ASSESSED']);
    expect(r.findings).toEqual([]);
  });
});
