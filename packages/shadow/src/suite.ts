import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  aggregate,
  benchmarkRunSchema,
  definitionFingerprint,
  describeModelProfile,
  runBenchmark,
  type BenchmarkResult,
  type BenchmarkRun,
  type EvaluationDefinition,
  type EvaluationRun,
  type EvaluationSubject,
  type ModelProfile,
  type SemanticJudge,
} from '@r4/evaluation';
import { assertShadowComposition, type DomainBindingDescriptor, type OutboundBindingDescriptor, type ShadowCompositionReport } from './bindings.js';
import { CostMeter, assertPlanWithinGuard, type CostGuard, type CostUsage } from './cost.js';
import type { SideEffectRecord } from './effects.js';
import { buildSideEffectManifest, evaluateShadowSafety, type SafetyCheck, type SafetyCheckCode } from './manifest.js';
import { assertShadowMode, shadowConfigFingerprint, type ShadowExecutionConfig, type ShadowSuiteMode } from './mode.js';
import type { ShadowModelCall } from './model.js';
import type { ShadowOutbound } from './outbound.js';
import { SHADOW_RUN_SCHEMA_VERSION, compositionEntries, operationalMetrics, shadowRunSchema, type EventLogEntry, type InvariantOutcome, type ShadowRun, type TurnTiming } from './run.js';
import { assertWorkloadCorpus, workloadFingerprint, type WorkloadCase, type WorkloadCorpus } from './workload.js';
import { aggregateShadowRuns, type ShadowAggregates } from './aggregate.js';
import { observeGapCandidates } from './observe.js';
import type { ArchitectureGapCandidate } from './gaps.js';

/**
 * ShadowSuiteRun (R4-H): a WorkloadCorpus × repetitions × one model profile,
 * executed under the shadow boundary, then evaluated by R4-G.
 *
 *   plan ─► startup gate (shadow mode, composition, live opt-ins, cost plan)
 *        ─► execute each (case, repetition) through the pack's WorkloadExecutor
 *           (bounded concurrency; cost guard checked before each start;
 *            stop conditions checked after each end)
 *        ─► side-effect manifest + shadow-safety checks per run
 *        ─► R4-G evaluation of every executed trajectory: `runBenchmark` over
 *           the already-produced subjects (evaluation after the suite, the
 *           same machinery, no second benchmark system)
 *        ─► ShadowRuns + merged BenchmarkRun + aggregates + observations
 *
 * The runner is pack-neutral: how a case is executed (ingress, runtime,
 * bindings, operator actions) is the executor's; what is measured and how it
 * is judged is the same for every pack.
 */
export const SHADOW_SUITE_SCHEMA_VERSION = 'r4.shadow_suite_run.v1';

export interface WorkloadExecutorDescription {
  readonly agent: { readonly agentId: string; readonly version: number; readonly contentHash: string | null };
  readonly protocolVersion: string;
  readonly modelProfile: ModelProfile | null;
  /** True when a real model provider decides (needs R4_SHADOW_ALLOW_LIVE_MODEL). */
  readonly liveModel: boolean;
  readonly suiteMode: ShadowSuiteMode;
  readonly bindings: readonly DomainBindingDescriptor[];
  readonly outbound: OutboundBindingDescriptor;
  /** Capabilities whose succeeded receipt means an external owner applied a write. */
  readonly externalWriteCapabilities: readonly string[];
}

export interface WorkloadExecutionContext {
  readonly suiteRunId: string;
  readonly shadowRunId: string;
  readonly repetition: number;
  readonly config: ShadowExecutionConfig;
  /** Salt for pseudonymous recipient references (per suite). */
  readonly salt: string;
}

