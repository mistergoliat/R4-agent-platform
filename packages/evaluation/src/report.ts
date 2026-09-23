import type { AggregateBlock, BenchmarkRun } from './benchmark.js';
import type { ExperimentComparison } from './experiment.js';
import type { Distribution } from './metrics.js';
import type { EvaluationRun } from './pipeline.js';
import type { RegressionCheck } from './regression.js';

/**
 * Human-readable reports. They show counts, vectors and findings — never a
 * global score: there is no weighting that turns grounding, protocol
 * adherence and cost into one number without inventing the weights.
 */
export function evaluationReport(run: EvaluationRun, regressions: readonly RegressionCheck[] = []): string {
  const o = run.result.outcome;
  const m = run.result.metrics;
  const v = (name: string) => {
    const metric = m[name];
    if (!metric) return '—';
    if (metric.value === null) return `— (${metric.note ?? 'n/a'})`;
    return metric.numerator !== null && metric.denominator !== null ? `${metric.numerator}/${metric.denominator}` : String(metric.value);
  };
  const lines = [
    `# R4-G Evaluation Report`,
    '',
    `- Evaluation run: \`${run.evaluationRunId}\` (${run.status})`,
    `- Subject: \`${run.subject.subjectId}\` (${run.subject.source.kind}: ${run.subject.source.ref})`,
    `- Definition: ${run.definition.id}@${run.definition.version} · taxonomy ${run.taxonomy.id}@${run.taxonomy.version}`,
    `- Agent: ${run.reproducibility.agent.agentId}@${run.reproducibility.agent.version} · protocol ${run.reproducibility.protocolVersion} · git ${run.reproducibility.gitSha}${run.reproducibility.workingTreeDirty ? ' (working tree had uncommitted changes)' : ''}`,
    `- Model under test: ${profile(run.reproducibility.modelUnderTest)}`,
    `- Evaluator model: ${profile(run.reproducibility.evaluatorModel)}`,
    ...(run.reproducibility.scenario ? [`- Scenario: ${run.reproducibility.scenario.id} (version ${run.reproducibility.scenario.version})`] : []),
    '',
    '## Outcome (separate dimensions, no combined score)',
    '',
    '| Dimension | Status |',
    '|---|---|',
    `| Technical | ${o.technical.status} (${o.technical.valid ? 'valid stop' : 'broken trajectory'}; failed runs ${o.technical.failedRuns}) |`,
    `| Goal | ${o.goal.status}; root preserved: ${String(o.goal.rootPreserved)}; objective: ${o.goal.objective} |`,
    `| Business | ${o.business.status}${o.business.outcomes.length ? `: ${o.business.outcomes.map((b) => `${b.owner}.${b.code}`).join(', ')}` : ''} |`,
    `| Quality | ${o.quality.status} (semantic coverage: ${o.quality.semanticCoverage}) |`,
    `| Governance | ${o.governance.status} (${o.governance.violations}) |`,
    '',
    '## Quality vector',
    '',
    `- Protocol adherence (valid decisions / decision attempts): ${v('r4.protocol_adherence.protocolAdherence')}`,
    `- Root goal valid across runs: ${v('r4.goal_continuity.rootGoalValidAcrossRuns')} · goal transitions: ${v('r4.goal_continuity.goalTransitions')} · manage_goal (telemetry): ${v('r4.goal_continuity.manageGoalDecisions')}`,
    `- Turns: ${v('r4.efficiency.turns')} · runs: ${v('r4.efficiency.runs')} · model calls: ${v('r4.efficiency.modelCalls')} (per turn ${v('r4.efficiency.modelCallsPerTurn')})`,
    `- Tokens: input ${v('r4.efficiency.inputTokens')} · output ${v('r4.efficiency.outputTokens')} · reasoning ${v('r4.efficiency.reasoningTokens')} · context (sum) ${v('r4.efficiency.contextTokens')}`,
    `- Capability reads: ${v('r4.efficiency.capabilityReads')} · write proposals: ${v('r4.efficiency.writeProposals')} · successful writes: ${v('r4.efficiency.successfulWrites')}`,
    `- Latency: median model call ${v('r4.efficiency.medianModelCallLatencyMs')} ms · median run ${v('r4.efficiency.medianRunDurationMs')} ms`,
    ...Object.keys(m)
      .filter((k) => /grounding|claims/.test(k))
      .map((k) => `- ${k}: ${v(k)}`),
    '',
    `## Findings (${run.result.findings.length})`,
    '',
    ...(run.result.findings.length === 0
      ? ['None.']
      : ['| Category | Code | Severity | Source | Subject | Description |', '|---|---|---|---|---|---|', ...run.result.findings.map((f) => `| ${f.category} | ${f.code} | ${f.severity} | ${f.source}${f.confidence ? ` (${f.confidence})` : ''} | ${f.subjectRef.kind}:${short(f.subjectRef.id)} | ${escape(f.description)} |`)]),
    '',
    '## Evaluators',
    '',
    '| Evaluator | Kind | Status | Findings | Note |',
    '|---|---|---|---|---|',
    ...run.result.evaluatorResults.map((r) => `| ${r.evaluator.id}@${r.evaluator.version}${r.rubric ? ` (rubric ${r.rubric.id}@${r.rubric.version})` : ''} | ${r.kind} | ${r.status} | ${r.findings} | ${r.reason ?? ''} |`),
  ];
  if (regressions.length > 0) {
    lines.push('', '## Regression cases', '', '| Case | Result | Expectations |', '|---|---|---|', ...regressions.map((r) => `| ${r.caseId}@${r.version} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.expectations.map((e) => `${e.expectation.kind}:${'code' in e.expectation ? e.expectation.code : 'path' in e.expectation ? e.expectation.path : e.expectation.name}=${e.passed ? 'ok' : `✗ (${JSON.stringify(e.actual)})`}`).join('; ')} |`));
  }
  return `${lines.join('\n')}\n`;
}

