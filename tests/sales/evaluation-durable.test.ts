import { describe, expect, it } from 'vitest';
import { ScriptedJudge, parseEvaluationSubject, type JudgeRequest } from '@r4/evaluation';
import { HarnessTrajectoryProducer, SCRIPTED_MODEL_PROFILE, evaluateSalesSubject, referenceScenarioSet } from '@r4-sales/agent/evaluations';
import { testAdminDatabaseUrl } from '../support/env.js';

/**
 * R4-G over real durable state: scenarios run through the R4-F harness
 * (scripted stand-in model, fixture domain owners, PostgreSQL), then the
 * trajectory is rebuilt by the canonical reader — Sales projection included —
 * and evaluated. The quote finding/outcome rests on an actual receipt row.
 */
const producer = new HarnessTrajectoryProducer({ adminDatabaseUrl: testAdminDatabaseUrl(), mode: 'scripted' });
const scenario = (id: string) => referenceScenarioSet([id]).scenarios[0]!;

describe('Sales evaluation of durable trajectories', () => {
  it('S11: subject from durable state, workspace projection, business outcome backed by the real receipt', async () => {
    const { subject } = await producer.produce(scenario('S11'));
    expect(parseEvaluationSubject(subject)).toEqual(subject);
    expect(subject.source).toEqual({ kind: 'durable', ref: 'scripted:S11' });
    expect(subject.turns.map((t) => t.text)).toEqual(['Quiero cotizar el Power Rack PR-200, la barra olímpica de 20 kg y los discos de fierro de 50 kg, con despacho a Ñuñoa.', '¿Hasta cuándo es válida?']);
    expect(subject.runs.map((r) => r.turnIndex)).toEqual([1, 2]);
    expect(subject.domain['sales.workspace']?.owner).toBe('sales');
    const receipt = subject.actions.receipts.find((r) => r.capabilityId === 'quote.create' && r.status === 'succeeded')!;
    expect(receipt).toBeDefined();

    // A scripted judge extracts one grounded price and one relation nobody observed.
    const first = subject.responses[0]!;
    const judge = new ScriptedJudge({
      'sales.rubric.claim_extraction': (req: JudgeRequest) => ({ answer: { claims: req.view.subjectId === subject.subjectId ? [
        { responseId: first.responseId, type: 'price', text: 'rack a $289.990', entities: [{ name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }], attributes: { amount: 289_990 } },
        { responseId: first.responseId, type: 'compatibility', text: 'discos compatibles con el rack', entities: [{ name: 'Set discos de fierro 50 kg', kind: 'product', ref: 'PLT-IRON-50' }, { name: 'Power Rack PR-200', kind: 'product', ref: 'RACK-PR200' }], attributes: {} },
      ] : [] } }),
      'sales.rubric.objective_continuity': { answer: { verdict: 'no_issues', objective: 'preserved', findings: [] } },
    });
    const { run, files } = await evaluateSalesSubject(subject, { judge, modelUnderTest: SCRIPTED_MODEL_PROFILE, repro: { gitSha: 'unknown' }, scenario: scenario('S11') });
    expect(run.result.outcome.business.outcomes).toEqual([{ owner: 'sales', code: 'quote_created', evidenceRefs: [{ kind: 'receipt', id: receipt.receiptId }] }]);
    expect(run.result.outcome.governance.status).toBe('no_violations');
    expect(run.result.outcome.technical).toMatchObject({ status: 'awaiting_input', valid: true });
    expect(run.result.findings.map((f) => f.code)).toEqual(['unsupported_relationship']);
    expect(run.result.metrics['sales.quote_claims.receiptBackedClaims']?.value).toBeGreaterThanOrEqual(2);
    expect(run.result.metrics['sales.grounding.groundedFacts']?.value).toBe(1);
    expect(run.reproducibility.scenario).toEqual(scenario('S11'));
    expect(files['manifest.json']).toContain('"source"');
  });

  it('CENTRAL: correction superseded, refresh after expiry not a duplicate, waiting is technically valid', async () => {
    const { subject } = await producer.produce(scenario('CENTRAL'));
    const { run } = await evaluateSalesSubject(subject, { judge: null, modelUnderTest: SCRIPTED_MODEL_PROFILE, repro: { gitSha: 'unknown' } });
    expect(run.result.findings.map((f) => f.code)).toEqual([]);
    expect(run.result.metrics['sales.workspace_continuity.corrections']?.value).toBeGreaterThanOrEqual(1);
    expect(run.result.metrics['sales.workspace_continuity.correctionsSuperseded']?.value).toBe(run.result.metrics['sales.workspace_continuity.corrections']?.value);
    expect(run.result.metrics['r4.goal_continuity.rootGoalValidAcrossRuns']?.value).toBe(1);
    expect(run.result.metrics['r4.efficiency.turns']?.value).toBe(5);
    expect(run.result.metrics['r4.context_composition.contextTokensMax']?.value).toBeGreaterThan(0);
    expect(run.result.outcome.technical).toMatchObject({ status: 'awaiting_input', valid: true });
    expect(run.result.outcome.business.outcomes.map((o) => o.code)).toEqual(['quote_created']);
    expect(run.result.evaluatorResults.filter((r) => r.kind === 'semantic').every((r) => r.status === 'skipped')).toBe(true);
  });
});
