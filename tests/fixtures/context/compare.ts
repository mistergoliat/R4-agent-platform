import type { ContextComposition } from '@r4/contracts';
import type { CompiledResult } from '@r4/context-compiler';

/**
 * Structured difference between two compilations of the same durable state
 * under different policies (e.g. UNBOUNDED vs FIXED(6000)). It measures; it
 * does not judge which is better — that needs task-outcome evals (ADR-015).
 */
export interface CompositionComparison {
  readonly budgets: readonly [string, string];
  readonly compiledEstimatedTokens: readonly [number, number];
  readonly includedCount: readonly [number, number];
  readonly excludedCount: readonly [number, number];
  readonly compactedCount: readonly [number, number];
  readonly excludedForBudget: readonly [number, number];
  /** Included tokens per kind in each compilation, plus the delta (b − a). */
  readonly byKind: Readonly<Record<string, { readonly a: number; readonly b: number; readonly delta: number }>>;
  /** Items included in `a` but not in `b`, per kind. */
  readonly droppedByKind: Readonly<Record<string, number>>;
}

export function compareCompilations(a: CompiledResult, b: CompiledResult): CompositionComparison {
  const ca = a.composition;
  const cb = b.composition;
  const kinds = [...new Set([...Object.keys(ca.byKind), ...Object.keys(cb.byKind)])].sort();
  const tokens = (c: ContextComposition, kind: string) => (c.byKind as Record<string, { included: { estimatedTokens: number } }>)[kind]?.included.estimatedTokens ?? 0;
  const includedIds = (r: CompiledResult) => new Map(r.decisions.filter((d) => d.decision === 'included').map((d) => [d.itemId, d.kind]));
  const inB = includedIds(b);
  const dropped: Record<string, number> = {};
  for (const [id, kind] of includedIds(a)) if (!inB.has(id)) dropped[kind] = (dropped[kind] ?? 0) + 1;
  const label = (c: ContextComposition) => (c.budget.mode === 'fixed' ? `fixed(${c.budget.maxEstimatedTokens})` : 'unbounded');
  return {
    budgets: [label(ca), label(cb)],
    compiledEstimatedTokens: [ca.compiledEstimatedTokens, cb.compiledEstimatedTokens],
    includedCount: [ca.includedCount, cb.includedCount],
    excludedCount: [ca.excludedCount, cb.excludedCount],
    compactedCount: [ca.compactedCount, cb.compactedCount],
    excludedForBudget: [ca.byExclusionReason.budget?.count ?? 0, cb.byExclusionReason.budget?.count ?? 0],
    byKind: Object.fromEntries(kinds.map((k) => [k, { a: tokens(ca, k), b: tokens(cb, k), delta: tokens(cb, k) - tokens(ca, k) }])),
    droppedByKind: Object.fromEntries(Object.entries(dropped).sort(([x], [y]) => (x < y ? -1 : 1))),
  };
}
