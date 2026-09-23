import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JsonValue } from '@r4/contracts';
import { assertDescriptor, freezeSubject, type EvaluationFragment, type Evaluator } from './evaluator.js';
import { finalizeFinding, findingSchema, mergeFindings, type Finding } from './finding.js';
import { metricValueSchema, type QualityVector } from './metrics.js';
import { describeModelProfile, modelProfileSchema, type ModelProfile } from './model-profile.js';
import { composeOutcome, taskOutcomeSchema, type DomainOutcome, type TaskOutcome } from './outcome.js';
import { projectSemanticView, type PrivacyPolicy } from './privacy.js';
import { rubricRef } from './rubric.js';
import type { SemanticJudge } from './semantic.js';
import type { EvaluationSubject } from './subject.js';
import type { FindingTaxonomy } from './taxonomy.js';
import { evaluatorKey, evaluatorRefSchema, fingerprint, rubricRefSchema, sha256Schema, type EvaluatorRef } from './versioning.js';

/**
 * EvaluationDefinition: which evaluators, in which taxonomy, under which
 * privacy policy. Versioned and fingerprinted — two runs with the same
 * fingerprint judged with exactly the same evaluator and rubric versions.
 */
export interface EvaluationDefinition {
  readonly id: string;
  readonly version: number;
  readonly taxonomy: FindingTaxonomy;
  readonly evaluators: readonly Evaluator[];
  readonly privacy: PrivacyPolicy;
  /** Deadline of each judge call. */
  readonly semanticTimeoutMs: number;
}

export function definitionFingerprint(definition: EvaluationDefinition): string {
  return fingerprint({
    id: definition.id,
    version: definition.version,
    taxonomy: definition.taxonomy.ref(),
    evaluators: definition.evaluators.map((e) => ({ ...e.descriptor.ref, kind: e.descriptor.kind, rubric: e.descriptor.rubric ? rubricRef(e.descriptor.rubric) : null })),
    redactKeys: [...definition.privacy.redactKeys].sort(),
    excludeCapabilities: [...(definition.privacy.excludeCapabilities ?? [])].sort(),
  });
}

/** Validates a definition once: identities, rubrics, and that every emitted code exists in its taxonomy. */
export function assertDefinition(definition: EvaluationDefinition): void {
  const seen = new Set<string>();
  for (const e of definition.evaluators) {
    assertDescriptor(e.descriptor);
    const key = evaluatorKey(e.descriptor.ref);
    if (seen.has(key)) throw new Error(`evaluator ${key} appears twice in ${definition.id}`);
    seen.add(key);
    for (const code of e.descriptor.emits) definition.taxonomy.require(code);
  }
}

const profileWithFingerprint = modelProfileSchema.extend({ fingerprint: sha256Schema });

export const EVALUATION_RUN_SCHEMA_VERSION = 'r4.evaluation_run.v1';

export const evaluatorResultSchema = z.strictObject({
  evaluator: evaluatorRefSchema,
  kind: z.enum(['deterministic', 'semantic']),
  rubric: rubricRefSchema.nullable(),
  status: z.enum(['completed', 'inconclusive', 'skipped', 'error']),
  reason: z.string().max(300).nullable(),
  findings: z.int().nonnegative(),
  metrics: z.record(z.string(), metricValueSchema),
});
export type EvaluatorResult = z.infer<typeof evaluatorResultSchema>;

