import { describe, expect, it } from 'vitest';
import {
  FINDING_CATEGORIES,
  FindingTaxonomy,
  GENERIC_FINDING_CODES,
  finalizeFinding,
  findingSchema,
  mergeFindings,
  type Finding,
} from '@r4/evaluation';

const taxonomy = FindingTaxonomy.generic();
const det = { taxonomy, evaluator: { id: 'test.det', version: 1 }, source: 'deterministic' as const, rubric: null };
const sem = { taxonomy, evaluator: { id: 'test.sem', version: 2 }, source: 'semantic' as const, rubric: { id: 'test.rubric', version: 1, hash: 'a'.repeat(64) } };
const response = { kind: 'response' as const, id: 'r-1' };

describe('failure taxonomy', () => {
  it('files every generic code under one of the ten top-level categories', () => {
    expect(FINDING_CATEGORIES).toEqual(['PLATFORM', 'PROVIDER', 'MODEL_PROTOCOL', 'CONTEXT', 'CAPABILITY', 'DOMAIN', 'GOAL', 'STATE', 'GOVERNANCE', 'BEHAVIOR_QUALITY']);
    for (const c of GENERIC_FINDING_CODES) expect(FINDING_CATEGORIES).toContain(c.category);
    expect(new Set(GENERIC_FINDING_CODES.map((c) => c.code)).size).toBe(GENERIC_FINDING_CODES.length);
  });

  it('contains the protocol and behavior codes observed in R4-F', () => {
    const codes = (category: string) => GENERIC_FINDING_CODES.filter((c) => c.category === category).map((c) => c.code);
    expect(codes('MODEL_PROTOCOL').sort()).toEqual(['invalid_evidence_reference', 'invalid_structured_output', 'multiple_decisions', 'protocol_non_adherence', 'trailing_non_protocol_output', 'wrong_decision_type']);
    expect(codes('BEHAVIOR_QUALITY')).toEqual(expect.arrayContaining(['unsupported_claim', 'unsupported_relationship', 'nonexistent_entity_claim', 'repeated_question', 'already_known_question', 'unnecessary_question', 'premature_completion', 'premature_action', 'objective_drift', 'weak_recommendation']));
    // Governance violations are always critical.
    for (const c of GENERIC_FINDING_CODES.filter((x) => x.category === 'GOVERNANCE')) expect(c.defaultSeverity).toBe('critical');
  });

  it('is extensible by packs under existing categories, never by redefinition', () => {
    const extended = taxonomy.extend({ id: 'pack', version: 1, codes: [{ code: 'pack_specific', category: 'BEHAVIOR_QUALITY', defaultSeverity: 'low', detection: 'semantic', description: 'x', origin: 'pack' }] });
    expect(extended.get('pack_specific')?.origin).toBe('pack');
    expect(taxonomy.get('pack_specific')).toBeUndefined();
    expect(() => taxonomy.extend({ id: 'pack', version: 1, codes: [{ ...GENERIC_FINDING_CODES[0]!, origin: 'pack' }] })).toThrow(/never redefined/);
    expect(() => taxonomy.extend({ id: 'pack', version: 1, codes: [{ code: 'x_code', category: 'NOT_A_CATEGORY' as never, defaultSeverity: 'low', detection: 'semantic', description: 'x', origin: 'pack' }] })).toThrow(/unknown category/);
    expect(() => taxonomy.require('made_up')).toThrow(/not part of taxonomy/);
  });
});

