import { describe, expect, it } from 'vitest';
import { checkRegressionLock, checkRubricLock } from '@r4/evaluation';
import { FIXTURE_CASES, SALES_REGRESSION_CASES, SALES_REGRESSION_LOCK, SALES_RUBRICS, SALES_RUBRIC_LOCK, evaluateFixtureCorpus, salesEvaluationDefinition, salesTaxonomy } from '@r4-sales/agent/evaluations';

describe('Sales regression corpus (offline, deterministic judge)', () => {
  it('every active regression case passes on its fixture trajectory', async () => {
    const { results, failedRegressions } = await evaluateFixtureCorpus({ repro: { gitSha: 'unknown' } });
    expect(failedRegressions).toEqual([]);
    expect(results.flatMap((r) => r.regressions.map((c) => c.caseId)).sort()).toEqual(SALES_REGRESSION_CASES.map((c) => c.id).sort());
    for (const r of results) expect(r.run.subject.source.kind).toBe('fixture');
  });

  it('encodes the regressions observed in R4-F (task specification §51 and §80)', () => {
    const titles = SALES_REGRESSION_CASES.map((c) => c.title);
    for (const t of ['conversation id cited as evidence', 'write capability sent as read_capability', 'two AgentDecisions in one provider response', 'trailing prose after JSON', 'unsupported product relationship', 'nonexistent product/category claim', 'budget correction supersedes old value', 'quote claim requires Receipt', 'governed quote success', 'no sub-goals but root objective preserved']) expect(titles).toContain(t);
    for (const c of SALES_REGRESSION_CASES) expect(FIXTURE_CASES.map((f) => f.id)).toContain(c.fixture.ref);
  });

  it('cases and rubrics are locked: an edit without a new version fails here', () => {
    expect(checkRegressionLock(SALES_REGRESSION_CASES, SALES_REGRESSION_LOCK)).toEqual([]);
    expect(checkRubricLock(SALES_RUBRICS, SALES_RUBRIC_LOCK)).toEqual([]);
    const semantic = salesEvaluationDefinition().evaluators.flatMap((e) => (e.descriptor.rubric ? [e.descriptor.rubric] : []));
    expect(checkRubricLock(semantic, SALES_RUBRIC_LOCK)).toEqual([]);
  });

  it('the Sales taxonomy extends the generic one without redefining it', () => {
    const t = salesTaxonomy();
    expect(t.get('quote_claim_without_receipt')).toMatchObject({ category: 'GOVERNANCE', defaultSeverity: 'critical', origin: 'sales' });
    expect(t.get('nonexistent_product_or_category_claim')).toMatchObject({ category: 'BEHAVIOR_QUALITY', origin: 'sales' });
    expect(t.get('unsupported_relationship')?.origin).toBe('r4');
  });
});