export interface WorkloadExecution {
  readonly taskId: string;
  /** The finished trajectory, rebuilt from durable state by the canonical reader (with harness call records). */
  readonly subject: EvaluationSubject;
  readonly composition: ShadowCompositionReport;
  readonly records: readonly SideEffectRecord[];
  readonly outbound: readonly ShadowOutbound[];
  readonly modelCalls: readonly ShadowModelCall[];
  readonly turns: readonly TurnTiming[];
  readonly caseInvariants: readonly InvariantOutcome[];
  readonly events: readonly EventLogEntry[];
  readonly policyProfile: { readonly name: string; readonly policyId: string; readonly version: number; readonly hash: string } | null;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface WorkloadExecutor {
  describe(): WorkloadExecutorDescription;
  execute(workload: WorkloadCase, context: WorkloadExecutionContext): Promise<WorkloadExecution>;
}

/** Safety checks whose failure stops the suite (no new executions start). */
export const STOP_CONDITION_CHECKS: readonly SafetyCheckCode[] = ['production_effects_zero', 'real_outbound_deliveries_zero', 'unapproved_writes_zero', 'writes_without_receipt_zero', 'one_receipt_per_execution', 'binding_identity_recorded'];

export interface ShadowSuiteOptions {
  readonly label: string;
  readonly config: ShadowExecutionConfig;
  readonly corpus: WorkloadCorpus;
  readonly corpusLock?: Readonly<Record<string, string>>;
  /** Subset of case ids (default: all). */
  readonly caseIds?: readonly string[];
  readonly repetitions: number;
  readonly executor: WorkloadExecutor;
  readonly definition: EvaluationDefinition;
  readonly judge: SemanticJudge | null;
  readonly judgeProfile?: ModelProfile | null;
  readonly gitSha: string;
  readonly gitDirty: boolean | null;
  readonly costGuard: CostGuard;
  readonly concurrency: number;
  readonly allowLarge?: boolean;
  readonly suiteRunId?: string;
  /** Extra check run on each serialized ShadowRun (e.g. the artifact privacy gate); a throw is a stop condition (secret leakage). */
  readonly leakCheck?: (serialized: string) => void;
  readonly clock?: () => Date;
  readonly onRun?: (run: ShadowRun) => void;
}

export interface ShadowPlan {
  readonly suiteRunId: string;
  readonly label: string;
  readonly execution: ShadowExecutionConfig & { readonly suiteMode: ShadowSuiteMode; readonly fingerprint: string };
  readonly cases: readonly { readonly id: string; readonly version: number; readonly sourceType: string; readonly title: string; readonly tags: readonly string[]; readonly inputs: number }[];
  readonly repetitions: number;
  readonly executionsPlanned: number;
  readonly concurrency: number;
  readonly costGuard: CostGuard;
  /** Upper bound of model calls the guard allows (the plan never exceeds it). */
  readonly estimatedMaxModelCalls: number;
  readonly modelProfile: (ModelProfile & { fingerprint: string }) | null;
  readonly liveModel: boolean;
  readonly bindings: ShadowRun['bindings'];
  readonly outbound: ShadowCompositionReport['outbound'];
  readonly writeBindings: readonly string[];
  readonly actualOutboundDelivery: 'disabled';
  readonly corpus: { readonly id: string; readonly version: number; readonly fingerprint: string };
}

/**
 * Startup gate + plan, without executing anything (`--plan`). Throws when the
 * suite could not run safely: no proven shadow mode, a BLOCKED binding, a
 * real model without its opt-in, a plan above the cost guard, a corpus that
 * changed without a new version.
 */
export function planShadowSuite(options: Omit<ShadowSuiteOptions, 'definition' | 'judge' | 'gitSha' | 'gitDirty'>): { plan: ShadowPlan; composition: ShadowCompositionReport; cases: WorkloadCase[] } {
  const config = assertShadowMode(options.config);
  const description = options.executor.describe();
  if (description.liveModel && !config.allowLiveModel) throw new Error('refusing to plan: the executor uses a real model provider but R4_SHADOW_ALLOW_LIVE_MODEL is not true');
  if (description.suiteMode === 'live-read-shadow' && !description.bindings.some((b) => b.kind === 'live-read')) throw new Error('refusing to plan: live-read-shadow declared but no live-read binding is composed');
  const composition = assertShadowComposition(config, description.bindings, description.outbound);
  const corpusCheck = assertWorkloadCorpus(options.corpus, options.corpusLock);
  if (corpusCheck.problems.length > 0) throw new Error(`refusing to plan: corpus problems: ${corpusCheck.problems.join('; ')}`);
  const cases = options.caseIds
    ? options.caseIds.map((id) => {
        const found = options.corpus.cases.find((c) => c.id.toLowerCase() === id.toLowerCase());
        if (!found) throw new Error(`unknown workload case ${id}; known: ${options.corpus.cases.map((c) => c.id).join(', ')}`);
        return found;
      })
    : [...options.corpus.cases];
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) throw new Error('repetitions must be a positive integer');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error('concurrency must be an integer between 1 and 8 (conservative by design)');
  assertPlanWithinGuard({ cases: cases.length, repetitions: options.repetitions, live: description.liveModel, allowLarge: options.allowLarge ?? false }, options.costGuard);
  const suiteRunId = options.suiteRunId ?? `shs_${(options.clock ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;
  const bindings = compositionEntries(composition);
  return {
    composition,
    cases,
    plan: {
      suiteRunId,
      label: options.label,
      execution: { ...config, suiteMode: description.suiteMode, fingerprint: shadowConfigFingerprint(config) },
      cases: cases.map((c) => ({ id: c.id, version: c.version, sourceType: c.sourceType, title: c.title, tags: [...c.tags], inputs: c.events.filter((e) => e.kind === 'input').length })),
      repetitions: options.repetitions,
      executionsPlanned: cases.length * options.repetitions,
      concurrency: options.concurrency,
      costGuard: options.costGuard,
      estimatedMaxModelCalls: options.costGuard.maxModelCalls,
      modelProfile: description.modelProfile ? describeModelProfile(description.modelProfile) : null,
      liveModel: description.liveModel,
      bindings,
      outbound: composition.outbound,
      writeBindings: bindings.filter((b) => Object.values(b.classifications).some((c) => c !== 'READ_ALLOWED')).map((b) => `${b.label} → ${Object.entries(b.classifications).filter(([, c]) => c !== 'READ_ALLOWED').map(([op, c]) => `${op}:${c}`).join(', ')}`),
      actualOutboundDelivery: 'disabled',
      corpus: { id: options.corpus.id, version: options.corpus.version, fingerprint: corpusCheck.fingerprint },
    },
  };
}

export const shadowSuiteRunSchema = z.strictObject({
  schemaVersion: z.literal(SHADOW_SUITE_SCHEMA_VERSION),
  suiteRunId: z.string(),
  label: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  plan: z.custom<ShadowPlan>((v) => v !== null && typeof v === 'object'),
  reproducibility: z.strictObject({ gitSha: z.string(), gitDirty: z.boolean().nullable(), evaluationDefinition: z.strictObject({ id: z.string(), version: z.int().positive(), fingerprint: z.string() }), judgeProfile: z.custom<ModelProfile & { fingerprint: string }>().nullable() }),
  counts: z.strictObject({ planned: z.int(), executed: z.int(), executionFailed: z.int(), notRunDueToBudget: z.int(), notRunDueToStopCondition: z.int() }),
  stop: z.strictObject({ stopped: z.boolean(), reason: z.string().nullable() }),
  budget: z.strictObject({ usage: z.strictObject({ modelCalls: z.int(), inputTokens: z.int(), outputTokens: z.int() }), exhausted: z.string().nullable() }),
  benchmark: benchmarkRunSchema.nullable(),
  runs: z.array(shadowRunSchema),
  aggregates: z.custom<ShadowAggregates>((v) => v !== null && typeof v === 'object'),
  observations: z.array(z.custom<ArchitectureGapCandidate>()),
});
export type ShadowSuiteRun = z.infer<typeof shadowSuiteRunSchema>;

interface Item {
  readonly workload: WorkloadCase;
  readonly repetition: number;
  readonly shadowRunId: string;
  run?: ShadowRun;
  execution?: WorkloadExecution;
}

export interface ShadowExecutionDetail {
  readonly shadowRunId: string;
  readonly records: readonly SideEffectRecord[];
  readonly outbound: readonly ShadowOutbound[];
  readonly modelCalls: readonly ShadowModelCall[];
  readonly subject: EvaluationSubject;
}

export async function runShadowSuite(options: ShadowSuiteOptions): Promise<{ suite: ShadowSuiteRun; evaluations: EvaluationRun[]; details: ShadowExecutionDetail[] }> {
  const clock = options.clock ?? (() => new Date());
  const { plan, composition, cases } = planShadowSuite(options);
  const config = assertShadowMode(options.config);
  const description = options.executor.describe();
  const startedAt = clock().toISOString();
  const salt = randomUUID();
  const meter = new CostMeter(options.costGuard);
  const modelProfile = description.modelProfile ? describeModelProfile(description.modelProfile) : null;
  const definitionRef = { id: options.definition.id, version: options.definition.version, fingerprint: definitionFingerprint(options.definition) };
  const base = (item: Item) => ({
    schemaVersion: SHADOW_RUN_SCHEMA_VERSION,
    shadowRunId: item.shadowRunId,
    suiteRunId: plan.suiteRunId,
    case: { id: item.workload.id, version: item.workload.version, fingerprint: workloadFingerprint(item.workload), sourceType: item.workload.sourceType, tags: [...item.workload.tags] },
    repetition: item.repetition,
    execution: { mode: 'shadow' as const, suiteMode: description.suiteMode, declaredBy: config.declaredBy, shadowConfigFingerprint: plan.execution.fingerprint },
    reproducibility: { gitSha: options.gitSha, gitDirty: options.gitDirty, agent: description.agent, protocolVersion: description.protocolVersion, modelProfile, corpus: plan.corpus, evaluationDefinition: definitionRef },
  });
  const notRun = (item: Item, status: 'not_run_due_to_budget' | 'not_run_due_to_stop_condition', reason: string): ShadowRun =>
    shadowRunSchema.parse({ ...base(item), status, error: reason.slice(0, 500), taskId: null, bindings: [], outbound: null, policyProfile: null, evaluationRunId: null, evaluationLatencyMs: null, sideEffects: null, safety: [], caseInvariants: [], events: [], operational: null, startedAt: null, completedAt: null });

  const items: Item[] = cases.flatMap((workload) => Array.from({ length: options.repetitions }, (_, i) => ({ workload, repetition: i + 1, shadowRunId: `${plan.suiteRunId}.${workload.id}.r${i + 1}` })));
  let stopReason: string | null = null;
  let budgetReason: string | null = null;
  let next = 0;

  const executeOne = async (item: Item): Promise<void> => {
    if (stopReason !== null) {
      item.run = notRun(item, 'not_run_due_to_stop_condition', stopReason);
      return;
    }
    const exhausted = meter.exhausted();
    if (exhausted !== null) {
      budgetReason ??= exhausted;
      item.run = notRun(item, 'not_run_due_to_budget', exhausted);
      return;
    }
    let execution: WorkloadExecution;
    try {
      execution = await options.executor.execute(item.workload, { suiteRunId: plan.suiteRunId, shadowRunId: item.shadowRunId, repetition: item.repetition, config, salt });
    } catch (error) {
      item.run = shadowRunSchema.parse({ ...base(item), status: 'execution_failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 500), taskId: null, bindings: compositionEntries(composition), outbound: composition.outbound, policyProfile: null, evaluationRunId: null, evaluationLatencyMs: null, sideEffects: null, safety: [], caseInvariants: [], events: [], operational: null, startedAt: null, completedAt: null });
      return;
    }
    meter.add(usageOf(execution.modelCalls));
    const manifest = buildSideEffectManifest({ records: execution.records, subject: execution.subject, outbound: execution.outbound });
    const safety = evaluateShadowSafety({ records: execution.records, subject: execution.subject, outbound: execution.outbound, manifest, composition: execution.composition, externalWriteCapabilities: description.externalWriteCapabilities });
    const run = shadowRunSchema.parse({
      ...base(item),
      status: 'executed',
      error: null,
      taskId: execution.taskId,
      bindings: compositionEntries(execution.composition),
      outbound: execution.composition.outbound,
      policyProfile: execution.policyProfile,
      evaluationRunId: null,
      evaluationLatencyMs: null,
      sideEffects: manifest,
      safety,
      caseInvariants: [...execution.caseInvariants],
      events: [...execution.events],
      operational: operationalMetrics({ subject: execution.subject, modelCalls: execution.modelCalls, records: execution.records, turns: execution.turns }),
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
    });
    const stopping = safety.filter((c) => !c.passed && STOP_CONDITION_CHECKS.includes(c.code));
    if (stopping.length > 0) stopReason ??= `stop condition in ${item.shadowRunId}: ${stopping.map((c) => c.code).join(', ')}`;
    try {
      options.leakCheck?.(JSON.stringify({ run, outbound: execution.outbound, records: execution.records }));
    } catch (error) {
      stopReason ??= `stop condition in ${item.shadowRunId}: secret leakage (${error instanceof Error ? error.message : String(error)})`;
    }
    item.run = run;
    item.execution = execution;
    options.onRun?.(run);
  };

  const worker = async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await executeOne(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, items.length) }, worker));

  // --- R4-G evaluation of every executed trajectory (after the suite) ---
  const evaluations: EvaluationRun[] = [];
  const results: BenchmarkResult[] = [];
  const evaluationLatency = new Map<string, number>();
  let firstStart: string | null = null;
  for (const workload of cases) {
    const attempted = items.filter((i) => i.workload === workload && (i.run?.status === 'executed' || i.run?.status === 'execution_failed'));
    if (attempted.length === 0) continue;
    const repetitions = Math.max(...attempted.map((i) => i.repetition));
    const scenario = { id: workload.id, version: `${workload.version}:${workloadFingerprint(workload).slice(0, 12)}` };
    let producedAt = 0;
    const { benchmark, evaluations: evaluated } = await runBenchmark({
      label: options.label,
      scenarioSet: { id: options.corpus.id, version: plan.corpus.fingerprint.slice(0, 16), scenarios: [scenario] },
      repetitions,
      producer: {
        mode: `shadow:${description.suiteMode}`,
        produce: (_s, repetition) => {
          const item = attempted.find((i) => i.repetition === repetition);
          if (!item?.execution) return Promise.reject(new Error(item?.run?.error ?? 'not executed'));
          producedAt = Date.now();
          return Promise.resolve({ subject: item.execution.subject });
        },
      },
      definition: options.definition,
      judge: options.judge,
      agent: description.agent,
      modelProfile: description.modelProfile,
      gitSha: options.gitSha,
      protocolVersion: description.protocolVersion,
      configuration: { suiteMode: description.suiteMode, shadowConfig: plan.execution.fingerprint, corpus: `${options.corpus.id}@${options.corpus.version}`, ...(options.gitDirty === null ? {} : { gitDirty: String(options.gitDirty) }) },
      benchmarkRunId: plan.suiteRunId,
      clock,
      onResult: (result) => {
        if (result.evaluationRunId) evaluationLatency.set(result.evaluationRunId, Math.max(0, Date.now() - producedAt));
      },
    });
    firstStart ??= benchmark.startedAt;
    results.push(...benchmark.results);
    evaluations.push(...evaluated);
  }
  for (const item of items) {
    if (item.run?.status !== 'executed') continue;
    const evaluationRunId = `${plan.suiteRunId}.${item.workload.id}.r${item.repetition}`;
    const evaluated = evaluations.some((e) => e.evaluationRunId === evaluationRunId);
    item.run = shadowRunSchema.parse({ ...item.run, evaluationRunId: evaluated ? evaluationRunId : null, evaluationLatencyMs: evaluationLatency.get(evaluationRunId) ?? null });
  }

  const benchmark: BenchmarkRun | null =
    results.length === 0
      ? null
      : benchmarkRunSchema.parse({
          schemaVersion: 'r4.benchmark_run.v1',
          benchmarkRunId: plan.suiteRunId,
          label: options.label,
          mode: `shadow:${description.suiteMode}`,
          scenarioSet: { id: options.corpus.id, version: plan.corpus.fingerprint.slice(0, 16), scenarios: [...new Map(results.map((r) => [r.scenarioId, { id: r.scenarioId, version: r.scenarioVersion }])).values()] },
          modelProfile,
          agent: description.agent,
          gitSha: options.gitSha,
          protocolVersion: description.protocolVersion,
          configuration: { suiteMode: description.suiteMode, shadowConfig: plan.execution.fingerprint, corpus: `${options.corpus.id}@${options.corpus.version}`, ...(options.gitDirty === null ? {} : { gitDirty: String(options.gitDirty) }) },
          repetitions: options.repetitions,
          evaluationDefinition: definitionRef,
          startedAt: firstStart ?? startedAt,
          completedAt: clock().toISOString(),
          results,
          aggregate: { overall: aggregate(results), byScenario: Object.fromEntries([...new Set(results.map((r) => r.scenarioId))].map((id) => [id, aggregate(results.filter((r) => r.scenarioId === id))])) },
        });

  const runs = items.map((i) => i.run!);
  const aggregates = aggregateShadowRuns({ runs, cases, results, evaluations });
  const suite = shadowSuiteRunSchema.parse({
    schemaVersion: SHADOW_SUITE_SCHEMA_VERSION,
    suiteRunId: plan.suiteRunId,
    label: options.label,
    startedAt,
    completedAt: clock().toISOString(),
    plan,
    reproducibility: { gitSha: options.gitSha, gitDirty: options.gitDirty, evaluationDefinition: definitionRef, judgeProfile: options.judgeProfile ? describeModelProfile(options.judgeProfile) : null },
    counts: {
      planned: items.length,
      executed: runs.filter((r) => r.status === 'executed').length,
      executionFailed: runs.filter((r) => r.status === 'execution_failed').length,
      notRunDueToBudget: runs.filter((r) => r.status === 'not_run_due_to_budget').length,
      notRunDueToStopCondition: runs.filter((r) => r.status === 'not_run_due_to_stop_condition').length,
    },
    stop: { stopped: stopReason !== null, reason: stopReason },
    budget: { usage: meter.usage, exhausted: budgetReason },
    benchmark,
    runs,
    aggregates,
    observations: observeGapCandidates({ runs, aggregates, evaluations }),
  });
  const details = items.flatMap((i) => (i.execution ? [{ shadowRunId: i.shadowRunId, records: i.execution.records, outbound: i.execution.outbound, modelCalls: i.execution.modelCalls, subject: i.execution.subject }] : []));
  return { suite, evaluations, details };
}

function usageOf(calls: readonly ShadowModelCall[]): CostUsage {
  return { modelCalls: calls.filter((c) => !c.injected).length, inputTokens: calls.reduce((s, c) => s + (c.inputTokens ?? 0), 0), outputTokens: calls.reduce((s, c) => s + (c.outputTokens ?? 0), 0) };
}

export type { SafetyCheck };
