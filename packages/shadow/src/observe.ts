import type { EvaluationRun } from '@r4/evaluation';
import type { ShadowAggregates } from './aggregate.js';
import { parseGapCandidate, type ArchitectureGapCandidate, type GAP_CLASSIFICATIONS, type GAP_LAYERS } from './gaps.js';
import type { ShadowRun } from './run.js';

/**
 * Deterministic observations for the gap register. Conservative by
 * construction: they classify what was seen (a recurring finding, provider
 * failures, a safety violation, domains that ran on fixtures) and cite the
 * evaluation runs that show it. They never claim an architecture gap — that
 * needs a person reading the evidence (`origin: reviewed`).
 */
const CATEGORY_CLASS: Record<string, { classification: (typeof GAP_CLASSIFICATIONS)[number]; layer: (typeof GAP_LAYERS)[number] }> = {
  PLATFORM: { classification: 'bug', layer: 'Runtime' },
  PROVIDER: { classification: 'operational_gap', layer: 'Provider' },
  MODEL_PROTOCOL: { classification: 'quality_issue', layer: 'Provider' },
  CONTEXT: { classification: 'quality_issue', layer: 'Context' },
  CAPABILITY: { classification: 'quality_issue', layer: 'Agent' },
  DOMAIN: { classification: 'missing_integration', layer: 'Domain' },
  GOAL: { classification: 'quality_issue', layer: 'Goal' },
  STATE: { classification: 'bug', layer: 'Runtime' },
  GOVERNANCE: { classification: 'bug', layer: 'Governance' },
  BEHAVIOR_QUALITY: { classification: 'quality_issue', layer: 'Agent' },
};

