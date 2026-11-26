import { describe, expect, it } from 'vitest';
import { DESK_COMPLEXITIES, DESK_INTENTS, DESK_NO_INTENT_REASONS, deskOpportunityInput, deskOpportunityInputV2 } from '@r4-sales/agent';
import { OPPORTUNITY_LABELED_SET, opportunityCasesOf, scoreOpportunityRecords, type OpportunityCase, type OpportunityLabel, type OpportunityPrediction } from '@r4-sales/agent/evaluations';

/** (ADR-062 O1) The labeled set of desk.opportunity.record and its per-field scorer. */
const positives = OPPORTUNITY_LABELED_SET.filter((c) => c.expected !== null);
/** What a perfect @2 run records: the label (with its signals), a sin_intencion record with the reason, or nothing. */
const perfectOf = (c: OpportunityCase): OpportunityPrediction | null =>
  c.expected ? { ...c.expected, ...(c.signals ? { signals: [...c.signals] } : {}) } : c.noIntent ? { trigger: 'conversacion', intent: 'sin_intencion', noIntentReason: c.noIntent, segment: 'desconocido', complexity: 'estandar' } : null;
const perfect = Object.fromEntries(OPPORTUNITY_LABELED_SET.map((c) => [c.id, perfectOf(c)]));

describe('opportunity labeled set', () => {
  it('has at least 20 conversations with unique ids, covering every intent, the four segments, projects and FAQ negatives', () => {
    expect(OPPORTUNITY_LABELED_SET.length).toBeGreaterThanOrEqual(20);
    expect(new Set(OPPORTUNITY_LABELED_SET.map((c) => c.id)).size).toBe(OPPORTUNITY_LABELED_SET.length);
    const has = (field: keyof OpportunityLabel) => new Set(positives.map((c) => c.expected![field]));
    for (const intent of DESK_INTENTS) expect(has('intent')).toContain(intent);
    for (const segment of ['persona', 'empresa', 'mayorista', 'institucional']) expect(has('segment')).toContain(segment);
    for (const complexity of DESK_COMPLEXITIES) expect(has('complexity')).toContain(complexity);
    expect(OPPORTUNITY_LABELED_SET.filter((c) => c.expected === null).length).toBeGreaterThanOrEqual(4);
  });

  it('every label is a valid capability input; no contact data in the conversations', () => {
    for (const c of positives) expect(deskOpportunityInput.safeParse({ ...c.expected, productRefs: [], summary: 'resumen' }).success, c.id).toBe(true);
    for (const c of OPPORTUNITY_LABELED_SET) for (const t of c.visitor) expect(t, c.id).not.toMatch(/@|\d{8,}|\+56/);
  });

  it('channel cases: at least 5 WhatsApp (with a handoff), 3 Instagram and 3 Facebook; triggers only where the channel has them', () => {
    const wa = opportunityCasesOf('whatsapp');
    const ig = opportunityCasesOf('instagram');
    const fb = opportunityCasesOf('facebook');
    expect(wa.length).toBeGreaterThanOrEqual(5);
    expect(ig.length).toBeGreaterThanOrEqual(3);
    expect(fb.length).toBeGreaterThanOrEqual(3);
    expect(wa.some((c) => c.expected?.trigger === 'traspaso')).toBe(true);
    // Meta never hands off and never quotes ((v23) the web chat hands B2B needs to the team with [[contacto]]).
    for (const c of [...ig, ...fb]) expect(c.expected?.trigger, c.id).not.toBe('traspaso');
    for (const c of [...ig, ...fb]) expect(c.expected?.trigger, c.id).not.toBe('cotizacion');
    expect(opportunityCasesOf('web').length + wa.length + ig.length + fb.length).toBe(OPPORTUNITY_LABELED_SET.length);
  });

  it('(sales-web@23 / sales-production@29) web and WhatsApp wholesale, institutional and project needs are traspaso with the handoff signal', () => {
    const b2b = [...opportunityCasesOf('web'), ...opportunityCasesOf('whatsapp')].filter((c) => c.expected && (c.expected.segment === 'mayorista' || c.expected.segment === 'institucional' || c.expected.complexity === 'proyecto'));
    expect(b2b.length).toBeGreaterThanOrEqual(10);
    for (const c of b2b) {
      expect(c.expected!.trigger, c.id).toBe('traspaso');
      expect(c.signals, c.id).toContain('traspaso');
    }
    // (Owner 2026-11-26) WhatsApp offers a person first: its B2B cases end with the customer's acceptance (opp-sg-03
    // asks for a person itself).
    for (const id of ['opp-wa-02-traspaso-limite', 'opp-wa-04-mayorista', 'opp-wa-06-institucional']) expect(b2b.find((c) => c.id === id)!.visitor.at(-1), id).toMatch(/^Sí/);
    // A company that only asks for a factura on a normal purchase is not handed off.
    expect(OPPORTUNITY_LABELED_SET.find((c) => c.id === 'opp-19-compra-empresa-factura')!.expected!.trigger).toBe('consulta');
  });

  it('(sales-web@22 exam) a real purchase after a joke is an opportunity with a product signal', () => {
    const c = OPPORTUNITY_LABELED_SET.find((x) => x.id === 'opp-ni-14-broma-luego-compra')!;
    expect(c.expected).toEqual({ trigger: 'conversacion', intent: 'compra', segment: 'persona', complexity: 'estandar' });
    expect(c.signals).toEqual(['producto']);
    // The prediction is the conversation's first record that is an opportunity, not the joke's sin_intencion record.
    expect(scoreOpportunityRecords({ [c.id]: { ...c.expected!, signals: ['producto'] } }, [c]).misses).toEqual([]);
  });
});