export function benchmarkReport(b: BenchmarkRun): string {
  const lines = [
    '# R4-G Benchmark Report',
    '',
    `- Benchmark: \`${b.benchmarkRunId}\` — ${b.label} (mode ${b.mode})`,
    `- Scenario set: ${b.scenarioSet.id}@${b.scenarioSet.version} (${b.scenarioSet.scenarios.map((s) => s.id).join(', ')})`,
    `- Repetitions per scenario: ${b.repetitions} · results kept: ${b.results.length}`,
    `- Agent: ${b.agent.agentId}@${b.agent.version} · protocol ${b.protocolVersion} · git ${b.gitSha}`,
    `- Model: ${profile(b.modelProfile)}`,
    `- Evaluation definition: ${b.evaluationDefinition.id}@${b.evaluationDefinition.version} (${b.evaluationDefinition.fingerprint.slice(0, 12)})`,
    `- Configuration: ${Object.entries(b.configuration).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`,
    '',
    'Counts, not confidence intervals: with small N a single failure is shown as what it is.',
    '',
    '## Overall',
    '',
    ...block(b.aggregate.overall),
    '',
    '## By scenario',
    '',
    '| Scenario | Technical | Protocol adherence | Root goal | Findings (code×n) | Median input tokens | Median model calls |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(b.aggregate.byScenario).map(([id, a]) => `| ${id} | ${a.technicalCompletion.numerator}/${a.technicalCompletion.denominator} | ${a.protocolAdherence.numerator}/${a.protocolAdherence.denominator} | ${a.rootGoalPreserved.numerator}/${a.rootGoalPreserved.denominator} | ${Object.entries(a.findingsByCode).map(([c, n]) => `${c}×${n.occurrences}`).join(', ') || '—'} | ${a.inputTokens.median ?? '—'} | ${a.modelCalls.median ?? '—'} |`),
    '',
    '## Individual repetitions',
    '',
    '| Scenario | Rep | Status | Technical | Quality | Governance | Findings |',
    '|---|---|---|---|---|---|---|',
    ...b.results.map((r) => `| ${r.scenarioId} | ${r.repetition} | ${r.status}${r.error ? ` (${escape(r.error.slice(0, 80))})` : ''} | ${r.outcome?.technicalStatus ?? '—'} | ${r.outcome?.qualityStatus ?? '—'} | ${r.outcome?.governanceStatus ?? '—'} | ${Object.entries(r.findingCodes).map(([c, n]) => `${c}×${n}`).join(', ') || '—'} |`),
  ];
  return `${lines.join('\n')}\n`;
}

