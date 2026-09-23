import { z } from 'zod';
import type { AggregateBlock, BenchmarkRun } from './benchmark.js';
import { round } from './metrics.js';

/**
 * Experiment (R4-G): a controlled comparison of a baseline and a candidate
 * benchmark that should differ in ONE declared dimension. Every other axis
 * is compared and any other difference is reported as a warning — comparing
 * configurations that differ everywhere is allowed, but never silently.
 *
 * The comparison is a set of vectors and deltas. There is deliberately no
 * winner, no ranking and no combined score: which trade-off matters is a
 * human decision.
 */
export const EXPERIMENT_DIMENSIONS = ['modelProfile', 'agent', 'protocolVersion', 'gitSha', 'configuration', 'fixtureSet'] as const;

export const experimentSchema = z.strictObject({
  experimentId: z.string().regex(/^[a-z0-9][a-z0-9_.-]{2,80}$/),
  title: z.string().min(3).max(200),
  dimensionChanged: z.enum(EXPERIMENT_DIMENSIONS),
  /** For `configuration`: which configuration key is the variable. */
  configurationKey: z.string().nullable(),
  hypothesis: z.string().max(500),
});
export type Experiment = z.infer<typeof experimentSchema>;

interface Axis {
  readonly axis: string;
  readonly dimension: (typeof EXPERIMENT_DIMENSIONS)[number];
  readonly value: (b: BenchmarkRun) => string;
}

const AXES: readonly Axis[] = [
  { axis: 'modelProfile', dimension: 'modelProfile', value: (b) => b.modelProfile?.fingerprint ?? 'none' },
  { axis: 'agent', dimension: 'agent', value: (b) => `${b.agent.agentId}@${b.agent.version}:${b.agent.contentHash ?? '-'}` },
  { axis: 'protocolVersion', dimension: 'protocolVersion', value: (b) => b.protocolVersion },
  { axis: 'gitSha', dimension: 'gitSha', value: (b) => b.gitSha },
  { axis: 'scenarioSet', dimension: 'fixtureSet', value: (b) => `${b.scenarioSet.id}@${b.scenarioSet.version}` },
  { axis: 'repetitions', dimension: 'configuration', value: (b) => String(b.repetitions) },
  { axis: 'evaluationDefinition', dimension: 'configuration', value: (b) => b.evaluationDefinition.fingerprint },
  { axis: 'mode', dimension: 'configuration', value: (b) => b.mode },
];

export interface Delta {
  readonly baseline: number | null;
  readonly candidate: number | null;
  readonly delta: number | null;
}

export interface ExperimentComparison {
  readonly experiment: Experiment;
  readonly baseline: { readonly benchmarkRunId: string; readonly label: string };
  readonly candidate: { readonly benchmarkRunId: string; readonly label: string };
  readonly axes: readonly { readonly axis: string; readonly baseline: string; readonly candidate: string; readonly differs: boolean; readonly declared: boolean }[];
  readonly warnings: readonly string[];
  readonly technicalCompletion: { readonly baseline: string; readonly candidate: string; readonly delta: number | null };
  readonly protocolAdherence: { readonly baseline: string; readonly candidate: string; readonly delta: number | null };
  readonly rootGoalPreserved: { readonly baseline: string; readonly candidate: string; readonly delta: number | null };
  readonly metrics: Readonly<Record<string, Delta>>;
  readonly findings: readonly { readonly code: string; readonly baseline: number; readonly candidate: number; readonly delta: number; readonly runsAffectedBaseline: number; readonly runsAffectedCandidate: number }[];
  readonly byScenario: Readonly<Record<string, { readonly findings: Readonly<Record<string, Delta>>; readonly technicalCompletion: Delta }>>;
  readonly note: string;
}