export const evaluationRunSchema = z.strictObject({
  schemaVersion: z.literal(EVALUATION_RUN_SCHEMA_VERSION),
  evaluationRunId: z.string().min(1).max(128),
  definition: z.strictObject({ id: z.string(), version: z.int().positive(), fingerprint: sha256Schema }),
  taxonomy: z.strictObject({ id: z.string(), version: z.int().positive(), codes: z.int().positive() }),
  subject: z.strictObject({ subjectId: z.string(), taskId: z.string(), source: z.strictObject({ kind: z.enum(['durable', 'fixture']), ref: z.string() }), hash: sha256Schema }),
  reproducibility: z.strictObject({
    gitSha: z.string().regex(/^([0-9a-f]{7,40}|unknown)$/),
    /** Uncommitted changes at evaluation time (null: unknown). A dirty tree means the SHA alone does not identify the code. */
    workingTreeDirty: z.boolean().nullable(),
    agent: z.strictObject({ agentId: z.string(), version: z.int().positive(), contentHash: z.string().nullable() }),
    protocolVersion: z.string().min(1),
    modelUnderTest: profileWithFingerprint.nullable(),
    evaluatorModel: profileWithFingerprint.nullable(),
    scenario: z.strictObject({ id: z.string(), version: z.string() }).nullable(),
    evaluators: z.array(evaluatorRefSchema),
    rubrics: z.array(rubricRefSchema),
  }),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }),
  status: z.enum(['completed', 'completed_with_inconclusive', 'completed_with_errors']),
  result: z.strictObject({
    outcome: taskOutcomeSchema,
    metrics: z.record(z.string(), metricValueSchema),
    findings: z.array(findingSchema),
    evaluatorResults: z.array(evaluatorResultSchema),
    suppressed: z.array(z.strictObject({ findingId: z.string(), code: z.string(), evaluator: evaluatorRefSchema, reason: z.enum(['duplicate', 'deterministic_authority']), keptFindingId: z.string().nullable() })),
    data: z.record(z.string(), z.json()),
  }),
});
export type EvaluationRun = z.infer<typeof evaluationRunSchema>;

export interface RunEvaluationOptions {
  readonly judge?: SemanticJudge | null;
  readonly reproducibility: {
    readonly gitSha: string;
    readonly workingTreeDirty?: boolean | null;
    readonly protocolVersion: string;
    readonly modelUnderTest: ModelProfile | null;
    readonly scenario?: { readonly id: string; readonly version: string } | null;
  };
  readonly evaluationRunId?: string;
  readonly clock?: () => Date;
  readonly signal?: AbortSignal;
}

/**
 * Runs one evaluation, post-hoc: deterministic evaluators first (in order),
 * then semantic ones on the privacy projection, then merge. An evaluator bug
 * is recorded as `error` for that evaluator; a judge failure as
 * `inconclusive`. Neither ever becomes a finding against the agent.
 */
