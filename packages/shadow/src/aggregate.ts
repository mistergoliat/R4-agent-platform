import { aggregate, distribution, type AggregateBlock, type BenchmarkResult, type Distribution, type EvaluationRun } from '@r4/evaluation';
import type { SafetyCheckCode } from './manifest.js';
import type { ShadowRun } from './run.js';
import type { WorkloadCase } from './workload.js';

/**
 * Suite aggregates (R4-H). No readiness score: dimensions, each with its
 * numerator and denominator or its distribution (p95 only with ≥ 20 values,
 * as in R4-G). Quality and protocol numbers are R4-G's (same definitions and
 * denominators); H adds reliability, operational, human-collaboration and
 * shadow-safety dimensions measured around the execution.
 */
export interface CountedRate {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
}

export interface ShadowAggregates {
  readonly quality: AggregateBlock | null;
  readonly technical: {
    readonly statusDistribution: Record<string, number>;
    readonly legitimateStop: CountedRate;
    readonly acceptableStopForCase: CountedRate;
  };
  readonly protocol: { readonly adherence: CountedRate; readonly adherenceExcludingInjectedFaults: CountedRate; readonly invalidDecisionAttempts: number };
  readonly reliability: {
    readonly modelCalls: number;
    readonly providerErrorsByKind: Record<string, number>;
    readonly providerErrorRate: CountedRate;
    readonly providerRateLimits: number;
    readonly injectedFaults: Record<string, number>;
    readonly domainCalls: number;
    readonly domainErrorsByCategory: Record<string, number>;
    readonly domainErrorRate: CountedRate;
    readonly domainRateLimits: number;
    readonly runsRecovered: number;
    readonly executionFailures: number;
  };
  readonly governance: {
    readonly proposals: number;
    readonly allow: number;
    readonly deny: number;
    readonly requireApproval: number;
    readonly receiptsByStatus: Record<string, number>;
    readonly reconciliationAttempts: number;
    readonly governanceFindings: number;
  };
  readonly human: { readonly consultations: number; readonly approvals: number; readonly handoffs: number; readonly byStatus: Record<string, number>; readonly ownershipViolations: number };
  readonly semantic: { readonly requested: number; readonly completed: number; readonly inconclusive: number; readonly skipped: number; readonly error: number };
  readonly operational: {
    readonly userPerceivedMs: Distribution;
    readonly turnWallClockMs: Distribution;
    readonly modelCallMs: Distribution;
    readonly domainCallMs: Distribution;
    readonly evaluationMs: Distribution;
    readonly inputTokensPerInputTurn: Distribution;
    readonly modelCallsPerInputTurn: Distribution;
    readonly capabilityReadsPerInputTurn: Distribution;
    readonly writeProposalsPerTask: Distribution;
    readonly contextMaxTokens: Distribution;
    readonly contextGrowthTokens: Distribution;
    readonly duplicateReads: number;
    readonly refreshReads: number;
    readonly capabilityReads: number;
    readonly inputTurns: number;
    readonly totals: { readonly modelCalls: number; readonly inputTokens: number; readonly outputTokens: number; readonly reasoningTokens: null; readonly note: string };
  };
  readonly safety: {
    readonly productionEffects: number;
    readonly realOutboundDeliveries: number;
    readonly outboundWouldDeliver: number;
    readonly shadowEffectsExecuted: number;
    readonly sandboxEffectsExecuted: number;
    readonly blockedCalls: number;
    readonly failedChecks: Partial<Record<SafetyCheckCode, number>>;
    readonly runsChecked: number;
  };
  readonly invariants: {
    readonly byClass: Record<'safety' | 'technical' | 'behavioral', { passed: number; total: number; notExercised: number }>;
    readonly failed: readonly { readonly shadowRunId: string; readonly kind: string; readonly class: string; readonly detail: string }[];
  };
}

const counted = (n: number, d: number): CountedRate => ({ numerator: n, denominator: d, rate: d === 0 ? null : Math.round((n / d) * 10_000) / 10_000 });
const add = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};
const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