export function observeGapCandidates(input: { runs: readonly ShadowRun[]; aggregates: ShadowAggregates; evaluations: readonly EvaluationRun[] }): ArchitectureGapCandidate[] {
  const out: ArchitectureGapCandidate[] = [];
  const executed = input.runs.filter((r) => r.status === 'executed');
  const total = Math.max(1, executed.length);
  const byCode = new Map<string, { category: string; runs: Set<string>; cases: Set<string>; evidence: string[] }>();
  for (const e of input.evaluations) {
    const caseId = e.reproducibility.scenario?.id ?? e.subject.subjectId;
    for (const f of e.result.findings) {
      const entry = byCode.get(f.code) ?? { category: f.category, runs: new Set<string>(), cases: new Set<string>(), evidence: [] };
      entry.cases.add(caseId);
      if (!entry.runs.has(e.evaluationRunId) && entry.evidence.length < 20) entry.evidence.push(`evaluations/${e.evaluationRunId}/findings.jsonl`);
      entry.runs.add(e.evaluationRunId);
      byCode.set(f.code, entry);
    }
  }
  for (const [code, entry] of [...byCode.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (entry.runs.size < 2) continue;
    const category = entry.category;
    const mapped = CATEGORY_CLASS[category] ?? CATEGORY_CLASS.BEHAVIOR_QUALITY!;
    out.push(
      parseGapCandidate({
        id: `OBS-H-${code.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`.slice(0, 55),
        origin: 'observed',
        classification: mapped.classification,
        observation: `finding ${code} (${category}) recurred in ${entry.runs.size} executions across ${entry.cases.size} workload(s)`,
        frequency: { affected: entry.runs.size, total, unit: 'executions' },
        affectedWorkloads: [...entry.cases].sort(),
        suspectedLayer: mapped.layer,
        evidenceRefs: entry.evidence.length > 0 ? entry.evidence : ['benchmark/scenario-results.jsonl'],
        whyCurrentArchitectureIsInsufficient: null,
        workaround: null,
        productionImpact: category === 'GOVERNANCE' || category === 'STATE' ? 'correctness of governed effects; review before R4-I' : 'agent quality / autonomy limitation; not by itself a production safety blocker',
        modelSpecific: null,
        scope: 'unknown',
        blocksNextPhase: category === 'GOVERNANCE' || category === 'STATE' || category === 'PLATFORM',
      }),
    );
  }
  const providerErrors = Object.entries(input.aggregates.reliability.providerErrorsByKind);
  if (providerErrors.length > 0) {
    const affected = executed.filter((r) => Object.keys(r.operational?.modelCalls.errorsByKind ?? {}).some((k) => !k.startsWith('injected:')));
    out.push(
      parseGapCandidate({
        id: 'OBS-H-PROVIDER-FAILURES',
        origin: 'observed',
        classification: 'operational_gap',
        observation: `provider failures without injection: ${providerErrors.map(([k, v]) => `${k}×${v}`).join(', ')} over ${input.aggregates.reliability.modelCalls} model calls`,
        frequency: { affected: affected.length, total, unit: 'executions' },
        affectedWorkloads: [...new Set(affected.map((r) => r.case.id))].sort(),
        suspectedLayer: 'Provider',
        evidenceRefs: affected.slice(0, 20).map((r) => `workload-results.jsonl#${r.shadowRunId}`).concat(affected.length === 0 ? ['aggregates.reliability'] : []),
        whyCurrentArchitectureIsInsufficient: null,
        workaround: 'none in H (ADR-008: no automatic retry)',
        productionImpact: 'turns that end in a failed run until a retry/repair policy exists',
        modelSpecific: null,
        scope: 'generic',
        blocksNextPhase: false,
      }),
    );
  }
  for (const [code, violations] of Object.entries(input.aggregates.safety.failedChecks)) {
    if (code === 'no_blocked_calls') continue;
    const affected = executed.filter((r) => r.safety.some((c) => c.code === code && !c.passed));
    out.push(
      parseGapCandidate({
        id: `OBS-H-SAFETY-${code.toUpperCase().replace(/_/g, '-')}`.slice(0, 55),
        origin: 'observed',
        classification: 'bug',
        observation: `shadow safety check ${code} failed (${violations} violation(s))`,
        frequency: { affected: affected.length, total, unit: 'executions' },
        affectedWorkloads: [...new Set(affected.map((r) => r.case.id))].sort(),
        suspectedLayer: code === 'no_unresolved_uncertain_effect' ? 'Runtime' : 'Governance',
        evidenceRefs: affected.slice(0, 20).map((r) => `side-effects.jsonl#${r.shadowRunId}`).concat(affected.length === 0 ? ['aggregates.safety'] : []),
        whyCurrentArchitectureIsInsufficient: null,
        workaround: null,
        productionImpact: 'production safety blocker until explained and fixed',
        modelSpecific: false,
        scope: 'generic',
        blocksNextPhase: true,
      }),
    );
  }
  const fixtureDomains = [...new Set(executed.flatMap((r) => r.bindings.filter((b) => b.kind === 'fixture' || b.kind === 'shadow').map((b) => `${b.domain}=${b.kind}`)))].sort();
  if (fixtureDomains.length > 0 && executed.length > 0) {
    out.push(
      parseGapCandidate({
        id: 'OBS-H-LIVE-READ-NOT-EXERCISED',
        origin: 'observed',
        classification: 'missing_integration',
        observation: `domains ran on controlled bindings, not live owners: ${fixtureDomains.join(', ')}`,
        frequency: { affected: executed.length, total, unit: 'executions' },
        affectedWorkloads: [...new Set(executed.map((r) => r.case.id))].sort(),
        suspectedLayer: 'Domain',
        evidenceRefs: ['manifest.json#plan.bindings'],
        whyCurrentArchitectureIsInsufficient: null,
        workaround: 'fixture / shadow owners behind the same ports',
        productionImpact: 'real owner latency, data shape and failure modes remain unmeasured',
        modelSpecific: false,
        scope: 'pack_specific',
        blocksNextPhase: false,
      }),
    );
  }
  return out;
}
