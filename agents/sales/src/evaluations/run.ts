import { DECISION_PROTOCOL } from '@r4/agent-kernel';
import {
  benchmarkArtifacts,
  checkRegressionCase,
  compareBenchmarks,
  evaluationArtifacts,
  experimentArtifacts,
  runBenchmark,
  runEvaluation,
  type ArtifactFiles,
  type BenchmarkRun,
  type EvaluationRun,
  type EvaluationSubject,
  type Experiment,
  type ExperimentComparison,
  type ModelProfile,
  type RegressionCheck,
  type SemanticJudge,
  type TrajectoryProducer,
} from '@r4/evaluation';
import { SALES_AGENT_ID } from '../ids.js';
import { FixtureTrajectoryProducer, referenceScenarioSet, type FixtureTrajectorySet } from './corpus.js';
import { salesEvaluationDefinition } from './definition.js';
import { FIXTURE_CASES, fixtureJudge } from './fixtures/trajectories.js';
import { SALES_REGRESSION_CASES } from './regressions.js';

/**
 * Evaluation entry points shared by the CLIs and the tests. They only
 * evaluate and produce artifact files in memory; writing them is the
 * caller's (CLI) job. Nothing here reaches the Sales Agent's definition,
 * registry, policy or deployment configuration.
 */
export interface Reproducibility {
  readonly gitSha: string;
  readonly gitDirty?: boolean;
}

export const SALES_PROTOCOL_VERSION = DECISION_PROTOCOL;

export interface EvaluatedSubject {
  readonly run: EvaluationRun;
  readonly regressions: readonly RegressionCheck[];
  readonly files: ArtifactFiles;
}