export async function runEvaluation(subject: EvaluationSubject, definition: EvaluationDefinition, options: RunEvaluationOptions): Promise<EvaluationRun> {
  assertDefinition(definition);
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const frozen = freezeSubject(subject);
  const judge = options.judge ?? null;
  const signal = options.signal ?? new AbortController().signal;
  const results: EvaluatorResult[] = [];
  const findings: Finding[] = [];
  const metrics: QualityVector = {};
  const data: Record<string, JsonValue> = {};
  let objective: TaskOutcome['goal']['objective'] = 'not_evaluated';
  const business: DomainOutcome[] = [];
  let businessEvaluated = false;

  const authoritative = new Set<string>();
  const ordered = [...definition.evaluators.filter((e) => e.descriptor.kind === 'deterministic'), ...definition.evaluators.filter((e) => e.descriptor.kind === 'semantic')];
  for (const evaluator of ordered) {
    const d = evaluator.descriptor;
    const rubric = d.rubric ? rubricRef(d.rubric) : null;
    if (d.kind === 'semantic' && judge === null) {
      results.push({ evaluator: d.ref, kind: d.kind, rubric, status: 'skipped', reason: 'no judge configured', findings: 0, metrics: {} });
      continue;
    }
    const established = findings.filter((f) => f.source === 'deterministic');
    const view = projectSemanticView(subject, definition.privacy, established);
    let fragment: EvaluationFragment;
    let produced: Finding[];
    try {
      fragment = await evaluator.evaluate(frozen, { priorFindings: established, judge, view, timeoutMs: definition.semanticTimeoutMs, signal });
      produced = fragment.findings.map((draft) => {
        if (!d.emits.includes(draft.code)) throw new Error(`evaluator ${evaluatorKey(d.ref)} emitted undeclared code ${draft.code}`);
        return finalizeFinding(draft, { taxonomy: definition.taxonomy, evaluator: d.ref, source: d.kind, rubric });
      });
    } catch (error) {
      // An evaluator defect (or an attempt to modify the frozen subject) is the evaluator's failure, never the agent's.
      results.push({ evaluator: d.ref, kind: d.kind, rubric, status: 'error', reason: (error instanceof Error ? error.message : String(error)).slice(0, 300), findings: 0, metrics: {} });
      continue;
    }
    findings.push(...produced);
    if (d.kind === 'deterministic') for (const code of d.authoritativeFor ?? []) authoritative.add(code);
    for (const [name, value] of Object.entries(fragment.metrics ?? {})) metrics[`${d.ref.id}.${name}`] = value;
    if (fragment.data) data[evaluatorKey(d.ref)] = fragment.data;
    if (fragment.outcome?.objective) objective = mergeObjective(objective, fragment.outcome.objective);
    if (fragment.outcome?.business) {
      businessEvaluated = true;
      business.push(...fragment.outcome.business);
    }
    results.push({ evaluator: d.ref, kind: d.kind, rubric, status: fragment.status ?? 'completed', reason: fragment.reason ?? null, findings: produced.length, metrics: fragment.metrics ?? {} });
  }

  const merged = mergeFindings(findings, authoritative);
  const semantic = results.filter((r) => r.kind === 'semantic' && r.status !== 'skipped');
  const outcome = composeOutcome({
    subject,
    findings: merged.findings,
    semanticEvaluators: { total: semantic.length, inconclusive: semantic.filter((r) => r.status !== 'completed').length },
    objective,
    business: { evaluated: businessEvaluated, outcomes: business },
  });
  const status = results.some((r) => r.status === 'error') ? 'completed_with_errors' : results.some((r) => r.status === 'inconclusive') ? 'completed_with_inconclusive' : 'completed';
  return evaluationRunSchema.parse({
    schemaVersion: EVALUATION_RUN_SCHEMA_VERSION,
    evaluationRunId: options.evaluationRunId ?? `evr_${randomUUID()}`,
    definition: { id: definition.id, version: definition.version, fingerprint: definitionFingerprint(definition) },
    taxonomy: definition.taxonomy.ref(),
    subject: { subjectId: subject.subjectId, taskId: subject.task.taskId, source: subject.source, hash: fingerprint(subject) },
    reproducibility: {
      gitSha: options.reproducibility.gitSha,
      workingTreeDirty: options.reproducibility.workingTreeDirty ?? null,
      agent: subject.agent,
      protocolVersion: options.reproducibility.protocolVersion,
      modelUnderTest: options.reproducibility.modelUnderTest ? describeModelProfile(options.reproducibility.modelUnderTest) : null,
      evaluatorModel: judge && semantic.length > 0 ? describeModelProfile(judge.profile) : null,
      scenario: options.reproducibility.scenario ?? null,
      evaluators: definition.evaluators.map((e) => e.descriptor.ref),
      rubrics: definition.evaluators.flatMap((e) => (e.descriptor.rubric ? [rubricRef(e.descriptor.rubric)] : [])),
    },
    startedAt,
    completedAt: clock().toISOString(),
    status,
    result: {
      outcome,
      metrics,
      findings: merged.findings,
      evaluatorResults: results,
      suppressed: merged.suppressed.map((s) => ({ findingId: s.finding.findingId, code: s.finding.code, evaluator: s.finding.evaluator, reason: s.reason, keptFindingId: s.keptFindingId })),
      data,
    },
  });
}

/** Several objective verdicts: any drift wins, then any inconclusive, then preserved. */
function mergeObjective(a: TaskOutcome['goal']['objective'], b: TaskOutcome['goal']['objective']): TaskOutcome['goal']['objective'] {
  const rank = { not_evaluated: 0, preserved: 1, inconclusive: 2, drifted: 3 } as const;
  return rank[b] > rank[a] ? b : a;
}

export type { EvaluatorRef };
