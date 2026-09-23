import { describe, expect, it } from 'vitest';
import { P95_MIN_SAMPLE, composeOutcome, distribution, finalizeFinding, FindingTaxonomy, modelProfileFingerprint, parseModelProfile, rate, technicalOutcome, type EvaluationSubject, type ModelProfile } from '@r4/evaluation';
import { SalesFixture } from '@r4-sales/agent/evaluations';

function waitingSubject(): EvaluationSubject {
  const f = new SalesFixture({ id: 'outcome-waiting' });
  f.turn('Hola');
  f.respond('¿En qué te ayudo?');
  f.wait();
  return f.build();
}

const taxonomy = FindingTaxonomy.generic();
const finding = (code: string, severity?: 'critical') => finalizeFinding({ code, subjectRef: { kind: 'task', id: 't' }, description: 'x', ...(severity ? { severity } : {}) }, { taxonomy, evaluator: { id: 'test.e', version: 1 }, source: 'deterministic', rubric: null });

describe('TaskOutcome', () => {
  it('a waiting task is technically valid (awaiting input), not a failure', () => {
    const t = technicalOutcome(waitingSubject());
    expect(t).toMatchObject({ status: 'awaiting_input', valid: true, failedRuns: 0 });
  });

  it('keeps technical, goal, business, quality and governance apart', () => {
    const subject = { ...waitingSubject(), task: { ...waitingSubject().task, status: 'completed' as const } };
    const outcome = composeOutcome({ subject, findings: [finding('unsupported_relationship')], semanticEvaluators: { total: 1, inconclusive: 0 }, objective: 'preserved', business: { evaluated: true, outcomes: [{ owner: 'pack', code: 'thing_created', evidenceRefs: [] }] } });
    expect(outcome.technical.status).toBe('completed');
    expect(outcome.technical.valid).toBe(true);
    expect(outcome.quality.status).toBe('issues_found');
    expect(outcome.business).toEqual({ status: 'reported', outcomes: [{ owner: 'pack', code: 'thing_created', evidenceRefs: [] }] });
    expect(outcome.governance.status).toBe('no_violations');
    expect(outcome.goal).toMatchObject({ status: 'in_progress', rootPreserved: true, objective: 'preserved' });
  });

  it('a governance violation is not a quality verdict, and business is not inferred by the framework', () => {
    const outcome = composeOutcome({ subject: waitingSubject(), findings: [finding('command_without_policy_allow')], semanticEvaluators: { total: 0, inconclusive: 0 }, objective: 'not_evaluated', business: { evaluated: false, outcomes: [] } });
    expect(outcome.governance).toEqual({ status: 'violations', violations: 1 });
    expect(outcome.quality.status).toBe('no_issues_found');
    expect(outcome.business.status).toBe('not_evaluated');
    expect(outcome.quality.semanticCoverage).toBe('not_run');
  });

  it('inconclusive semantic evaluation without findings is reported as inconclusive, not as a pass or a fail', () => {
    const outcome = composeOutcome({ subject: waitingSubject(), findings: [], semanticEvaluators: { total: 2, inconclusive: 1 }, objective: 'inconclusive', business: { evaluated: false, outcomes: [] } });
    expect(outcome.quality).toMatchObject({ status: 'inconclusive', semanticCoverage: 'partial' });
    expect(outcome.technical.valid).toBe(true);
  });

  it('a failed run makes the trajectory technically invalid', () => {
    const f = new SalesFixture({ id: 'outcome-failed' });
    f.turn('Hola');
    f.invalid('invalid_decision_schema');
    expect(technicalOutcome(f.build())).toMatchObject({ status: 'failed', valid: false, failedRuns: 1, terminationCodes: ['invalid_decision_schema'] });
  });

  it('critical quality findings are reported as critical', () => {
    const outcome = composeOutcome({ subject: waitingSubject(), findings: [finding('nonexistent_entity_claim', 'critical')], semanticEvaluators: { total: 0, inconclusive: 0 }, objective: 'not_evaluated', business: { evaluated: false, outcomes: [] } });
    expect(outcome.quality.status).toBe('critical_issues_found');
  });
});

describe('metrics', () => {
  it('rates keep numerator and denominator; an empty denominator is null, not 0 or 1', () => {
    expect(rate(3, 4)).toMatchObject({ value: 0.75, numerator: 3, denominator: 4 });
    expect(rate(0, 0).value).toBeNull();
  });

  it('distributions skip and count missing values instead of averaging them as zero', () => {
    const d = distribution([10, null, 20, undefined, 30]);
    expect(d).toMatchObject({ n: 3, missing: 2, min: 10, median: 20, mean: 20, max: 30, values: [10, 20, 30] });
  });

  it(`does not report a p95 below ${P95_MIN_SAMPLE} values (no fake precision)`, () => {
    expect(distribution([1, 2, 3]).p95).toBeNull();
    expect(distribution([1, 2, 3]).note).toMatch(/p95 not reported/);
    const many = Array.from({ length: P95_MIN_SAMPLE }, (_, i) => i + 1);
    expect(distribution(many).p95).toBe(19);
  });

  it('an empty sample has no statistics at all', () => {
    expect(distribution([null, null])).toMatchObject({ n: 0, missing: 2, median: null, mean: null });
  });
});

describe('model profile identity', () => {
  const base: ModelProfile = { role: 'under_test', provider: 'openai_compatible', profile: 'default', host: 'api.example.test', model: 'model-x', maxOutputTokens: 8192, contextWindowTokens: 1_000_000, temperature: null, responseFormat: 'json_object', extras: { thinking: { type: 'enabled' } } };

  it('distinguishes configurations of the same model name', () => {
    const off = { ...base, extras: { thinking: { type: 'disabled' } }, maxOutputTokens: 4096 };
    expect(modelProfileFingerprint(base)).not.toBe(modelProfileFingerprint(off));
    expect(modelProfileFingerprint(base)).not.toBe(modelProfileFingerprint({ ...base, maxOutputTokens: 4096 }));
  });

  it('is stable and ignores what does not change behavior (role, host, profile name)', () => {
    expect(modelProfileFingerprint(base)).toBe(modelProfileFingerprint({ ...base, role: 'evaluator', host: 'other.test', profile: 'judge' }));
    expect(modelProfileFingerprint(base)).toBe(modelProfileFingerprint(JSON.parse(JSON.stringify(base)) as ModelProfile));
  });

  it('refuses credentials in provider extras', () => {
    expect(() => parseModelProfile({ ...base, extras: { headers: { authorization: 'Bearer x' } } })).toThrow(/credentials/);
    expect(() => parseModelProfile({ ...base, apiKey: 'x' })).toThrow();
  });
});
