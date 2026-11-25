import { describe, expect, it } from 'vitest';
import { DESK_COMPLEXITIES, DESK_INTENTS, deskOpportunityInput } from '@r4-sales/agent';
import { OPPORTUNITY_LABELED_SET, scoreOpportunityRecords, type OpportunityLabel } from '@r4-sales/agent/evaluations';

/** (ADR-062 O1) The labeled set of desk.opportunity.record and its per-field scorer. */
const positives = OPPORTUNITY_LABELED_SET.filter((c) => c.expected !== null);
const perfect = Object.fromEntries(OPPORTUNITY_LABELED_SET.map((c) => [c.id, c.expected]));

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
