import { describe, expect, it } from 'vitest';
import { FindingTaxonomy, aggregate, benchmarkArtifacts, compareBenchmarks, genericDeterministicEvaluators, runBenchmark, type BenchmarkRun, type EvaluationDefinition, type Experiment, type TrajectoryProducer } from '@r4/evaluation';
import { SalesFixture } from '@r4-sales/agent/evaluations';

const definition: EvaluationDefinition = { id: 'test.bench', version: 1, taxonomy: FindingTaxonomy.generic(), evaluators: genericDeterministicEvaluators(), privacy: { redactKeys: [] }, semanticTimeoutMs: 100 };

/** Repetition 2 of scenario A breaks the protocol; B always waits for input; C cannot be produced once. */
const producer: TrajectoryProducer = {
  mode: 'synthetic',
  produce(scenario, repetition) {
    if (scenario.id === 'C' && repetition === 1) return Promise.reject(new Error('database unavailable'));
    const f = new SalesFixture({ id: `bench-${scenario.id}-${repetition}`, modelCalls: scenario.id !== 'B' });
    f.turn('hola');
    f.searchCatalog({ category: 'racks' }, ['RACK-PR200']);
    if (scenario.id === 'A' && repetition === 2) f.invalid('invalid_structured_output', { jsonDocuments: ['respond'], otherTextChars: 40 });
    else {
      f.respond('Tengo el Power Rack PR-200.');
      f.wait();
    }
    return Promise.resolve({ subject: f.build() });
  },
};

async function bench(label = 'baseline', configuration: Record<string, string> = {}): Promise<BenchmarkRun> {
  const { benchmark } = await runBenchmark({
    label,
    scenarioSet: { id: 'set', version: '1', scenarios: [{ id: 'A', version: 'a1' }, { id: 'B', version: 'b1' }, { id: 'C', version: 'c1' }] },
    repetitions: 3,
    producer,
    definition,
    agent: { agentId: 'agent', version: 1, contentHash: null },
    modelProfile: { role: 'under_test', provider: 'fixture', profile: null, host: null, model: 'm', maxOutputTokens: null, contextWindowTokens: null, temperature: null, responseFormat: null, extras: {} },
    gitSha: 'unknown',
    protocolVersion: 'test.v1',
    configuration,
    benchmarkRunId: `bmr_${label}`,
  });
  return benchmark;
}

