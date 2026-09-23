import { describe, expect, it } from 'vitest';
import {
  FindingTaxonomy,
  GroundingEvaluator,
  OBJECTIVE_CONTINUITY_RUBRIC,
  RubricEvaluator,
  ScriptedJudge,
  assertDefinition,
  checkRubricLock,
  classifyClaim,
  defineRubric,
  genericDeterministicEvaluators,
  rubricHash,
  runEvaluation,
  type ClaimExtractor,
  type EvaluationDefinition,
  type EvaluationSubject,
  type Evaluator,
} from '@r4/evaluation';
import { SalesClaimVerifier, SalesFixture } from '@r4-sales/agent/evaluations';

function subject(): EvaluationSubject {
  const f = new SalesFixture({ id: 'semantic-unit' });
  f.turn('Quiero armar un gym en casa.');
  f.searchCatalog({ category: 'racks' }, ['RACK-PR200', 'BAR-OLY20']);
  f.respond('El Power Rack PR-200 cuesta $289.990 y es compatible con la barra olímpica de 20 kg.');
  f.wait();
  return f.build();
}

const repro = { gitSha: 'unknown', protocolVersion: 'test.v1', modelUnderTest: null };
const objective = new RubricEvaluator({ ref: { id: 'test.objective', version: 1 }, rubric: OBJECTIVE_CONTINUITY_RUBRIC, description: 'objective', assessesObjective: true });

function definition(evaluators: Evaluator[], timeoutMs = 200): EvaluationDefinition {
  return { id: 'test.definition', version: 1, taxonomy: FindingTaxonomy.generic(), evaluators, privacy: { redactKeys: ['email'] }, semanticTimeoutMs: timeoutMs };
}

const valid = (s: EvaluationSubject) => ({ answer: { verdict: 'issues_found', objective: 'drifted', findings: [{ code: 'objective_drift', subjectRef: { kind: 'response', id: s.responses[0]!.responseId }, evidenceRefs: [], confidence: 'medium', rationale: 'The answer ignores the stated objective.' }] } });

describe('semantic evaluator boundary', () => {
  it('turns a valid structured verdict into semantic findings with confidence and rubric identity', async () => {
    const s = subject();
    const run = await runEvaluation(s, definition([objective]), { judge: new ScriptedJudge({ 'r4.rubric.objective_continuity': valid(s) }), reproducibility: repro });
    expect(run.result.findings).toHaveLength(1);
    expect(run.result.findings[0]).toMatchObject({ code: 'objective_drift', source: 'semantic', confidence: 'medium', rubric: { id: 'r4.rubric.objective_continuity', version: 1, hash: rubricHash(OBJECTIVE_CONTINUITY_RUBRIC) } });
    expect(run.result.outcome.goal.objective).toBe('drifted');
    expect(run.reproducibility.evaluatorModel).toMatchObject({ role: 'evaluator', provider: 'scripted' });
  });

  it.each([
    ['malformed output', { answer: { verdict: 'issues_found', findings: 'lots' } }, 'judge_invalid_output'],
    ['reasoning smuggled into the verdict', { answer: { verdict: 'no_issues', objective: 'preserved', findings: [], reasoning: 'first I thought…' } }, 'judge_invalid_output'],
    ['a code the rubric does not allow', { answer: { verdict: 'issues_found', objective: 'drifted', findings: [{ code: 'unsupported_claim', subjectRef: { kind: 'task', id: 'x' }, evidenceRefs: [], confidence: 'low', rationale: 'r' }] } }, 'judge_disallowed_code'],
    ['an explicit inconclusive verdict', { answer: { verdict: 'inconclusive', findings: [] } }, 'judge_declared_inconclusive'],
    ['a verdict without the objective assessment', { answer: { verdict: 'no_issues', findings: [] } }, 'judge_missing_objective_assessment'],
    ['a self-contradicting verdict', { answer: { verdict: 'no_issues', objective: 'drifted', findings: [{ code: 'objective_drift', subjectRef: { kind: 'task', id: 'x' }, evidenceRefs: [], confidence: 'low', rationale: 'r' }] } }, 'judge_inconsistent_verdict'],
    ['a judge error', { throws: 'upstream 500' }, 'judge_error'],
    ['a judge timeout', { timeout: true as const }, 'judge_timeout'],
  ])('%s → inconclusive, never a failure of the agent under test', async (_label, answer, reason) => {
    const run = await runEvaluation(subject(), definition([...genericDeterministicEvaluators(), objective]), { judge: new ScriptedJudge({ 'r4.rubric.objective_continuity': answer }), reproducibility: repro });
    const result = run.result.evaluatorResults.find((r) => r.evaluator.id === 'test.objective')!;
    expect(result).toMatchObject({ status: 'inconclusive', reason, findings: 0 });
    expect(run.status).toBe('completed_with_inconclusive');
    expect(run.result.findings.filter((f) => f.source === 'semantic')).toEqual([]);
    expect(run.result.outcome.technical.valid).toBe(true);
    expect(run.result.outcome.quality).toMatchObject({ status: 'inconclusive', semanticCoverage: 'partial' });
    expect(run.result.outcome.goal.objective).toBe('inconclusive');
  });

  it('a verdict citing records that do not exist is inconclusive', async () => {
    const answer = { answer: { verdict: 'issues_found', objective: 'drifted', findings: [{ code: 'objective_drift', subjectRef: { kind: 'response', id: 'not-a-response' }, evidenceRefs: [], confidence: 'high', rationale: 'r' }] } };
    const run = await runEvaluation(subject(), definition([objective]), { judge: new ScriptedJudge({ 'r4.rubric.objective_continuity': answer }), reproducibility: repro });
    expect(run.result.evaluatorResults[0]).toMatchObject({ status: 'inconclusive', reason: 'judge_unknown_reference' });
  });

  it('without a judge, semantic evaluators are skipped and reported, never faked', async () => {
    const run = await runEvaluation(subject(), definition([...genericDeterministicEvaluators(), objective]), { reproducibility: repro });
    expect(run.result.evaluatorResults.find((r) => r.evaluator.id === 'test.objective')).toMatchObject({ status: 'skipped', reason: 'no judge configured' });
    expect(run.reproducibility.evaluatorModel).toBeNull();
    expect(run.result.outcome.quality.semanticCoverage).toBe('not_run');
  });

  it('the judge only sees the privacy projection, with deterministic findings marked as established', async () => {
    const judge = new ScriptedJudge({ 'r4.rubric.objective_continuity': { answer: { verdict: 'no_issues', objective: 'preserved', findings: [] } } });
    await runEvaluation(subject(), definition([...genericDeterministicEvaluators(), objective]), { judge, reproducibility: repro });
    const view = judge.requests[0]!.view;
    expect(Object.keys(view).sort()).toEqual(['actions', 'domain', 'establishedFindings', 'objective', 'observations', 'responses', 'subjectId', 'turns']);
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/correlationId|leaseGeneration|trustedContext|requestedBy|contentHash/);
    expect(judge.requests[0]!.rubric.hash).toBe(rubricHash(OBJECTIVE_CONTINUITY_RUBRIC));
  });
});

