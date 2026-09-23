import type { BenchmarkRun } from './benchmark.js';
import type { ExperimentComparison } from './experiment.js';
import type { EvaluationRun } from './pipeline.js';
import { assertArtifactSafe } from './privacy.js';
import type { RegressionCheck } from './regression.js';
import { benchmarkReport, evaluationReport, experimentReport } from './report.js';
import type { EvaluationSubject } from './subject.js';
import { canonicalJson } from './versioning.js';

/**
 * Artifact layout (R4-G). Evaluation outputs are immutable files with a
 * manifest — not database rows: they are derived, reproducible from durable
 * trajectories plus versioned definitions, and nothing operational reads
 * them. Serialization is stable (sorted keys), so equal results are equal
 * bytes. Every file passes the privacy gate before it is returned.
 *
 *   evaluations/<evaluationRunId>/  manifest.json summary.json findings.jsonl metrics.json data.json report.md [subject.json]
 *   benchmarks/<benchmarkRunId>/    manifest.json scenario-results.jsonl aggregate.json report.md
 *   experiments/<experimentId>/     comparison.json report.md
 */
export type ArtifactFiles = Readonly<Record<string, string>>;

export function stableJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
}

function jsonl(values: readonly unknown[]): string {
  return values.map((v) => canonicalJson(v)).join('\n') + (values.length > 0 ? '\n' : '');
}

function guarded(files: Record<string, string>, secrets: readonly string[]): ArtifactFiles {
  for (const [name, text] of Object.entries(files)) {
    try {
      assertArtifactSafe(text, secrets);
    } catch (error) {
      throw new Error(`refusing artifact ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return files;
}

export function evaluationArtifacts(run: EvaluationRun, options: { subject?: EvaluationSubject | null; regressions?: readonly RegressionCheck[]; secrets?: readonly string[] } = {}): ArtifactFiles {
  const files: Record<string, string> = {};
  const counts = (key: 'category' | 'code' | 'severity') => {
    const out: Record<string, number> = {};
    for (const f of run.result.findings) out[f[key]] = (out[f[key]] ?? 0) + 1;
    return out;
  };
  files['summary.json'] = stableJson({
    evaluationRunId: run.evaluationRunId,
    status: run.status,
    outcome: run.result.outcome,
    findings: { total: run.result.findings.length, byCategory: counts('category'), byCode: counts('code'), bySeverity: counts('severity') },
    evaluators: run.result.evaluatorResults.map((r) => ({ evaluator: `${r.evaluator.id}@${r.evaluator.version}`, kind: r.kind, status: r.status, reason: r.reason, findings: r.findings })),
    suppressed: run.result.suppressed,
    ...(options.regressions ? { regressions: options.regressions } : {}),
  });
  files['findings.jsonl'] = jsonl(run.result.findings);
  files['metrics.json'] = stableJson(run.result.metrics);
  files['data.json'] = stableJson(run.result.data);
  files['report.md'] = evaluationReport(run, options.regressions ?? []);
  // The immutable evaluation snapshot: a copy made for reproducibility, never the source of truth.
  if (options.subject) files['subject.json'] = stableJson(options.subject);
  files['manifest.json'] = stableJson({
    schemaVersion: 'r4.evaluation_artifacts.v1',
    evaluationRunId: run.evaluationRunId,
    runSchemaVersion: run.schemaVersion,
    definition: run.definition,
    taxonomy: run.taxonomy,
    subject: run.subject,
    reproducibility: run.reproducibility,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    status: run.status,
    files: Object.keys(files).sort(),
  });
  return guarded(files, options.secrets ?? []);
}

export function benchmarkArtifacts(benchmark: BenchmarkRun, options: { secrets?: readonly string[] } = {}): ArtifactFiles {
  const { results, aggregate, ...meta } = benchmark;
  const files: Record<string, string> = {
    'scenario-results.jsonl': jsonl(results),
    'aggregate.json': stableJson(aggregate),
    'report.md': benchmarkReport(benchmark),
  };
  files['manifest.json'] = stableJson({ ...meta, artifactsSchemaVersion: 'r4.benchmark_artifacts.v1', resultCount: results.length, files: [...Object.keys(files), 'manifest.json'].sort() });
  return guarded(files, options.secrets ?? []);
}

export function experimentArtifacts(comparison: ExperimentComparison, options: { secrets?: readonly string[] } = {}): ArtifactFiles {
  return guarded({ 'comparison.json': stableJson(comparison), 'report.md': experimentReport(comparison) }, options.secrets ?? []);
}