export function compareBenchmarks(experiment: Experiment, baseline: BenchmarkRun, candidate: BenchmarkRun): ExperimentComparison {
  const exp = experimentSchema.parse(experiment);
  const axes = [
    ...AXES.map((a) => ({ axis: a.axis, baseline: a.value(baseline), candidate: a.value(candidate), dimension: a.dimension })),
    ...[...new Set([...Object.keys(baseline.configuration), ...Object.keys(candidate.configuration)])].sort().map((k) => ({ axis: `configuration.${k}`, baseline: baseline.configuration[k] ?? '(unset)', candidate: candidate.configuration[k] ?? '(unset)', dimension: 'configuration' as const, key: k })),
  ].map((a) => {
    const declared = a.dimension === exp.dimensionChanged && (exp.dimensionChanged !== 'configuration' || ('key' in a && a.key === exp.configurationKey));
    return { axis: a.axis, baseline: a.baseline, candidate: a.candidate, differs: a.baseline !== a.candidate, declared };
  });
  const warnings = axes.filter((a) => a.differs && !a.declared).map((a) => `uncontrolled difference on ${a.axis}: ${a.baseline} → ${a.candidate}`);
  if (!axes.some((a) => a.differs && a.declared)) warnings.push(`the declared dimension (${exp.dimensionChanged}) does not differ between baseline and candidate`);
  const b = baseline.aggregate.overall;
  const c = candidate.aggregate.overall;
  const codes = [...new Set([...Object.keys(b.findingsByCode), ...Object.keys(c.findingsByCode)])].sort();
  const scenarios = [...new Set([...Object.keys(baseline.aggregate.byScenario), ...Object.keys(candidate.aggregate.byScenario)])].sort();
  return {
    experiment: exp,
    baseline: { benchmarkRunId: baseline.benchmarkRunId, label: baseline.label },
    candidate: { benchmarkRunId: candidate.benchmarkRunId, label: candidate.label },
    axes,
    warnings,
    technicalCompletion: rateDelta(b.technicalCompletion, c.technicalCompletion),
    protocolAdherence: rateDelta(b.protocolAdherence, c.protocolAdherence),
    rootGoalPreserved: rateDelta(b.rootGoalPreserved, c.rootGoalPreserved),
    metrics: {
      medianInputTokens: delta(b.inputTokens.median, c.inputTokens.median),
      medianOutputTokens: delta(b.outputTokens.median, c.outputTokens.median),
      medianModelCalls: delta(b.modelCalls.median, c.modelCalls.median),
      medianModelCallLatencyMs: delta(b.modelCallLatencyMedianMs.median, c.modelCallLatencyMedianMs.median),
      governanceViolations: delta(b.governanceViolations, c.governanceViolations),
      semanticInconclusive: delta(b.semanticInconclusive, c.semanticInconclusive),
    },
    findings: codes.map((code) => {
      const bb = b.findingsByCode[code] ?? { occurrences: 0, runsAffected: 0 };
      const cc = c.findingsByCode[code] ?? { occurrences: 0, runsAffected: 0 };
      return { code, baseline: bb.occurrences, candidate: cc.occurrences, delta: cc.occurrences - bb.occurrences, runsAffectedBaseline: bb.runsAffected, runsAffectedCandidate: cc.runsAffected };
    }),
    byScenario: Object.fromEntries(
      scenarios.map((s) => {
        const bs = baseline.aggregate.byScenario[s];
        const cs = candidate.aggregate.byScenario[s];
        const sc = [...new Set([...Object.keys(bs?.findingsByCode ?? {}), ...Object.keys(cs?.findingsByCode ?? {})])].sort();
        return [s, { findings: Object.fromEntries(sc.map((code) => [code, delta(bs?.findingsByCode[code]?.occurrences ?? 0, cs?.findingsByCode[code]?.occurrences ?? 0)])), technicalCompletion: delta(bs?.technicalCompletion.rate ?? null, cs?.technicalCompletion.rate ?? null) }];
      }),
    ),
    note: 'Vectors and deltas only. No winner is declared: each dimension is read on its own and trade-offs are a human decision.',
  };
}

function delta(baseline: number | null, candidate: number | null): Delta {
  return { baseline, candidate, delta: baseline === null || candidate === null ? null : round(candidate - baseline) };
}

function rateDelta(b: AggregateBlock['technicalCompletion'], c: AggregateBlock['technicalCompletion']) {
  return { baseline: `${b.numerator}/${b.denominator}`, candidate: `${c.numerator}/${c.denominator}`, delta: b.rate === null || c.rate === null ? null : round(c.rate - b.rate) };
}
