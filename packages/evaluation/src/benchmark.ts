import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { distribution, distributionSchema, rate, type MetricValue } from './metrics.js';
import { describeModelProfile, modelProfileSchema, type ModelProfile } from './model-profile.js';
import { definitionFingerprint, runEvaluation, type EvaluationDefinition, type EvaluationRun } from './pipeline.js';
import type { SemanticJudge } from './semantic.js';
import type { EvaluationSubject } from './subject.js';
import { sha256Schema } from './versioning.js';

/**
 * BenchmarkRun (R4-G): the same corpus, the same evaluation definition, N
 * repetitions per scenario — models are not deterministic, so one run proves
 * little and one isolated failure can matter. Every repetition is kept as its
 * own result; aggregates are computed from them and never replace them.
 *
 * The runner is generic: a pack supplies a TrajectoryProducer (scripted
 * provider, fixtures, or a live model through the existing harness) and the
 * runner only evaluates what was produced. Repetition counts are a caller's
 * choice (smoke / development / benchmark), not a policy baked in here.
 */
export const BENCHMARK_SCHEMA_VERSION = 'r4.benchmark_run.v1';

export interface BenchmarkScenario {
  readonly id: string;
  /** Content version of the scenario definition (a hash or an explicit version). */
  readonly version: string;
}

export interface ProducedTrajectory {
  readonly subject: EvaluationSubject;
}

export interface TrajectoryProducer {
  /** What the producer runs (recorded, never interpreted): e.g. `fixture`, `scripted`, `live`. */
  readonly mode: string;
  produce(scenario: BenchmarkScenario, repetition: number): Promise<ProducedTrajectory>;
}

const numberOrNull = z.number().nullable();

export const benchmarkResultSchema = z.strictObject({
  scenarioId: z.string(),
  scenarioVersion: z.string(),
  repetition: z.int().positive(),
  /** `production_failed`: the trajectory could not be produced (infrastructure), so nothing was evaluated. */
  status: z.enum(['evaluated', 'production_failed']),
  error: z.string().max(500).nullable(),
  evaluationRunId: z.string().nullable(),
  taskId: z.string().nullable(),
  outcome: z
    .strictObject({
      technicalStatus: z.string(),
      technicallyValid: z.boolean(),
      goalStatus: z.string(),
      rootGoalPreserved: z.boolean().nullable(),
      objective: z.string(),
      qualityStatus: z.string(),
      governanceStatus: z.string(),
      businessOutcomes: z.array(z.string()),
    })
    .nullable(),
  metrics: z.record(z.string(), numberOrNull),
  findingCodes: z.record(z.string(), z.int().nonnegative()),
  findingCategories: z.record(z.string(), z.int().nonnegative()),
  evaluatorStatuses: z.record(z.string(), z.string()),
});
export type BenchmarkResult = z.infer<typeof benchmarkResultSchema>;

const countedRate = z.strictObject({ numerator: z.number(), denominator: z.number(), rate: z.number().nullable() });

export const aggregateBlockSchema = z.strictObject({
  results: z.int().nonnegative(),
  evaluated: z.int().nonnegative(),
  productionFailures: z.int().nonnegative(),
  technicalCompletion: countedRate,
  tasksCompleted: z.int().nonnegative(),
  protocolAdherence: countedRate,
  protocolAdherencePerRun: distributionSchema,
  rootGoalPreserved: countedRate,
  governanceViolations: z.int().nonnegative(),
  findingsByCode: z.record(z.string(), z.strictObject({ occurrences: z.int(), runsAffected: z.int() })),
  findingsByCategory: z.record(z.string(), z.strictObject({ occurrences: z.int(), runsAffected: z.int() })),
  inputTokens: distributionSchema,
  outputTokens: distributionSchema,
  modelCalls: distributionSchema,
  modelCallLatencyMedianMs: distributionSchema,
  runDurationMedianMs: distributionSchema,
  semanticInconclusive: z.int().nonnegative(),
});
export type AggregateBlock = z.infer<typeof aggregateBlockSchema>;

