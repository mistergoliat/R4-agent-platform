import { assertArtifactSafe, canonicalJson, stableJson, type ArtifactFiles } from '@r4/evaluation';
import type { ArchitectureGapCandidate } from './gaps.js';
import { shadowSuiteReport } from './report.js';
import { personalDataFound } from './sanitize.js';
import type { ShadowExecutionDetail, ShadowSuiteRun } from './suite.js';

/**
 * Artifacts of one shadow suite (R4-H), written under
 * `artifacts/shadow/<suiteRunId>/` (git-ignored) next to R4-G's benchmark and
 * evaluation artifacts of the same runs:
 *
 *   manifest.json                       reproducibility, plan, bindings, counts, files
 *   plan.json                           the plan as shown by --plan
 *   workload-results.jsonl              one ShadowRun per execution (incl. not run)
 *   side-effects.jsonl                  every external call (metadata only) + the manifest per run
 *   outbound.jsonl                      what would have been delivered (redacted, never delivered)
 *   model-calls.jsonl                   per-call metadata (never output or reasoning text)
 *   evaluation-summary.json             R4-G aggregate + semantic coverage + per-run outcomes
 *   aggregates.json                     every H dimension
 *   architecture-gap-candidates.jsonl   observed + reviewed entries
 *   report.md
 *
 * Every file passes R4-G's privacy gate (secrets, credential headers,
 * reasoning fields) and, for the files that carry text derived from a
 * conversation, a personal-data gate. A failing gate refuses the artifact.
 */
const jsonl = (values: readonly unknown[]) => values.map((v) => canonicalJson(v)).join('\n') + (values.length > 0 ? '\n' : '');

export function shadowSuiteArtifacts(suite: ShadowSuiteRun, details: readonly ShadowExecutionDetail[], options: { reviewedGaps?: readonly ArchitectureGapCandidate[]; secrets?: readonly string[] } = {}): ArtifactFiles {
  const reviewed = options.reviewedGaps ?? [];
  const files: Record<string, string> = {
    'plan.json': stableJson(suite.plan),
    'workload-results.jsonl': jsonl(suite.runs),
    'side-effects.jsonl': jsonl(details.flatMap((d) => [...d.records.map((r) => ({ shadowRunId: d.shadowRunId, type: 'call', ...r })), { shadowRunId: d.shadowRunId, type: 'manifest', ...suite.runs.find((r) => r.shadowRunId === d.shadowRunId)?.sideEffects }])),
    'outbound.jsonl': jsonl(details.flatMap((d) => d.outbound.map((o) => ({ shadowRunId: d.shadowRunId, ...o })))),
    'model-calls.jsonl': jsonl(details.flatMap((d) => d.modelCalls.map((c) => ({ shadowRunId: d.shadowRunId, ...c })))),
    'evaluation-summary.json': stableJson({
      benchmarkRunId: suite.benchmark?.benchmarkRunId ?? null,
      evaluationDefinition: suite.reproducibility.evaluationDefinition,
      judgeProfile: suite.reproducibility.judgeProfile,
      semanticCoverage: suite.aggregates.semantic,
      aggregate: suite.benchmark?.aggregate.overall ?? null,
      byCase: suite.benchmark?.aggregate.byScenario ?? {},
      runs: (suite.benchmark?.results ?? []).map((r) => ({ evaluationRunId: r.evaluationRunId, caseId: r.scenarioId, repetition: r.repetition, status: r.status, outcome: r.outcome, findingCodes: r.findingCodes, evaluatorStatuses: r.evaluatorStatuses })),
    }),
    'aggregates.json': stableJson(suite.aggregates),
    'architecture-gap-candidates.jsonl': jsonl([...suite.observations, ...reviewed]),
    'report.md': shadowSuiteReport(suite, reviewed),
  };
  const { runs: _runs, benchmark: _benchmark, aggregates: _aggregates, observations: _observations, plan, ...meta } = suite;
  files['manifest.json'] = stableJson({
    ...meta,
    artifactsSchemaVersion: 'r4.shadow_artifacts.v1',
    execution: plan.execution,
    modelProfile: plan.modelProfile,
    bindings: plan.bindings,
    outbound: plan.outbound,
    corpus: plan.corpus,
    repetitions: plan.repetitions,
    cases: plan.cases.map((c) => `${c.id}@${c.version}`),
    benchmarkRunId: suite.benchmark?.benchmarkRunId ?? null,
    evaluationRunIds: suite.runs.flatMap((r) => (r.evaluationRunId ? [r.evaluationRunId] : [])),
    files: [...Object.keys(files), 'manifest.json'].sort(),
  });
  for (const [name, text] of Object.entries(files)) {
    try {
      assertArtifactSafe(text, options.secrets ?? []);
    } catch (error) {
      throw new Error(`refusing shadow artifact ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (name === 'outbound.jsonl' || name === 'side-effects.jsonl' || name === 'model-calls.jsonl') {
      const found = personalDataFound(text);
      if (found.length > 0) throw new Error(`refusing shadow artifact ${name}: personal data (${found.join(', ')}) survived redaction`);
    }
  }
  return files;
}
