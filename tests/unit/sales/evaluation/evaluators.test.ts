import { describe, expect, it } from 'vitest';
import { classifyClaim, questionsOf, type ExtractedClaim } from '@r4/evaluation';
import { SalesClaimVerifier, SalesFixture, evaluateSalesSubject, salesQuestionClassifier, type EvaluatedSubject } from '@r4-sales/agent/evaluations';

const verifier = new SalesClaimVerifier();
const claim = (over: Partial<ExtractedClaim> & Pick<ExtractedClaim, 'type'>): ExtractedClaim => ({ responseId: 'r', text: 't', entities: [], attributes: {}, ...over });
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;
const evaluate = (f: SalesFixture): Promise<EvaluatedSubject> => evaluateSalesSubject(f.build(), { judge: null, modelUnderTest: null, repro: { gitSha: 'unknown' } });

/** Observations available to one response in a fixture. */
function evidence(build: (f: SalesFixture) => void) {
  const f = new SalesFixture({ id: nextId('grounding') });
  f.turn('hola');
  build(f);
  f.respond('respuesta');
  f.wait();
  const s = f.build();
  return s.observations.filter((o) => s.responses[0]!.evidenceInContext.includes(o.observationId));
}

describe('Sales grounding verification (catalog fixture, evidence available to the response)', () => {
  const searched = evidence((f) => f.searchCatalog({ category: 'racks' }, ['RACK-PR200', 'RACK-PR300', 'BAR-OLY20']));

  it('grounded product and grounded price', () => {
    const v = verifier.verify(claim({ type: 'price', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: null }], attributes: { amount: 289_990 } }), searched);
    expect(v.entities).toEqual([{ name: 'Power Rack PR-200', grounded: true, ref: 'RACK-PR200' }]);
    expect(classifyClaim({ type: 'price' }, v)).toBe('GROUNDED_FACT');
  });

  it('a wrong price for a grounded product is an unsupported claim', () => {
    const v = verifier.verify(claim({ type: 'price', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }], attributes: { amount: 279_990 } }), searched);
    expect(classifyClaim({ type: 'price' }, v)).toBe('UNSUPPORTED_CLAIM');
  });

  it('grounded stock, and a stock claim contradicting the observation', () => {
    expect(classifyClaim({ type: 'stock' }, verifier.verify(claim({ type: 'stock', entities: [{ name: 'Power Rack PR-300 Pro', kind: 'product', ref: 'RACK-PR300' }], attributes: { status: 'out_of_stock' } }), searched))).toBe('GROUNDED_FACT');
    expect(classifyClaim({ type: 'stock' }, verifier.verify(claim({ type: 'stock', entities: [{ name: 'Power Rack PR-300 Pro', kind: 'product', ref: 'RACK-PR300' }], attributes: { status: 'in_stock' } }), searched))).toBe('UNSUPPORTED_CLAIM');
  });

  it('compatibility between two grounded products needs a product context that states it', () => {
    const compat = claim({ type: 'compatibility', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }, { name: 'Barra olímpica 20 kg', kind: 'product', ref: 'BAR-OLY20' }] });
    expect(classifyClaim(compat, verifier.verify(compat, searched))).toBe('UNSUPPORTED_RELATIONSHIP');
    const withContext = evidence((f) => {
      f.searchCatalog({ category: 'racks' }, ['RACK-PR200', 'BAR-OLY20']);
      f.productContext('RACK-PR200');
    });
    expect(classifyClaim(compat, verifier.verify(compat, withContext))).toBe('GROUNDED_FACT');
  });

  it('a category the observed catalog does not have is a nonexistent entity, even if a model "knows" it', () => {
    const v = verifier.verify(claim({ type: 'availability', entities: [{ name: 'cinta', kind: 'category', ref: null }, { name: 'elíptica', kind: 'category', ref: null }] }), searched);
    expect(classifyClaim({ type: 'availability' }, v)).toBe('NONEXISTENT_ENTITY');
    expect(classifyClaim({ type: 'availability' }, verifier.verify(claim({ type: 'availability', entities: [{ name: 'discos', kind: 'category', ref: null }] }), searched))).toBe('GROUNDED_FACT');
  });

  it('a product that exists in the catalog but was not observed is not grounded for that response', () => {
    const v = verifier.verify(claim({ type: 'price', entities: [{ name: 'Kettlebell 16 kg', kind: 'product', ref: 'KB-16' }], attributes: { amount: 34_990 } }), searched);
    expect(v.entities[0]!.grounded).toBe(false);
  });

  it('a derived recommendation over grounded products is not a hallucination', () => {
    const v = verifier.verify(claim({ type: 'recommendation', text: 'te conviene el PR-200, es más versátil', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: null }] }), searched);
    expect(classifyClaim({ type: 'recommendation' }, v)).toBe('DERIVED_RECOMMENDATION');
  });

  it('a specification must match the observed detail', () => {
    const detail = evidence((f) => f.productContext('BAR-OLY20'));
    expect(classifyClaim({ type: 'specification' }, verifier.verify(claim({ type: 'specification', entities: [{ name: 'barra olímpica de 20 kg', kind: 'product', ref: null }], attributes: { weightKg: 20 } }), detail))).toBe('GROUNDED_FACT');
    expect(classifyClaim({ type: 'specification' }, verifier.verify(claim({ type: 'specification', entities: [{ name: 'barra olímpica de 20 kg', kind: 'product', ref: null }], attributes: { weightKg: 25 } }), detail))).toBe('UNSUPPORTED_CLAIM');
  });
});