describe('scoreOpportunityRecords', () => {
  it('the labels score 100 % on every field', () => {
    const s = scoreOpportunityRecords(perfect);
    expect(s.record.accuracy).toBe(1);
    for (const f of Object.values(s.fields)) expect(f).toEqual({ correct: positives.length, total: positives.length, accuracy: 1 });
    expect(s.misses).toEqual([]);
  });

  it('a wrong field costs only that field; a missing record costs every field; a record of a FAQ costs the record decision', () => {
    const [a, b] = positives;
    const negative = OPPORTUNITY_LABELED_SET.find((c) => c.expected === null)!;
    const s = scoreOpportunityRecords({ ...perfect, [a!.id]: { ...a!.expected!, segment: a!.expected!.segment === 'mayorista' ? 'persona' : 'mayorista' }, [b!.id]: null, [negative.id]: { trigger: 'conversacion', intent: 'otra', segment: 'persona', complexity: 'estandar' } });
    expect(s.record.correct).toBe(OPPORTUNITY_LABELED_SET.length - 2);
    expect(s.fields.segment.correct).toBe(positives.length - 2);
    for (const f of ['trigger', 'intent', 'complexity'] as const) expect(s.fields[f].correct).toBe(positives.length - 1);
    expect(s.misses.map((m) => `${m.caseId}:${m.field}`)).toEqual(expect.arrayContaining([`${a!.id}:segment`, `${b!.id}:record`, `${negative.id}:record`]));
  });

  it('nothing recorded scores 0 on every field and only the negatives on the record decision', () => {
    const s = scoreOpportunityRecords({});
    expect(s.record.correct).toBe(OPPORTUNITY_LABELED_SET.length - positives.length);
    for (const f of Object.values(s.fields)) expect(f.accuracy).toBe(0);
  });
});

describe('scoring one channel', () => {
  it('scores only that channel\'s cases, so a per-channel QA file is not penalized for the others', () => {
    const wa = opportunityCasesOf('whatsapp');
    const s = scoreOpportunityRecords(Object.fromEntries(wa.map((c) => [c.id, perfectOf(c)])), wa);
    expect(s.cases).toBe(wa.length);
    expect(s.record.accuracy).toBe(1);
    expect(s.misses).toEqual([]);
  });
});

describe('(@2) no intent and signals', () => {
  const noIntent = OPPORTUNITY_LABELED_SET.filter((c) => c.noIntent);
  const withSignals = OPPORTUNITY_LABELED_SET.filter((c) => c.signals);

  it('at least 12 no-intent cases covering jokes, spam, tests, greetings and a pure technical doubt; at least 4 positives with signals', () => {
    expect(noIntent.length).toBeGreaterThanOrEqual(12);
    for (const reason of ['broma', 'spam', 'prueba', 'casual', 'duda_tecnica', 'fuera_de_alcance']) expect(noIntent.map((c) => c.noIntent)).toContain(reason);
    for (const c of noIntent) {
      expect(c.expected, c.id).toBeNull();
      expect(DESK_NO_INTENT_REASONS).toContain(c.noIntent);
      expect(deskOpportunityInputV2.safeParse({ trigger: 'conversacion', intent: 'sin_intencion', noIntentReason: c.noIntent, segment: 'desconocido', complexity: 'estandar', productRefs: [], summary: 'x' }).success).toBe(true);
    }
    expect(withSignals.length).toBeGreaterThanOrEqual(4);
    for (const c of withSignals) expect(c.expected, c.id).not.toBeNull();
  });

  it('a sin_intencion record is no opportunity; a joke recorded as a purchase costs the record decision and the reason', () => {
    const joke = noIntent[0]!;
    expect(scoreOpportunityRecords({ ...perfect, [joke.id]: null }).record.accuracy).toBe(1);
    const asPurchase = scoreOpportunityRecords({ ...perfect, [joke.id]: { trigger: 'conversacion', intent: 'compra', segment: 'persona', complexity: 'estandar' } });
    expect(asPurchase.record.correct).toBe(OPPORTUNITY_LABELED_SET.length - 1);
    expect(asPurchase.noIntentReason.correct).toBe(noIntent.length - 1);
    const wrongReason = scoreOpportunityRecords({ ...perfect, [joke.id]: { ...perfect[joke.id]!, noIntentReason: joke.noIntent === 'spam' ? 'broma' : 'spam' } });
    expect(wrongReason.record.accuracy).toBe(1);
    expect(wrongReason.noIntentReason.correct).toBe(noIntent.length - 1);
  });

  it('signals: every expected signal must be in the recorded body (more is fine; missing one costs the case)', () => {
    const c = withSignals[0]!;
    expect(scoreOpportunityRecords({ ...perfect, [c.id]: { ...perfect[c.id]!, signals: [...c.signals!, 'producto'] } }).signals.accuracy).toBe(1);
    expect(scoreOpportunityRecords({ ...perfect, [c.id]: { ...perfect[c.id]!, signals: c.signals!.slice(1) } }).signals.correct).toBe(withSignals.length - 1);
  });
});