export const benchmarkRunSchema = z.strictObject({
  schemaVersion: z.literal(BENCHMARK_SCHEMA_VERSION),
  benchmarkRunId: z.string(),
  label: z.string().max(120),
  mode: z.string(),
  scenarioSet: z.strictObject({ id: z.string(), version: z.string(), scenarios: z.array(z.strictObject({ id: z.string(), version: z.string() })) }),
  modelProfile: modelProfileSchema.extend({ fingerprint: sha256Schema }).nullable(),
  agent: z.strictObject({ agentId: z.string(), version: z.int().positive(), contentHash: z.string().nullable() }),
  gitSha: z.string(),
  protocolVersion: z.string(),
  /** Other axes held constant (or deliberately changed) — e.g. context policy, fixture set. */
  configuration: z.record(z.string(), z.string()),
  repetitions: z.int().positive(),
  evaluationDefinition: z.strictObject({ id: z.string(), version: z.int().positive(), fingerprint: sha256Schema }),
  startedAt: z.string(),
  completedAt: z.string(),
  results: z.array(benchmarkResultSchema),
  aggregate: z.strictObject({ overall: aggregateBlockSchema, byScenario: z.record(z.string(), aggregateBlockSchema) }),
});
export type BenchmarkRun = z.infer<typeof benchmarkRunSchema>;

export interface RunBenchmarkOptions {
  readonly label: string;
  readonly scenarioSet: { readonly id: string; readonly version: string; readonly scenarios: readonly BenchmarkScenario[] };
  readonly repetitions: number;
  readonly producer: TrajectoryProducer;
  readonly definition: EvaluationDefinition;
  readonly judge?: SemanticJudge | null;
  readonly agent: { readonly agentId: string; readonly version: number; readonly contentHash: string | null };
  readonly modelProfile: ModelProfile | null;
  readonly gitSha: string;
  readonly protocolVersion: string;
  readonly configuration?: Readonly<Record<string, string>>;
  readonly benchmarkRunId?: string;
  readonly clock?: () => Date;
  /** Called after each repetition (progress, artifact streaming). */
  readonly onResult?: (result: BenchmarkResult, evaluation: EvaluationRun | null) => void | Promise<void>;
}

export async function runBenchmark(options: RunBenchmarkOptions): Promise<{ benchmark: BenchmarkRun; evaluations: EvaluationRun[] }> {
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) throw new Error('repetitions must be a positive integer');
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const benchmarkRunId = options.benchmarkRunId ?? `bmr_${randomUUID()}`;
  const results: BenchmarkResult[] = [];
  const evaluations: EvaluationRun[] = [];
  for (const scenario of options.scenarioSet.scenarios) {
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      let result: BenchmarkResult;
      let evaluation: EvaluationRun | null = null;
      try {
        const produced = await options.producer.produce(scenario, repetition);
        evaluation = await runEvaluation(produced.subject, options.definition, {
          judge: options.judge ?? null,
          reproducibility: { gitSha: options.gitSha, workingTreeDirty: options.configuration?.gitDirty === undefined ? null : options.configuration.gitDirty === 'true', protocolVersion: options.protocolVersion, modelUnderTest: options.modelProfile, scenario },
          evaluationRunId: `${benchmarkRunId}.${scenario.id}.r${repetition}`,
          clock,
        });
        evaluations.push(evaluation);
        result = resultOf(scenario, repetition, evaluation);
      } catch (error) {
        result = { scenarioId: scenario.id, scenarioVersion: scenario.version, repetition, status: 'production_failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 500), evaluationRunId: null, taskId: null, outcome: null, metrics: {}, findingCodes: {}, findingCategories: {}, evaluatorStatuses: {} };
      }
      results.push(result);
      await options.onResult?.(result, evaluation);
    }
  }
  const byScenario: Record<string, AggregateBlock> = {};
  for (const s of options.scenarioSet.scenarios) byScenario[s.id] = aggregate(results.filter((r) => r.scenarioId === s.id));
  return {
    benchmark: benchmarkRunSchema.parse({
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      benchmarkRunId,
      label: options.label,
      mode: options.producer.mode,
      scenarioSet: { id: options.scenarioSet.id, version: options.scenarioSet.version, scenarios: options.scenarioSet.scenarios.map((s) => ({ id: s.id, version: s.version })) },
      modelProfile: options.modelProfile ? describeModelProfile(options.modelProfile) : null,
      agent: options.agent,
      gitSha: options.gitSha,
      protocolVersion: options.protocolVersion,
      configuration: { ...options.configuration },
      repetitions: options.repetitions,
      evaluationDefinition: { id: options.definition.id, version: options.definition.version, fingerprint: definitionFingerprint(options.definition) },
      startedAt,
      completedAt: clock().toISOString(),
      results,
      aggregate: { overall: aggregate(results), byScenario },
    }),
    evaluations,
  };
}

