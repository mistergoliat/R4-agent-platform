import { describe, expect, it } from 'vitest';
import { REFERENCE_SCENARIO_IDS, referenceScenarioSet, runFixtureBenchmark, runFixtureExperiment } from '@r4-sales/agent/evaluations';

describe('reference offline benchmark (S02, S03, S04, S11, CENTRAL; fixture producer; N=3)', () => {
  it('evaluates and keeps every repetition, with the live-gate phenomena as findings', async () => {
    const { benchmark, evaluations, files } = await runFixtureBenchmark({ set: 'live-gate-representative', repetitions: 3, repro: { gitSha: 'unknown' } });
    expect(benchmark.scenarioSet.scenarios.map((s) => s.id)).toEqual([...REFERENCE_SCENARIO_IDS]);
    expect(benchmark.results).toHaveLength(15);
    expect(evaluations).toHaveLength(15);
    const overall = benchmark.aggregate.overall;
    // S11 repetition 1 reproduces the live gate's first attempt: trailing text after the JSON decision.
    expect(overall.technicalCompletion).toMatchObject({ numerator: 14, denominator: 15 });
    expect(overall.findingsByCode).toEqual({
      nonexistent_product_or_category_claim: { occurrences: 3, runsAffected: 3 },
      trailing_non_protocol_output: { occurrences: 1, runsAffected: 1 },
      unsupported_relationship: { occurrences: 3, runsAffected: 3 },
    });
    expect(overall.governanceViolations).toBe(0);
    expect(overall.protocolAdherence.numerator).toBe(overall.protocolAdherence.denominator - 1);
    expect(benchmark.aggregate.byScenario.CENTRAL!.rootGoalPreserved).toMatchObject({ numerator: 3, denominator: 3 });
    expect(files['aggregate.json']).toBeDefined();
  });

  it('scenario versions are content hashes of the reused R4-F scenarios (no copy)', () => {
    const a = referenceScenarioSet();
    expect(a).toEqual(referenceScenarioSet());
    expect(a.scenarios.every((s) => /^[0-9a-f]{16}$/.test(s.version))).toBe(true);
  });
});

describe('reference offline experiment (baseline vs grounded candidate)', () => {
  it('shows the finding deltas and unchanged axes, without declaring a winner', async () => {
    const { comparison } = await runFixtureExperiment({ repetitions: 3, repro: { gitSha: 'unknown' } });
    expect(comparison.warnings).toEqual([]);
    expect(comparison.axes.filter((a) => a.differs).map((a) => a.axis)).toEqual(['configuration.trajectorySet']);
    expect(comparison.findings).toEqual([
      { code: 'nonexistent_product_or_category_claim', baseline: 3, candidate: 0, delta: -3, runsAffectedBaseline: 3, runsAffectedCandidate: 0 },
      { code: 'trailing_non_protocol_output', baseline: 1, candidate: 1, delta: 0, runsAffectedBaseline: 1, runsAffectedCandidate: 1 },
      { code: 'unsupported_relationship', baseline: 3, candidate: 0, delta: -3, runsAffectedBaseline: 3, runsAffectedCandidate: 0 },
    ]);
    expect(comparison.technicalCompletion).toEqual({ baseline: '14/15', candidate: '14/15', delta: 0 });
    expect(comparison.protocolAdherence.delta).toBe(0);
    expect(comparison.note).toMatch(/No winner/);
  });
});
