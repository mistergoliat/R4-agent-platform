import {
  CONTEXT_AUTHORITIES,
  CONTEXT_EXCLUSION_REASONS,
  CONTEXT_ITEM_KINDS,
  CONTEXT_SECTIONS,
  type ContextBudgetPolicy,
  type ContextComposition,
  type ContextItemDecision,
} from '@r4/contracts';

interface Tally {
  count: number;
  estimatedTokens: number;
}
interface InclusionTally {
  included: Tally;
  excluded: Tally;
}

/**
 * Context accounting (ADR-015): a deterministic projection of a snapshot's
 * item decisions, its estimated size and its effective budget. The compiler
 * returns it for telemetry; `snapshotComposition` recomputes the identical
 * value from durable data. Nothing here is persisted separately: the item
 * decisions (`context_snapshot_items`) are the single source.
 */
export function contextComposition(input: {
  readonly decisions: readonly ContextItemDecision[];
  /** The compiled document's estimate (frame + included items + conflicts). */
  readonly estimatedTokens: number;
  readonly budget: ContextBudgetPolicy;
}): ContextComposition {
  const { decisions, estimatedTokens, budget } = input;
  const byKind = new Map<string, InclusionTally>();
  const byAuthority = new Map<string, InclusionTally>();
  const bySource = new Map<string, InclusionTally>();
  const bySection = new Map<string, Tally>();
  const byReason = new Map<string, Tally>();
  const tokensById = new Map<string, number>();
  let included = 0;
  let excluded = 0;
  let includedCount = 0;
  let excludedCount = 0;

  for (const d of decisions) {
    const side = d.decision === 'included' ? 'included' : 'excluded';
    for (const [map, key] of [[byKind, d.kind], [byAuthority, d.authority], [bySource, d.sourceId]] as const) {
      const entry = map.get(key) ?? { included: tally(), excluded: tally() };
      add(entry[side], d.estimatedTokens);
      map.set(key, entry);
    }
    if (d.decision === 'included') {
      included += d.estimatedTokens;
      includedCount += 1;
      addTo(bySection, d.section!, d.estimatedTokens);
      tokensById.set(d.itemId, d.estimatedTokens);
    } else {
      excluded += d.estimatedTokens;
      excludedCount += 1;
      addTo(byReason, d.reason!, d.estimatedTokens);
    }
  }

  const compacted = decisions.filter((d) => d.reason === 'compacted');
  const summaries = [...new Set(compacted.map((d) => d.representedBy).filter((id): id is string => id !== null))].sort();
  const input_ = compacted.reduce((sum, d) => sum + d.estimatedTokens, 0);
  const output = summaries.reduce((sum, id) => sum + (tokensById.get(id) ?? 0), 0);

  return {
    budget,
    rawEstimatedTokens: included + excluded,
    compiledEstimatedTokens: estimatedTokens,
    includedEstimatedTokens: included,
    excludedEstimatedTokens: excluded,
    overheadEstimatedTokens: estimatedTokens - included,
    includedCount,
    excludedCount,
    compactedCount: compacted.length,
    byKind: ordered(byKind, CONTEXT_ITEM_KINDS),
    byAuthority: ordered(byAuthority, CONTEXT_AUTHORITIES),
    bySource: ordered(bySource, [...bySource.keys()].sort()),
    bySection: ordered(bySection, CONTEXT_SECTIONS),
    byExclusionReason: ordered(byReason, CONTEXT_EXCLUSION_REASONS),
    compaction:
      compacted.length === 0
        ? null
        : { summaryCount: summaries.length, compactedItemCount: compacted.length, inputEstimatedTokens: input_, outputEstimatedTokens: output, ratio: input_ === 0 ? 0 : output / input_ },
  };
}

/** The accounting of a stored snapshot, recomputed from its durable decisions. */
export function snapshotComposition(snapshot: { readonly decisions: readonly ContextItemDecision[]; readonly estimatedTokens: number; readonly budget: ContextBudgetPolicy }): ContextComposition {
  return contextComposition(snapshot);
}

function tally(): Tally {
  return { count: 0, estimatedTokens: 0 };
}

function add(t: Tally, tokens: number): void {
  t.count += 1;
  t.estimatedTokens += tokens;
}

function addTo(map: Map<string, Tally>, key: string, tokens: number): void {
  const t = map.get(key) ?? tally();
  add(t, tokens);
  map.set(key, t);
}

/** Fixed key order (contract order, sources alphabetical) so the value is deterministic. */
function ordered<V>(map: Map<string, V>, keys: readonly string[]): Record<string, V> {
  return Object.fromEntries(keys.filter((k) => map.has(k)).map((k) => [k, map.get(k)!]));
}