describe('Sales quote evaluation (reads receipts, never re-implements governance)', () => {
  function quoted(respond: (quote: { quoteNumber: string; total: number }) => string, options: { evidence?: string[] } = {}) {
    const f = new SalesFixture({ id: nextId('quote'), customerRef: 'cust-demo-001' });
    f.turn('Cotízame el rack a Ñuñoa');
    f.searchCatalog({ text: 'rack' }, ['RACK-PR200']);
    f.update([{ op: 'add_item', productId: 'RACK-PR200', quantity: 1 }, { op: 'set_delivery_destination', commune: 'Ñuñoa' }]);
    const q = f.quote({ name: 'Camila Rojas', email: 'camila.rojas@example.test' }, { shippingAmount: 30_000, ...(options.evidence ? { evidenceRefs: options.evidence } : {}) });
    f.respond(respond(q));
    f.wait();
    return f;
  }

  it('a quote backed by its receipt gives the business outcome quote_created and no finding', async () => {
    const { run } = await evaluate(quoted((q) => `Emití la cotización ${q.quoteNumber}. Total: $319.990.`));
    expect(run.result.findings).toEqual([]);
    expect(run.result.outcome.business).toMatchObject({ status: 'reported', outcomes: [{ owner: 'sales', code: 'quote_created' }] });
    const receiptId = run.result.outcome.business.outcomes[0]!.evidenceRefs[0]!.id;
    expect(run.result.metrics['sales.quote.callsPerQuote']).toMatchObject({ denominator: 1 });
    expect(receiptId).toMatch(/-/);
  });

  it('a total that is not the receipt total is flagged', async () => {
    const { run } = await evaluate(quoted((q) => `Emití la cotización ${q.quoteNumber}. Total: $299.990.`));
    expect(run.result.findings.map((f) => f.code)).toEqual(['quote_figure_not_from_receipt']);
  });

  it('a quote command whose proposal cites no catalog evidence is flagged', async () => {
    const { run } = await evaluate(quoted((q) => `Cotización ${q.quoteNumber} lista.`, { evidence: [] }));
    expect(run.result.findings.map((f) => f.code)).toContain('quote_without_catalog_evidence');
  });

  it('a quote number without any quote receipt is a critical governance finding', async () => {
    const f = new SalesFixture({ id: 'quote-unbacked' });
    f.turn('Cotízame el rack');
    f.respond('Listo, tu cotización COT-100001 fue emitida.');
    f.wait();
    const { run } = await evaluate(f);
    expect(run.result.findings.map((x) => [x.category, x.code, x.severity])).toEqual([['GOVERNANCE', 'quote_claim_without_receipt', 'critical']]);
    expect(run.result.outcome.business.status).toBe('none_reported');
  });
});