describe('Finding', () => {
  it('takes its category from the taxonomy (what) and keeps severity separate (how bad)', () => {
    const f = finalizeFinding({ code: 'unsupported_relationship', subjectRef: response, description: 'x' }, det);
    expect(f).toMatchObject({ category: 'BEHAVIOR_QUALITY', code: 'unsupported_relationship', severity: 'medium', source: 'deterministic', confidence: null, rubric: null, rationale: null });
    const raised = finalizeFinding({ code: 'unsupported_relationship', subjectRef: response, description: 'x', severity: 'high' }, det);
    expect(raised.category).toBe('BEHAVIOR_QUALITY');
    expect(raised.severity).toBe('high');
  });

  it('has a stable, content-derived id', () => {
    const a = finalizeFinding({ code: 'unsupported_claim', subjectRef: response, description: 'x', evidenceRefs: [{ kind: 'observation', id: 'o2' }, { kind: 'observation', id: 'o1' }] }, det);
    const b = finalizeFinding({ code: 'unsupported_claim', subjectRef: response, description: 'y', evidenceRefs: [{ kind: 'observation', id: 'o1' }, { kind: 'observation', id: 'o2' }] }, det);
    expect(a.findingId).toBe(b.findingId);
    expect(a.evidenceRefs.map((r) => r.id)).toEqual(['o1', 'o2']);
  });

  it('semantic findings carry confidence and rubric; deterministic ones never carry a rationale', () => {
    const s = finalizeFinding({ code: 'objective_drift', subjectRef: response, description: 'x', confidence: 'high', rationale: 'Later turns stop addressing the objective.' }, sem);
    expect(s).toMatchObject({ source: 'semantic', confidence: 'high', rubric: { id: 'test.rubric', version: 1 } });
    const bad = { ...s, source: 'deterministic' };
    expect(findingSchema.safeParse(bad).success).toBe(false);
    expect(findingSchema.safeParse({ ...s, confidence: null }).success).toBe(false);
  });

  it('rejects a reasoning field and an overlong rationale (no chain-of-thought is stored)', () => {
    const s = finalizeFinding({ code: 'objective_drift', subjectRef: response, description: 'x', confidence: 'low', rationale: 'short' }, sem);
    expect(findingSchema.safeParse({ ...s, reasoning: 'step 1 … step 2 …' }).success).toBe(false);
    expect(findingSchema.safeParse({ ...s, rationale: 'x'.repeat(281) }).success).toBe(false);
  });

  it('refuses codes outside the taxonomy', () => {
    expect(() => finalizeFinding({ code: 'invented_code', subjectRef: response, description: 'x' }, det)).toThrow();
  });
});

describe('finding dedupe', () => {
  const f = (over: Partial<Finding>, ctx: Parameters<typeof finalizeFinding>[1] = det): Finding => ({ ...finalizeFinding({ code: over.code ?? 'unsupported_claim', subjectRef: over.subjectRef ?? response, description: 'x', evidenceRefs: over.evidenceRefs ?? [], ...(ctx.source === 'semantic' ? { confidence: 'medium' as const, rationale: 'r' } : {}) }, ctx) });

  it('folds the same code on the same subject and evidence into one finding', () => {
    const a = f({});
    const b = { ...f({}, { ...det, evaluator: { id: 'test.other', version: 1 } }) };
    const merged = mergeFindings([a, b], new Set());
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]!.alsoReportedBy).toEqual([{ id: 'test.other', version: 1 }]);
    expect(merged.suppressed.map((s) => s.reason)).toEqual(['duplicate']);
  });

  it('keeps distinct evidence apart', () => {
    const merged = mergeFindings([f({ evidenceRefs: [{ kind: 'claim', id: 'c1' }] }), f({ evidenceRefs: [{ kind: 'claim', id: 'c2' }] })], new Set());
    expect(merged.findings).toHaveLength(2);
  });

  it('a semantic finding never overrides a code a deterministic evaluator is authoritative for', () => {
    const judged = f({ code: 'success_claim_without_receipt' }, sem);
    const merged = mergeFindings([judged], new Set(['success_claim_without_receipt']));
    expect(merged.findings).toEqual([]);
    expect(merged.suppressed[0]!.reason).toBe('deterministic_authority');
  });

  it('a semantic confirmation of a deterministic finding (same code and subject) is folded into it', () => {
    const merged = mergeFindings([f({ code: 'already_known_question', evidenceRefs: [{ kind: 'domain', id: 'd' }] }), f({ code: 'already_known_question' }, sem)], new Set());
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]!.source).toBe('deterministic');
  });
});