export function aggregateShadowRuns(input: { runs: readonly ShadowRun[]; cases: readonly WorkloadCase[]; results: readonly BenchmarkResult[]; evaluations: readonly EvaluationRun[] }): ShadowAggregates {
  const executed = input.runs.filter((r) => r.status === 'executed' && r.operational !== null && r.sideEffects !== null);
  const caseById = new Map(input.cases.map((c) => [c.id, c]));
  const resultById = new Map(input.results.filter((r) => r.evaluationRunId).map((r) => [r.evaluationRunId!, r]));
  const statuses: Record<string, number> = {};
  let acceptable = 0;
  let legit = 0;
  let evaluatedN = 0;
  let validAll = 0;
  let attemptsAll = 0;
  let validClean = 0;
  let attemptsClean = 0;
  for (const r of executed) {
    const result = r.evaluationRunId ? resultById.get(r.evaluationRunId) : undefined;
    if (!result?.outcome) continue;
    evaluatedN += 1;
    statuses[result.outcome.technicalStatus] = (statuses[result.outcome.technicalStatus] ?? 0) + 1;
    if (result.outcome.technicallyValid) legit += 1;
    if (caseById.get(r.case.id)?.expectations.acceptableStops.includes(result.outcome.technicalStatus)) acceptable += 1;
    const valid = result.metrics['r4.protocol_adherence.validDecisions'] ?? 0;
    const attempts = result.metrics['r4.protocol_adherence.decisionAttempts'] ?? 0;
    validAll += valid ?? 0;
    attemptsAll += attempts ?? 0;
    if ((r.operational!.modelCalls.injected ?? 0) === 0) {
      validClean += valid ?? 0;
      attemptsClean += attempts ?? 0;
    }
  }

  const providerErrors: Record<string, number> = {};
  const injected: Record<string, number> = {};
  const domainErrors: Record<string, number> = {};
  const receipts: Record<string, number> = {};
  let modelCalls = 0;
  let domainCalls = 0;
  let proposals = 0;
  let allow = 0;
  let deny = 0;
  let approval = 0;
  let reconciliations = 0;
  const failedChecks: Partial<Record<SafetyCheckCode, number>> = {};
  const safety = { productionEffects: 0, realOutboundDeliveries: 0, outboundWouldDeliver: 0, shadowEffectsExecuted: 0, sandboxEffectsExecuted: 0, blockedCalls: 0 };
  for (const r of executed) {
    const o = r.operational!;
    const m = r.sideEffects!;
    modelCalls += o.modelCalls.total - o.modelCalls.injected;
    for (const [k, v] of Object.entries(o.modelCalls.errorsByKind)) {
      if (k.startsWith('injected:')) add(injected, { [k.slice('injected:'.length)]: v });
      else add(providerErrors, { [k]: v });
    }
    domainCalls += o.domain.calls;
    add(domainErrors, o.domain.errorsByCategory);
    proposals += m.writesProposed;
    allow += m.writesAuthorized;
    deny += m.writesDenied;
    approval += m.writesRequiringApproval;
    reconciliations += m.reconciliationAttempts;
    add(receipts, m.receiptsByStatus);
    safety.productionEffects += m.productionEffectsExecuted;
    safety.realOutboundDeliveries += m.outboundActuallyDelivered;
    safety.outboundWouldDeliver += m.outboundWouldDeliver;
    safety.shadowEffectsExecuted += m.shadowEffectsExecuted;
    safety.sandboxEffectsExecuted += m.sandboxEffectsExecuted;
    safety.blockedCalls += m.blockedCalls;
    for (const c of r.safety) if (!c.passed) failedChecks[c.code] = (failedChecks[c.code] ?? 0) + c.violations;
  }
  const providerErrorTotal = Object.values(providerErrors).reduce((s, v) => s + v, 0);
  const domainErrorTotal = Object.values(domainErrors).reduce((s, v) => s + v, 0);

  // Human collaboration: the operator actions each executor applied (its event log), per action.
  const human = { consultations: 0, approvals: 0, handoffs: 0, byStatus: {} as Record<string, number> };
  const semantic = { requested: 0, completed: 0, inconclusive: 0, skipped: 0, error: 0 };
  let governanceFindings = 0;
  for (const e of input.evaluations) {
    for (const ev of e.result.evaluatorResults.filter((x) => x.kind === 'semantic')) {
      if (ev.status !== 'skipped') semantic.requested += 1;
      semantic[ev.status] += 1;
    }
    governanceFindings += e.result.findings.filter((f) => f.category === 'GOVERNANCE').length;
  }

  const invariants = { safety: { passed: 0, total: 0, notExercised: 0 }, technical: { passed: 0, total: 0, notExercised: 0 }, behavioral: { passed: 0, total: 0, notExercised: 0 } };
  const failed: { shadowRunId: string; kind: string; class: string; detail: string }[] = [];
  let ownershipViolations = 0;
  for (const r of executed) {
    for (const inv of r.caseInvariants) {
      if (!inv.exercised) {
        invariants[inv.class].notExercised += 1;
        continue;
      }
      invariants[inv.class].total += 1;
      if (inv.passed) invariants[inv.class].passed += 1;
      else {
        failed.push({ shadowRunId: r.shadowRunId, kind: inv.kind, class: inv.class, detail: inv.detail });
        if (/handoff|ownership/.test(inv.kind)) ownershipViolations += 1;
      }
    }
    for (const ev of r.events) {
      if (ev.kind !== 'operator' || !ev.applied) continue;
      if (/^answer_consultation/.test(ev.note)) human.consultations += 1;
      if (/^(approve|reject)/.test(ev.note)) human.approvals += 1;
      if (/^takeover/.test(ev.note)) human.handoffs += 1;
      const action = ev.note.split(':')[0]!;
      human.byStatus[action] = (human.byStatus[action] ?? 0) + 1;
    }
  }

  const flat = (pick: (r: ShadowRun) => readonly number[]) => executed.flatMap((r) => pick(r));
  const each = (pick: (r: ShadowRun) => number | null) => executed.map((r) => pick(r));
  return {
    quality: input.results.length > 0 ? aggregate(input.results) : null,
    technical: { statusDistribution: sorted(statuses), legitimateStop: counted(legit, evaluatedN), acceptableStopForCase: counted(acceptable, evaluatedN) },
    protocol: { adherence: counted(validAll, attemptsAll), adherenceExcludingInjectedFaults: counted(validClean, attemptsClean), invalidDecisionAttempts: attemptsAll - validAll },
    reliability: {
      modelCalls,
      providerErrorsByKind: sorted(providerErrors),
      providerErrorRate: counted(providerErrorTotal, modelCalls),
      providerRateLimits: providerErrors.rate_limited ?? 0,
      injectedFaults: sorted(injected),
      domainCalls,
      domainErrorsByCategory: sorted(domainErrors),
      domainErrorRate: counted(domainErrorTotal, domainCalls),
      domainRateLimits: domainErrors.rate_limited ?? 0,
      runsRecovered: executed.reduce((s, r) => s + r.operational!.runs.recoveries, 0),
      executionFailures: input.runs.filter((r) => r.status === 'execution_failed').length,
    },
    governance: { proposals, allow, deny, requireApproval: approval, receiptsByStatus: sorted(receipts), reconciliationAttempts: reconciliations, governanceFindings },
    human: { consultations: human.consultations, approvals: human.approvals, handoffs: human.handoffs, byStatus: sorted(human.byStatus), ownershipViolations },
    semantic,
    operational: {
      userPerceivedMs: distribution(flat((r) => r.operational!.latency.userPerceivedMs)),
      turnWallClockMs: distribution(flat((r) => r.operational!.latency.turnWallClockMs)),
      modelCallMs: distribution(flat((r) => r.operational!.latency.modelCallMs)),
      domainCallMs: distribution(flat((r) => r.operational!.latency.domainCallMs)),
      evaluationMs: distribution(each((r) => r.evaluationLatencyMs)),
      inputTokensPerInputTurn: distribution(each((r) => r.operational!.amplification.inputTokensPerInputTurn)),
      modelCallsPerInputTurn: distribution(each((r) => r.operational!.amplification.modelCallsPerInputTurn)),
      capabilityReadsPerInputTurn: distribution(each((r) => r.operational!.amplification.capabilityReadsPerInputTurn)),
      writeProposalsPerTask: distribution(each((r) => r.operational!.amplification.writeProposals)),
      contextMaxTokens: distribution(each((r) => r.operational!.context.maxTokens)),
      contextGrowthTokens: distribution(each((r) => r.operational!.context.growthTokens)),
      duplicateReads: executed.reduce((s, r) => s + r.operational!.amplification.duplicateReads, 0),
      refreshReads: executed.reduce((s, r) => s + r.operational!.amplification.refreshReads, 0),
      capabilityReads: executed.reduce((s, r) => s + r.operational!.amplification.capabilityReads, 0),
      inputTurns: executed.reduce((s, r) => s + r.operational!.inputTurns, 0),
      totals: { modelCalls, inputTokens: executed.reduce((s, r) => s + r.operational!.tokens.input, 0), outputTokens: executed.reduce((s, r) => s + r.operational!.tokens.output, 0), reasoningTokens: null, note: 'reasoning tokens not exposed through ModelUsage; no pricing applied (cost = f(tokens) outside the runtime)' },
    },
    safety: { ...safety, failedChecks, runsChecked: executed.length },
    invariants: { byClass: invariants, failed },
  };
}