describe('Sales correction, questions and goals', () => {
  it('budget 800k → 1.1M: the correction is current, the old value history, and later responses use the new one', async () => {
    const f = new SalesFixture({ id: 'correction' });
    f.turn('Tengo 800 lucas');
    f.update([{ op: 'record_fact', key: 'budget_clp', value: 800_000, statedBy: 'customer' }]);
    f.respond('Anotado.');
    f.wait();
    f.turn('Mejor 1,1 millones');
    f.update([{ op: 'record_fact', key: 'budget_clp', value: 1_100_000, statedBy: 'customer' }]);
    f.respond('Perfecto, tu presupuesto ahora es $1.100.000.');
    f.wait();
    const { run } = await evaluate(f);
    expect(run.result.findings).toEqual([]);
    expect(run.result.metrics['sales.workspace_continuity.corrections']?.value).toBe(1);
    expect(run.result.metrics['sales.workspace_continuity.correctionsSuperseded']?.value).toBe(1);
    expect(run.result.metrics['sales.budget_correction.correctionsWithHistory']?.value).toBe(1);
  });

  it('a structured value that disappears without a removal is a state finding', async () => {
    const f = new SalesFixture({ id: 'state-lost' });
    f.turn('Tengo 800 lucas');
    f.update([{ op: 'record_fact', key: 'budget_clp', value: 800_000, statedBy: 'customer' }]);
    f.respond('Anotado.');
    f.wait();
    f.mutate((r) => ({ ...r, domain: { 'sales.workspace': { ...r.domain!['sales.workspace']!, data: { ...(r.domain!['sales.workspace']!.data as object), state: { facts: {}, delivery: null, items: [] } } } } }));
    const { run } = await evaluate(f);
    expect(run.result.findings.map((x) => x.code)).toEqual(['state_value_lost']);
  });

  it('classifies only unambiguous questions; everything else is left to the rubric', () => {
    expect(salesQuestionClassifier.classify('¿Cuál es tu presupuesto?')).toEqual(['budget']);
    expect(salesQuestionClassifier.classify('¿A qué comuna despachamos?')).toEqual(['delivery']);
    expect(salesQuestionClassifier.classify('¿Cuánto espacio tienes?')).toEqual(['space']);
    expect(salesQuestionClassifier.classify('¿Prefieres bumper o fierro?')).toEqual([]);
    expect(questionsOf('Con $800.000 armamos algo. ¿Cuánto espacio tienes? 2) ¿Y a qué comuna?')).toEqual(['¿Cuánto espacio tienes?', '¿Y a qué comuna?']);
  });

  it('a question for a value not yet known is not flagged; the same question after recording it is', async () => {
    const f = new SalesFixture({ id: 'questions' });
    f.turn('Quiero un gym');
    f.respond('¿Cuál es tu presupuesto?');
    f.wait();
    f.turn('800 lucas');
    f.update([{ op: 'record_fact', key: 'presupuesto', value: 800_000, statedBy: 'customer' }]);
    f.respond('Gracias. ¿Cuál es tu presupuesto máximo?');
    f.wait();
    const subject = f.build();
    const { run } = await evaluateSalesSubject(subject, { judge: null, modelUnderTest: null, repro: { gitSha: 'unknown' } });
    const known = run.result.findings.filter((x) => x.code === 'already_known_question');
    expect(known).toHaveLength(1);
    expect(known[0]!.subjectRef.id).toBe(subject.responses[1]!.responseId);
    expect(run.result.metrics['sales.known_questions.questions']?.value).toBe(2);
  });

  it('goal quality does not depend on manage_goal: no sub-goals and a preserved root is not a finding', async () => {
    const f = new SalesFixture({ id: 'goals-none' });
    f.turn('Quiero un gym');
    f.respond('¿Cuánto espacio tienes?');
    f.wait();
    const { run } = await evaluate(f);
    expect(run.result.findings).toEqual([]);
    expect(run.result.metrics['r4.goal_continuity.manageGoalDecisions']?.value).toBe(0);
    expect(run.result.outcome.goal).toMatchObject({ status: 'in_progress', rootPreserved: true });
  });

  it('calling manage_goal is not rewarded either: the metric is telemetry', async () => {
    const f = new SalesFixture({ id: 'goals-some' });
    f.turn('Quiero un gym');
    f.createGoal('Gimnasio en casa');
    f.respond('¿Cuánto espacio tienes?');
    f.wait();
    const { run } = await evaluate(f);
    expect(run.result.findings).toEqual([]);
    expect(run.result.metrics['r4.goal_continuity.manageGoalDecisions']).toMatchObject({ value: 1, note: expect.stringMatching(/telemetry/) });
  });
});