export async function evaluateSalesSubject(subject: EvaluationSubject, options: { judge: SemanticJudge | null; modelUnderTest: ModelProfile | null; repro: Reproducibility; scenario?: { id: string; version: string } | null; evaluationRunId?: string; fixtureRef?: string; clock?: () => Date; secrets?: readonly string[] }): Promise<EvaluatedSubject> {
  const run = await runEvaluation(subject, salesEvaluationDefinition(), {
    judge: options.judge,
    reproducibility: { gitSha: options.repro.gitSha, workingTreeDirty: options.repro.gitDirty ?? null, protocolVersion: SALES_PROTOCOL_VERSION, modelUnderTest: options.modelUnderTest, scenario: options.scenario ?? null },
    ...(options.evaluationRunId ? { evaluationRunId: options.evaluationRunId } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const regressions = options.fixtureRef ? SALES_REGRESSION_CASES.filter((c) => c.status === 'active' && c.fixture.ref === options.fixtureRef).map((c) => checkRegressionCase(c, run)) : [];
  return { run, regressions, files: evaluationArtifacts(run, { subject, regressions, secrets: options.secrets ?? [] }) };
}

/** Evaluates every fixture trajectory of the corpus and checks its regression cases (offline, deterministic judge). */
export async function evaluateFixtureCorpus(options: { repro: Reproducibility; clock?: () => Date }): Promise<{ results: (EvaluatedSubject & { fixtureId: string })[]; failedRegressions: RegressionCheck[] }> {
  const built = FIXTURE_CASES.map((c) => ({ c, ...c.build() }));
  const judge = fixtureJudge(built);
  const results = [];
  for (const b of built) {
    const evaluated = await evaluateSalesSubject(b.subject, { judge, modelUnderTest: FixtureTrajectoryProducer.modelProfile(), repro: options.repro, evaluationRunId: `evr_fixture_${b.c.id}`, fixtureRef: b.c.id, ...(options.clock ? { clock: options.clock } : {}) });
    results.push({ ...evaluated, fixtureId: b.c.id });
  }
  const covered = new Set(results.flatMap((r) => r.regressions.map((x) => x.caseId)));
  const missing = SALES_REGRESSION_CASES.filter((c) => c.status === 'active' && !covered.has(c.id));
  if (missing.length > 0) throw new Error(`active regression cases without a fixture trajectory: ${missing.map((c) => c.id).join(', ')}`);
  return { results, failedRegressions: results.flatMap((r) => r.regressions.filter((x) => !x.passed)) };
}

export interface SalesBenchmarkOptions {
  readonly producer: TrajectoryProducer;
  readonly judge: SemanticJudge | null;
  readonly repetitions: number;
  readonly modelProfile: ModelProfile | null;
  readonly repro: Reproducibility;
  readonly scenarios?: readonly string[];
  readonly label: string;
  readonly configuration?: Readonly<Record<string, string>>;
  readonly benchmarkRunId?: string;
  readonly clock?: () => Date;
  readonly onResult?: Parameters<typeof runBenchmark>[0]['onResult'];
}

export async function runSalesBenchmark(options: SalesBenchmarkOptions): Promise<{ benchmark: BenchmarkRun; evaluations: EvaluationRun[] }> {
  return runBenchmark({
    label: options.label,
    scenarioSet: referenceScenarioSet(options.scenarios),
    repetitions: options.repetitions,
    producer: options.producer,
    definition: salesEvaluationDefinition(),
    judge: options.judge,
    agent: { agentId: SALES_AGENT_ID, version: 1, contentHash: null },
    modelProfile: options.modelProfile,
    gitSha: options.repro.gitSha,
    protocolVersion: SALES_PROTOCOL_VERSION,
    configuration: { contextPolicy: 'unbounded', ...(options.repro.gitDirty === undefined ? {} : { gitDirty: String(options.repro.gitDirty) }), ...options.configuration },
    ...(options.benchmarkRunId ? { benchmarkRunId: options.benchmarkRunId } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.onResult ? { onResult: options.onResult } : {}),
  });
}

/** Offline benchmark over fixture trajectories (deterministic producer and judge). */
export async function runFixtureBenchmark(options: { set: FixtureTrajectorySet; repetitions: number; repro: Reproducibility; benchmarkRunId?: string; clock?: () => Date }): Promise<{ benchmark: BenchmarkRun; evaluations: EvaluationRun[]; files: ArtifactFiles }> {
  const producer = new FixtureTrajectoryProducer(options.set);
  const result = await runSalesBenchmark({
    producer,
    judge: producer.judge,
    repetitions: options.repetitions,
    modelProfile: FixtureTrajectoryProducer.modelProfile(),
    repro: options.repro,
    label: `fixture benchmark (${options.set})`,
    configuration: { trajectorySet: options.set },
    ...(options.benchmarkRunId ? { benchmarkRunId: options.benchmarkRunId } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return { ...result, files: benchmarkArtifacts(result.benchmark) };
}

/**
 * The offline demonstration experiment: the live-gate-representative corpus
 * against a candidate that no longer makes the unsupported claims, all other
 * axes held constant. The comparison reports deltas only — no winner.
 */
export const GROUNDING_EXPERIMENT: Experiment = {
  experimentId: 'sales-grounding-candidate',
  title: 'Candidate without unsupported compatibility / category claims',
  dimensionChanged: 'configuration',
  configurationKey: 'trajectorySet',
  hypothesis: 'A candidate that stops asserting unobserved relationships and categories removes those findings without changing protocol adherence, technical completion or cost.',
};

export async function runFixtureExperiment(options: { repetitions: number; repro: Reproducibility; clock?: () => Date }): Promise<{ baseline: BenchmarkRun; candidate: BenchmarkRun; comparison: ExperimentComparison; files: ArtifactFiles }> {
  const baseline = await runFixtureBenchmark({ set: 'live-gate-representative', repetitions: options.repetitions, repro: options.repro, benchmarkRunId: 'bmr_fixture_baseline', ...(options.clock ? { clock: options.clock } : {}) });
  const candidate = await runFixtureBenchmark({ set: 'candidate-grounded', repetitions: options.repetitions, repro: options.repro, benchmarkRunId: 'bmr_fixture_candidate', ...(options.clock ? { clock: options.clock } : {}) });
  const comparison = compareBenchmarks(GROUNDING_EXPERIMENT, baseline.benchmark, candidate.benchmark);
  return { baseline: baseline.benchmark, candidate: candidate.benchmark, comparison, files: experimentArtifacts(comparison) };
}