describe('BenchmarkRun', () => {
  it('keeps every repetition as its own result (N=3 × 3 scenarios)', async () => {
    const b = await bench();
    expect(b.results).toHaveLength(9);
    expect(b.results.filter((r) => r.scenarioId === 'A').map((r) => r.repetition)).toEqual([1, 2, 3]);
    expect(new Set(b.results.flatMap((r) => (r.evaluationRunId ? [r.evaluationRunId] : []))).size).toBe(8);
  });

  it('a single protocol failure shows in the pooled adherence rate and in its own repetition', async () => {
    const b = await bench();
    const a = b.aggregate.byScenario.A!;
    // Only model decisions count: the platform's turn-closing waits (R4-J1E-R2.2) are not protocol attempts.
    expect(a.protocolAdherence).toMatchObject({ numerator: 5, denominator: 6 });
    expect(a.technicalCompletion).toMatchObject({ numerator: 2, denominator: 3 });
    expect(a.findingsByCode.trailing_non_protocol_output).toEqual({ occurrences: 1, runsAffected: 1 });
    expect(b.results.find((r) => r.scenarioId === 'A' && r.repetition === 2)!.outcome).toMatchObject({ technicalStatus: 'failed', technicallyValid: false });
    expect(a.protocolAdherencePerRun.values).toEqual([1, 0.5, 1]);
  });

  it('a waiting task counts as a technically complete trajectory', async () => {
    const b = await bench();
    expect(b.aggregate.byScenario.B!.technicalCompletion).toMatchObject({ numerator: 3, denominator: 3 });
    expect(b.aggregate.byScenario.B!.tasksCompleted).toBe(0);
  });

  it('does not average metrics across missing values', async () => {
    const b = await bench();
    // B has no harness call records: its latency is missing, not zero.
    expect(b.aggregate.byScenario.B!.modelCallLatencyMedianMs).toMatchObject({ n: 0, missing: 3, median: null });
    expect(b.aggregate.overall.modelCallLatencyMedianMs).toMatchObject({ n: 5, missing: 3 });
  });

  it('records an unproducible trajectory as a production failure, not as an agent failure', async () => {
    const b = await bench();
    const c = b.results.find((r) => r.scenarioId === 'C' && r.repetition === 1)!;
    expect(c).toMatchObject({ status: 'production_failed', error: 'database unavailable', outcome: null });
    expect(b.aggregate.overall).toMatchObject({ results: 9, evaluated: 8, productionFailures: 1 });
    expect(b.aggregate.byScenario.C!.technicalCompletion).toMatchObject({ numerator: 2, denominator: 2 });
  });

  it('aggregate is a pure function of the kept results', async () => {
    const b = await bench();
    expect(aggregate(b.results)).toEqual(b.aggregate.overall);
    expect(aggregate(b.results.slice(1))).not.toEqual(b.aggregate.overall);
  });

  it('artifacts keep the raw repetitions next to the aggregate', async () => {
    const files = benchmarkArtifacts(await bench());
    expect(files['scenario-results.jsonl']!.trim().split('\n')).toHaveLength(9);
    expect(Object.keys(files).sort()).toEqual(['aggregate.json', 'manifest.json', 'report.md', 'scenario-results.jsonl']);
    expect(files['report.md']).toMatch(/Individual repetitions/);
    expect(files['report.md']).not.toMatch(/score/i);
  });

  it('refuses a non-positive repetition count', async () => {
    await expect(runBenchmark({ label: 'x', scenarioSet: { id: 's', version: '1', scenarios: [] }, repetitions: 0, producer, definition, agent: { agentId: 'a', version: 1, contentHash: null }, modelProfile: null, gitSha: 'unknown', protocolVersion: 'v' })).rejects.toThrow(/positive integer/);
  });
});

describe('Experiment', () => {
  const experiment: Experiment = { experimentId: 'test-exp', title: 'prompt v1 vs v2', dimensionChanged: 'configuration', configurationKey: 'prompt', hypothesis: '' };

  it('reports metric, finding and technical-completion deltas — never a winner', async () => {
    const baseline = await bench('baseline', { prompt: 'v1' });
    const candidate = await bench('candidate', { prompt: 'v2' });
    const c = compareBenchmarks(experiment, baseline, candidate);
    expect(c.warnings).toEqual([]);
    expect(c.technicalCompletion).toEqual({ baseline: '7/8', candidate: '7/8', delta: 0 });
    expect(c.findings.find((f) => f.code === 'trailing_non_protocol_output')).toMatchObject({ baseline: 1, candidate: 1, delta: 0 });
    expect(c.metrics.medianModelCalls).toMatchObject({ delta: 0 });
    expect(Object.keys(c)).not.toContain('winner');
    expect(JSON.stringify(c)).not.toMatch(/winner"|"score"|"rank"/i);
  });

  it('warns about every uncontrolled difference', async () => {
    const baseline = await bench('baseline', { prompt: 'v1', contextPolicy: 'unbounded' });
    const candidate = { ...(await bench('candidate', { prompt: 'v2', contextPolicy: 'fixed' })), protocolVersion: 'test.v2' };
    const c = compareBenchmarks(experiment, baseline, candidate);
    expect(c.warnings.join('\n')).toMatch(/configuration.contextPolicy/);
    expect(c.warnings.join('\n')).toMatch(/protocolVersion/);
  });

  it('warns when the declared dimension did not change', async () => {
    const c = compareBenchmarks(experiment, await bench('a', { prompt: 'v1' }), await bench('b', { prompt: 'v1' }));
    expect(c.warnings.join('\n')).toMatch(/does not differ/);
  });
});