describe('grounding', () => {
  it('classifies claims: fact, derived recommendation, unsupported claim, unsupported relationship, nonexistent entity', () => {
    const grounded = { entities: [{ name: 'a', grounded: true, ref: 'A' }], supported: true, evidenceRefs: ['o'] };
    expect(classifyClaim({ type: 'price' }, grounded)).toBe('GROUNDED_FACT');
    expect(classifyClaim({ type: 'recommendation' }, { ...grounded, supported: false })).toBe('DERIVED_RECOMMENDATION');
    expect(classifyClaim({ type: 'price' }, { ...grounded, supported: false })).toBe('UNSUPPORTED_CLAIM');
    expect(classifyClaim({ type: 'compatibility' }, { ...grounded, supported: false })).toBe('UNSUPPORTED_RELATIONSHIP');
    expect(classifyClaim({ type: 'compatibility' }, { entities: [{ name: 'a', grounded: true, ref: 'A' }, { name: 'z', grounded: false, ref: null }], supported: false, evidenceRefs: [] })).toBe('NONEXISTENT_ENTITY');
    // A recommendation about something that does not exist is still a nonexistent entity.
    expect(classifyClaim({ type: 'recommendation' }, { entities: [{ name: 'z', grounded: false, ref: null }], supported: true, evidenceRefs: [] })).toBe('NONEXISTENT_ENTITY');
  });

  it('extraction by the judge, verification by the evidence available to that response', async () => {
    const s = subject();
    const extractor: ClaimExtractor = {
      ref: { id: 'test.extractor', version: 1 },
      kind: 'semantic',
      rubric: defineRubric({ id: 'test.rubric.claims', version: 1, title: 'claims', instructions: 'Extract every claim from the responses, nothing else.', allowedCodes: [], output: 'claims' }),
      extract: () => Promise.resolve({ ok: true as const, claims: [
        { responseId: s.responses[0]!.responseId, type: 'price' as const, text: 'PR-200 cuesta $289.990', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }], attributes: { amount: 289_990 } },
        { responseId: s.responses[0]!.responseId, type: 'compatibility' as const, text: 'PR-200 compatible con barra 20 kg', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }, { name: 'Barra olímpica 20 kg', kind: 'product', ref: 'BAR-OLY20' }], attributes: {} },
      ] }),
    };
    const grounding = new GroundingEvaluator({ ref: { id: 'test.grounding', version: 1 }, extractor, verifier: new SalesClaimVerifier() });
    const run = await runEvaluation(s, definition([grounding]), { judge: new ScriptedJudge({}), reproducibility: repro });
    expect(run.result.findings.map((f) => f.code)).toEqual(['unsupported_relationship']);
    expect(run.result.metrics['test.grounding.groundedFacts']?.value).toBe(1);
    expect(run.result.metrics['test.grounding.groundedness']).toMatchObject({ numerator: 1, denominator: 2 });
  });
});

