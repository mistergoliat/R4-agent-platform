import type { Evaluator, EvaluationFragment } from '../evaluator.js';
import { count, distribution, measure, rate } from '../metrics.js';
import { stepsOf, type ContextSnapshotMeta, type EvaluationSubject } from '../subject.js';

/**
 * Efficiency (deterministic): existing telemetry turned into first-class
 * metrics. Token counts are the run usage the platform accounted; reasoning
 * tokens appear only when a harness recorded a provider-exposed count (the
 * platform's ModelUsage carries none — deferred, see ADR-025). Latency per
 * model call exists only with harness call records; run durations always.
 * Nothing is priced here: cost is computed later, outside the runtime, from
 * these counts.
 */
export class EfficiencyEvaluator implements Evaluator {
  readonly descriptor = { ref: { id: 'r4.efficiency', version: 1 }, kind: 'deterministic' as const, description: 'Turns, runs, model calls, tokens, capability use, latency and per-turn ratios.', emits: [], authoritativeFor: [] };

  evaluate(subject: Readonly<EvaluationSubject>): EvaluationFragment {
    const steps = stepsOf(subject);
    const turns = subject.turns.length;
    const modelCalls = steps.length;
    const input = subject.runs.reduce((s, r) => s + r.usage.inputTokens, 0);
    const output = subject.runs.reduce((s, r) => s + r.usage.outputTokens, 0);
    const reasoningCounts = (subject.modelCalls ?? []).map((c) => c.reasoningTokens).filter((n): n is number => n !== null);
    const capabilityReads = steps.filter((s) => s.decision?.type === 'read_capability' && s.invocationId !== null).length;
    const successfulWrites = subject.actions.receipts.filter((r) => r.status === 'succeeded').length;
    const callLatency = distribution((subject.modelCalls ?? []).map((c) => c.latencyMs));
    const runDuration = distribution(subject.runs.map((r) => (r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null)));
    const contextTokens = lastAttempts(subject).reduce((s, c) => s + c.estimatedTokens, 0);
    const completed = subject.task.status === 'completed';
    return {
      findings: [],
      metrics: {
        turns: count(turns),
        runs: count(subject.runs.length),
        modelCalls: count(modelCalls),
        inputTokens: measure(input, 'tokens'),
        outputTokens: measure(output, 'tokens'),
        reasoningTokens: measure(reasoningCounts.length > 0 ? reasoningCounts.reduce((s, n) => s + n, 0) : null, 'tokens', reasoningCounts.length > 0 ? null : 'not exposed by the provider path'),
        contextTokens: measure(contextTokens, 'tokens', 'sum of estimated context tokens over model calls'),
        capabilityReads: count(capabilityReads),
        writeProposals: count(subject.actions.proposals.length),
        successfulWrites: count(successfulWrites),
        modelCallsPerTurn: rate(modelCalls, turns, 'per_turn'),
        inputTokensPerTurn: rate(input, turns, 'per_turn'),
        outputTokensPerTurn: rate(output, turns, 'per_turn'),
        capabilityCallsPerTurn: rate(capabilityReads + subject.actions.proposals.length, turns, 'per_turn'),
        tokensPerCompletedTask: completed ? measure(input + output, 'per_task') : measure(null, 'per_task', `task not completed (${subject.task.status})`),
        medianModelCallLatencyMs: measure(callLatency.median, 'ms', callLatency.n === 0 ? 'no harness call records' : null),
        medianRunDurationMs: measure(runDuration.median, 'ms'),
      },
      data: { latency: { modelCallMs: callLatency, runDurationMs: runDuration } },
    };
  }
}

/**
 * Context composition (deterministic, from C2 snapshot accounting): tokens by
 * source and kind, growth over model calls, largest sources. Measures only;
 * the Context Compiler is not touched and nothing is optimized here.
 */
export class ContextCompositionEvaluator implements Evaluator {
  readonly descriptor = { ref: { id: 'r4.context_composition', version: 1 }, kind: 'deterministic' as const, description: 'Context tokens by source and kind, growth per model call, largest sources.', emits: [], authoritativeFor: [] };

  evaluate(subject: Readonly<EvaluationSubject>): EvaluationFragment {
    const snapshots = lastAttempts(subject);
    const byKind: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const maxBySource: Record<string, number> = {};
    for (const s of snapshots) {
      for (const [k, t] of Object.entries(s.includedTokensByKind)) byKind[k] = (byKind[k] ?? 0) + t;
      for (const [k, t] of Object.entries(s.includedTokensBySource)) {
        bySource[k] = (bySource[k] ?? 0) + t;
        maxBySource[k] = Math.max(maxBySource[k] ?? 0, t);
      }
    }
    const runSeq = new Map(subject.runs.map((r) => [r.runId, r.sequence]));
    const growth = snapshots.map((s) => ({ run: runSeq.get(s.runId) ?? 0, iteration: s.iteration, estimatedTokens: s.estimatedTokens }));
    const first = growth[0]?.estimatedTokens ?? null;
    const last = growth.at(-1)?.estimatedTokens ?? null;
    const largest = Object.entries(maxBySource).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([source, maxTokens]) => ({ source, maxTokens }));
    return {
      findings: [],
      metrics: {
        contextSnapshots: count(snapshots.length),
        contextTokensFirstCall: measure(first, 'tokens'),
        contextTokensLastCall: measure(last, 'tokens'),
        contextTokensMax: measure(growth.length ? Math.max(...growth.map((g) => g.estimatedTokens)) : null, 'tokens'),
        contextGrowthTokens: measure(first !== null && last !== null ? last - first : null, 'tokens', 'last call minus first call'),
        compactedItems: count(snapshots.reduce((s, c) => s + c.compactedCount, 0)),
      },
      data: { tokensByKind: byKind, tokensBySource: bySource, growth, largestSources: largest },
    };
  }
}

/** One snapshot per model call: the last attempt of each (run, iteration). */
function lastAttempts(subject: Readonly<EvaluationSubject>): ContextSnapshotMeta[] {
  return [...subject.runs]
    .sort((a, b) => a.sequence - b.sequence)
    .flatMap((r) => {
      const byIteration = new Map<number, ContextSnapshotMeta>();
      for (const c of r.contexts) {
        const prev = byIteration.get(c.iteration);
        if (!prev || c.attempt > prev.attempt) byIteration.set(c.iteration, c);
      }
      return [...byIteration.values()].sort((a, b) => a.iteration - b.iteration);
    });
}