/** The per-repetition record kept in `scenario-results.jsonl`. */
export function resultOf(scenario: BenchmarkScenario, repetition: number, run: EvaluationRun): BenchmarkResult {
  const findingCodes: Record<string, number> = {};
  const findingCategories: Record<string, number> = {};
  for (const f of run.result.findings) {
    findingCodes[f.code] = (findingCodes[f.code] ?? 0) + 1;
    findingCategories[f.category] = (findingCategories[f.category] ?? 0) + 1;
  }
  const o = run.result.outcome;
  return {
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    repetition,
    status: 'evaluated',
    error: null,
    evaluationRunId: run.evaluationRunId,
    taskId: run.subject.taskId,
    outcome: {
      technicalStatus: o.technical.status,
      technicallyValid: o.technical.valid,
      goalStatus: o.goal.status,
      rootGoalPreserved: o.goal.rootPreserved,
      objective: o.goal.objective,
      qualityStatus: o.quality.status,
      governanceStatus: o.governance.status,
      businessOutcomes: o.business.outcomes.map((b) => b.code),
    },
    metrics: Object.fromEntries(Object.entries(run.result.metrics).map(([k, v]: [string, MetricValue]) => [k, v.value])),
    findingCodes,
    findingCategories,
    evaluatorStatuses: Object.fromEntries(run.result.evaluatorResults.map((r) => [`${r.evaluator.id}@${r.evaluator.version}`, r.status])),
  };
}

const METRIC = {
  validDecisions: 'r4.protocol_adherence.validDecisions',
  decisionAttempts: 'r4.protocol_adherence.decisionAttempts',
  inputTokens: 'r4.efficiency.inputTokens',
  outputTokens: 'r4.efficiency.outputTokens',
  modelCalls: 'r4.efficiency.modelCalls',
  callLatency: 'r4.efficiency.medianModelCallLatencyMs',
  runDuration: 'r4.efficiency.medianRunDurationMs',
};

/**
 * Aggregates repetitions honestly: rates keep numerator and denominator;
 * protocol adherence is pooled over decision attempts (the documented
 * denominator) and also shown per run; distributions skip missing values
 * and count them. No confidence intervals: with small N, counts are the
 * truthful summary.
 */
export function aggregate(results: readonly BenchmarkResult[]): AggregateBlock {
  const evaluated = results.filter((r) => r.status === 'evaluated' && r.outcome !== null);
  const counted = (n: number, d: number) => {
    const r = rate(n, d);
    return { numerator: n, denominator: d, rate: r.value };
  };
  const metric = (name: string) => evaluated.map((r) => r.metrics[name] ?? null);
  const sum = (name: string) => metric(name).reduce<number>((s, v) => s + (v ?? 0), 0);
  const perRunAdherence = evaluated.map((r) => {
    const attempts = r.metrics[METRIC.decisionAttempts];
    const valid = r.metrics[METRIC.validDecisions];
    return attempts === null || attempts === undefined || valid === null || valid === undefined || attempts === 0 ? null : valid / attempts;
  });
  const findingsBy = (key: 'findingCodes' | 'findingCategories') => {
    const out: Record<string, { occurrences: number; runsAffected: number }> = {};
    for (const r of evaluated) {
      for (const [k, n] of Object.entries(r[key])) {
        const entry = (out[k] ??= { occurrences: 0, runsAffected: 0 });
        entry.occurrences += n;
        entry.runsAffected += 1;
      }
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
  };
  return {
    results: results.length,
    evaluated: evaluated.length,
    productionFailures: results.length - evaluated.length,
    technicalCompletion: counted(evaluated.filter((r) => r.outcome!.technicallyValid).length, evaluated.length),
    tasksCompleted: evaluated.filter((r) => r.outcome!.technicalStatus === 'completed').length,
    protocolAdherence: counted(sum(METRIC.validDecisions), sum(METRIC.decisionAttempts)),
    protocolAdherencePerRun: distribution(perRunAdherence),
    rootGoalPreserved: counted(evaluated.filter((r) => r.outcome!.rootGoalPreserved === true).length, evaluated.length),
    governanceViolations: evaluated.reduce((s, r) => s + (r.findingCategories.GOVERNANCE ?? 0), 0),
    findingsByCode: findingsBy('findingCodes'),
    findingsByCategory: findingsBy('findingCategories'),
    inputTokens: distribution(metric(METRIC.inputTokens)),
    outputTokens: distribution(metric(METRIC.outputTokens)),
    modelCalls: distribution(metric(METRIC.modelCalls)),
    modelCallLatencyMedianMs: distribution(metric(METRIC.callLatency)),
    runDurationMedianMs: distribution(metric(METRIC.runDuration)),
    semanticInconclusive: evaluated.reduce((s, r) => s + Object.values(r.evaluatorStatuses).filter((v) => v === 'inconclusive').length, 0),
  };
}