describe('evaluation pipeline', () => {
  it('runs deterministic evaluators before semantic ones, whatever the definition order', async () => {
    const order: string[] = [];
    const spy = (id: string, kind: 'deterministic' | 'semantic'): Evaluator => ({
      descriptor: { ref: { id, version: 1 }, kind, description: id, emits: [], ...(kind === 'semantic' ? { rubric: OBJECTIVE_CONTINUITY_RUBRIC } : {}) },
      evaluate: () => (order.push(id), { findings: [], status: 'completed' }),
    });
    await runEvaluation(subject(), definition([spy('test.sem', 'semantic'), spy('test.det', 'deterministic')]), { judge: new ScriptedJudge({}), reproducibility: repro });
    expect(order).toEqual(['test.det', 'test.sem']);
  });

  it('an evaluator cannot modify the trajectory (the subject is a frozen copy)', async () => {
    const s = subject();
    const before = JSON.stringify(s);
    const tamper: Evaluator = {
      descriptor: { ref: { id: 'test.tamper', version: 1 }, kind: 'deterministic', description: 'tries to write', emits: [] },
      evaluate: (subj) => {
        (subj.task as { status: string }).status = 'completed';
        return { findings: [] };
      },
    };
    const run = await runEvaluation(s, definition([tamper]), { reproducibility: repro });
    expect(run.result.evaluatorResults[0]).toMatchObject({ status: 'error' });
    expect(run.status).toBe('completed_with_errors');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('an evaluator emitting an undeclared code is an evaluator error, not a finding', async () => {
    const liar: Evaluator = { descriptor: { ref: { id: 'test.liar', version: 1 }, kind: 'deterministic', description: 'x', emits: ['unsupported_claim'] }, evaluate: () => ({ findings: [{ code: 'objective_drift', subjectRef: { kind: 'task', id: 't' }, description: 'x' }] }) };
    const run = await runEvaluation(subject(), definition([liar]), { reproducibility: repro });
    expect(run.result.findings).toEqual([]);
    expect(run.result.evaluatorResults[0]!.status).toBe('error');
  });

  it('requires evaluator id and version, and a versioned rubric for semantic evaluators', () => {
    const noVersion = { descriptor: { ref: { id: 'test.x' } as never, kind: 'deterministic' as const, description: 'x', emits: [] }, evaluate: () => ({ findings: [] }) };
    expect(() => assertDefinition(definition([noVersion]))).toThrow(/version/);
    const noRubric = { descriptor: { ref: { id: 'test.y', version: 1 }, kind: 'semantic' as const, description: 'x', emits: [] }, evaluate: () => ({ findings: [] }) };
    expect(() => assertDefinition(definition([noRubric]))).toThrow(/rubric/);
    expect(() => defineRubric({ ...OBJECTIVE_CONTINUITY_RUBRIC, version: 0 })).toThrow();
    const emitsUnknown = { descriptor: { ref: { id: 'test.z', version: 1 }, kind: 'deterministic' as const, description: 'x', emits: ['not_a_code'] }, evaluate: () => ({ findings: [] }) };
    expect(() => assertDefinition(definition([emitsUnknown]))).toThrow(/not part of taxonomy/);
  });

  it('a rubric edited without a new version is detected by the lock', () => {
    const lock = { [`${OBJECTIVE_CONTINUITY_RUBRIC.id}@1`]: rubricHash(OBJECTIVE_CONTINUITY_RUBRIC) };
    expect(checkRubricLock([OBJECTIVE_CONTINUITY_RUBRIC], lock)).toEqual([]);
    const edited = defineRubric({ ...OBJECTIVE_CONTINUITY_RUBRIC, instructions: `${OBJECTIVE_CONTINUITY_RUBRIC.instructions}\nBe lenient.` });
    expect(checkRubricLock([edited], lock)[0]).toMatch(/changed without a new version/);
    expect(checkRubricLock([defineRubric({ ...edited, version: 2 })], lock)[0]).toMatch(/not in the rubric lock/);
  });
});