export function experimentReport(c: ExperimentComparison): string {
  const lines = [
    `# R4-G Experiment — ${c.experiment.title}`,
    '',
    `- Experiment: \`${c.experiment.experimentId}\` · declared dimension: **${c.experiment.dimensionChanged}**${c.experiment.configurationKey ? ` (${c.experiment.configurationKey})` : ''}`,
    `- Hypothesis: ${c.experiment.hypothesis || '—'}`,
    `- Baseline: ${c.baseline.label} (\`${c.baseline.benchmarkRunId}\`)`,
    `- Candidate: ${c.candidate.label} (\`${c.candidate.benchmarkRunId}\`)`,
    '',
    c.note,
    '',
    '## Controlled axes',
    '',
    '| Axis | Baseline | Candidate | Differs | Declared |',
    '|---|---|---|---|---|',
    ...c.axes.map((a) => `| ${a.axis} | ${short(a.baseline, 24)} | ${short(a.candidate, 24)} | ${a.differs ? 'yes' : 'no'} | ${a.declared ? 'yes' : ''} |`),
    '',
    ...(c.warnings.length ? ['**Warnings**', '', ...c.warnings.map((w) => `- ${w}`), ''] : ['No uncontrolled differences.', '']),
    '## Vector',
    '',
    '| Dimension | Baseline | Candidate | Δ |',
    '|---|---|---|---|',
    `| Technical completion | ${c.technicalCompletion.baseline} | ${c.technicalCompletion.candidate} | ${fmt(c.technicalCompletion.delta)} |`,
    `| Protocol adherence | ${c.protocolAdherence.baseline} | ${c.protocolAdherence.candidate} | ${fmt(c.protocolAdherence.delta)} |`,
    `| Root goal preserved | ${c.rootGoalPreserved.baseline} | ${c.rootGoalPreserved.candidate} | ${fmt(c.rootGoalPreserved.delta)} |`,
    ...Object.entries(c.metrics).map(([k, d]) => `| ${k} | ${fmt(d.baseline)} | ${fmt(d.candidate)} | ${fmt(d.delta)} |`),
    '',
    '## Findings',
    '',
    '| Code | Baseline | Candidate | Δ | Runs affected (b → c) |',
    '|---|---|---|---|---|',
    ...c.findings.map((f) => `| ${f.code} | ${f.baseline} | ${f.candidate} | ${f.delta > 0 ? '+' : ''}${f.delta} | ${f.runsAffectedBaseline} → ${f.runsAffectedCandidate} |`),
  ];
  return `${lines.join('\n')}\n`;
}

function block(a: AggregateBlock): string[] {
  return [
    `- Results: ${a.results} (evaluated ${a.evaluated}, production failures ${a.productionFailures})`,
    `- Technical completion (valid stops): ${a.technicalCompletion.numerator}/${a.technicalCompletion.denominator} · tasks completed: ${a.tasksCompleted}`,
    `- Protocol adherence (pooled valid decisions / attempts): ${a.protocolAdherence.numerator}/${a.protocolAdherence.denominator}`,
    `- Root goal preserved: ${a.rootGoalPreserved.numerator}/${a.rootGoalPreserved.denominator} · governance violations: ${a.governanceViolations}`,
    `- Findings by category: ${Object.entries(a.findingsByCategory).map(([k, n]) => `${k} ${n.occurrences} (in ${n.runsAffected} runs)`).join(', ') || 'none'}`,
    `- Findings by code: ${Object.entries(a.findingsByCode).map(([k, n]) => `${k} ${n.occurrences}`).join(', ') || 'none'}`,
    `- Input tokens: ${dist(a.inputTokens)}`,
    `- Output tokens: ${dist(a.outputTokens)}`,
    `- Model calls: ${dist(a.modelCalls)}`,
    `- Median model-call latency per run (ms): ${dist(a.modelCallLatencyMedianMs)}`,
    `- Semantic evaluations inconclusive: ${a.semanticInconclusive}`,
  ];
}

function dist(d: Distribution): string {
  if (d.n === 0) return `— (no values${d.missing ? `, ${d.missing} missing` : ''})`;
  return `n=${d.n}${d.missing ? ` (+${d.missing} missing)` : ''} min ${d.min} · median ${d.median} · mean ${d.mean} · max ${d.max}${d.p95 !== null ? ` · p95 ${d.p95}` : ''} · raw [${d.values.join(', ')}]`;
}

function profile(p: { provider: string; model: string; fingerprint: string; extras: Record<string, unknown>; maxOutputTokens: number | null } | null): string {
  if (!p) return '—';
  return `${p.provider}/${p.model} max_out=${p.maxOutputTokens ?? '-'} extras=${JSON.stringify(p.extras)} (fingerprint ${p.fingerprint.slice(0, 12)})`;
}

function fmt(n: number | null): string {
  return n === null ? '—' : String(n);
}

function short(s: string, n = 8): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function escape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
