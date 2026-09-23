import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  REGRESSION_SCHEMA_VERSION,
  acceptRegressionCase,
  assertArtifactSafe,
  checkRegressionCase,
  checkRegressionLock,
  defineRegressionCase,
  projectSemanticView,
  proposeRegressionCase,
  regressionCaseHash,
} from '@r4/evaluation';
import { SalesFixture, evaluateSalesSubject, salesEvaluationDefinition } from '@r4-sales/agent/evaluations';

function customerSubject() {
  const f = new SalesFixture({ id: 'privacy-unit', customerRef: 'cust-demo-001' });
  f.turn('Cotízame el rack');
  f.customerContext();
  f.respond('Hola Camila, ¿te envío la cotización a tu correo registrado?');
  f.wait();
  return f.build();
}

describe('privacy projection for judges', () => {
  it('redacts personal contact fields and never carries operational identifiers', () => {
    const view = projectSemanticView(customerSubject(), salesEvaluationDefinition().privacy);
    const text = JSON.stringify(view);
    expect(text).not.toContain('camila.rojas@example.test');
    expect(text).not.toContain('+56900000001');
    expect(text).toContain(REDACTED);
    expect(text).toContain('Camila Rojas');
    expect(text).not.toMatch(/correlationId|trustedContext|leaseGeneration|requestedBy/);
  });

  it('drops reasoning-shaped keys and credential-shaped strings from anything a judge sees', () => {
    const s = customerSubject();
    const tampered = { ...s, observations: s.observations.map((o) => ({ ...o, payload: { note: 'Bearer sk-abcdefghijklmnop', reasoning_content: 'I think…', ok: true } })) };
    const text = JSON.stringify(projectSemanticView(tampered, { redactKeys: [] }));
    expect(text).not.toContain('reasoning_content');
    expect(text).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('artifact privacy gate', () => {
  it.each([
    ['a configured secret', '{"x":"super-secret-value"}', ['super-secret-value']],
    ['an authorization header', '{"authorization":"x"}', []],
    ['a bearer token', 'Bearer abcdefghijklmnopqrstuvwxyz', []],
    ['the model credential variable', 'R4_MODEL_API_KEY=abc', []],
    ['an API key field', '{"api_key":"abc"}', []],
    ['reasoning text', '{"reasoning_content":"step by step"}', []],
    ['chain of thought', '{"chainOfThought":"hmm"}', []],
  ])('refuses %s', (_label, text, secrets) => {
    expect(() => assertArtifactSafe(text, secrets)).toThrow();
  });

  it('accepts provider configuration that is not a credential (e.g. a reasoning mode switch)', () => {
    expect(() => assertArtifactSafe('{"extras":{"thinking":{"type":"enabled"}},"reasoningTokens":null}')).not.toThrow();
  });

  it('evaluation artifacts of a real evaluation carry no secret and no reasoning', async () => {
    const secret = 'sk-live-THIS-MUST-NOT-LEAK-0123456789';
    const { files } = await evaluateSalesSubject(customerSubject(), { judge: null, modelUnderTest: null, repro: { gitSha: 'unknown' }, secrets: [secret] });
    expect(Object.keys(files).sort()).toEqual(['data.json', 'findings.jsonl', 'manifest.json', 'metrics.json', 'report.md', 'subject.json', 'summary.json']);
    for (const text of Object.values(files)) {
      expect(text).not.toContain(secret);
      expect(text).not.toMatch(/"(reasoning|reasoning_content|chainOfThought)"\s*:\s*"/);
      expect(text).not.toMatch(/"authorization"/i);
    }
  });

  it('refuses to produce artifacts when the evaluation itself carries a secret', async () => {
    const f = new SalesFixture({ id: 'privacy-leak' });
    f.turn('mi clave es sk-live-THIS-MUST-NOT-LEAK-0123456789');
    f.respond('ok');
    f.wait();
    await expect(evaluateSalesSubject(f.build(), { judge: null, modelUnderTest: null, repro: { gitSha: 'unknown' }, secrets: ['sk-live-THIS-MUST-NOT-LEAK-0123456789'] })).rejects.toThrow(/refusing artifact/);
  });
});

describe('RegressionCase', () => {
  const base = {
    schemaVersion: REGRESSION_SCHEMA_VERSION,
    id: 'REG-9001',
    version: 1,
    title: 'a test regression',
    origin: { kind: 'fixture' as const, ref: 'x', observedAt: null, note: '' },
    createdFromEvaluation: null,
    fixture: { kind: 'trajectory' as const, ref: 'fixture-x' },
    expectations: [{ kind: 'finding_present' as const, code: 'unsupported_claim' }],
    tags: [],
    status: 'proposed' as const,
    review: null,
  };

  it('an active case needs a recorded human review', () => {
    expect(() => defineRegressionCase({ ...base, status: 'active' })).toThrow(/human review/);
    const accepted = acceptRegressionCase(defineRegressionCase(base), { reviewer: 'someone', reviewedAt: '2026-09-23' });
    expect(accepted).toMatchObject({ status: 'active', review: { reviewer: 'someone', decision: 'accepted' } });
  });

  it('is versioned: changing its expectations without a new version is detected', () => {
    const c = defineRegressionCase(base);
    const lock = { 'REG-9001@1': regressionCaseHash(c) };
    expect(checkRegressionLock([c], lock)).toEqual([]);
    const changed = defineRegressionCase({ ...base, expectations: [{ kind: 'finding_absent', code: 'unsupported_claim' }] });
    expect(checkRegressionLock([changed], lock)[0]).toMatch(/changed without a new version/);
    // Accepting a case (status/review) does not change what it asserts.
    expect(regressionCaseHash(acceptRegressionCase(c, { reviewer: 'r', reviewedAt: 'today' }))).toBe(regressionCaseHash(c));
  });

  it('promotion from a finding produces an inert, proposed case', async () => {
    const f = new SalesFixture({ id: 'promotion' });
    f.turn('Presupuesto 800 mil');
    f.update([{ op: 'record_fact', key: 'presupuesto_clp', value: 800_000, statedBy: 'customer' }]);
    f.respond('¿Cuál es tu presupuesto?');
    f.wait();
    const { run } = await evaluateSalesSubject(f.build(), { judge: null, modelUnderTest: null, repro: { gitSha: 'unknown' } });
    const finding = run.result.findings.find((x) => x.code === 'already_known_question')!;
    const proposal = proposeRegressionCase({ id: 'REG-9002', title: 'asks the known budget', finding, run, fixture: { kind: 'trajectory', ref: 'promotion' } });
    expect(proposal).toMatchObject({ status: 'proposed', review: null, createdFromEvaluation: { evaluationRunId: run.evaluationRunId, findingId: finding.findingId }, expectations: [{ kind: 'finding_present', code: 'already_known_question', minCount: 1 }] });
    expect(checkRegressionCase(proposal, run).passed).toBe(true);
  });

  it('checks every kind of expectation against an evaluation run', async () => {
    const f = new SalesFixture({ id: 'expectations' });
    f.turn('hola');
    f.respond('hola');
    f.wait();
    const { run } = await evaluateSalesSubject(f.build(), { judge: null, modelUnderTest: null, repro: { gitSha: 'unknown' } });
    const c = defineRegressionCase({ ...base, expectations: [
      { kind: 'finding_absent', code: 'unsupported_claim' },
      { kind: 'outcome', path: 'technical.status', equals: 'awaiting_input' },
      { kind: 'outcome', path: 'technical.valid', equals: true },
      { kind: 'metric', name: 'r4.efficiency.turns', equals: 1 },
      { kind: 'business_outcome', code: 'quote_created' },
    ] });
    const check = checkRegressionCase(c, run);
    expect(check.expectations.map((e) => e.passed)).toEqual([true, true, true, true, false]);
    expect(check.passed).toBe(false);
  });
});
