import {
  fingerprint,
  type ContextContributionInput,
  type ContextItem,
  type DerivedSummaryContent,
} from '@r4/contracts';
import type { ContextCompactor } from './compactor.js';

/** Summaries are memory: produced ones are persisted as DERIVED_SUMMARY entries and read back by the memory source. */
export const MEMORY_SOURCE_ID = 'platform.memory';

/** A summary produced by this compilation, to be persisted atomically with the snapshot that uses it. */
export interface NewDerivedSummary {
  readonly taskId: string;
  /** End of the covered range. */
  readonly occurredAt: string;
  readonly sensitivity: 'NORMAL' | 'SENSITIVE';
  readonly content: DerivedSummaryContent;
}

/** Same compactor + same source items (ids and content) → same key. */
export function derivationKeyOf(compactor: Pick<ContextCompactor, 'id' | 'version'>, items: readonly ContextItem[]): string {
  return fingerprint({
    compactorId: compactor.id,
    compactorVersion: compactor.version,
    sources: items.map((item) => ({ itemId: item.itemId, content: fingerprint(item.content), assertions: fingerprint(item.assertions) })),
  });
}

export function summaryItemId(derivationKey: string): string {
  return `summary:${derivationKey}`;
}

/**
 * The single mapping from a summary to its context item — used both for a
 * summary produced now and for one loaded back from memory, so the two are
 * identical and a recovered iteration sees exactly the same input.
 */
export function derivedSummaryContribution(summary: {
  readonly taskId: string;
  readonly sensitivity: 'NORMAL' | 'SENSITIVE';
  readonly content: DerivedSummaryContent;
  /** Explicit expiry of the stored entry, if any. */
  readonly validUntil?: string | null;
}): ContextContributionInput {
  const { derivation } = summary.content;
  return {
    itemId: summaryItemId(derivation.derivationKey),
    kind: 'derived_summary',
    authority: 'DERIVED',
    temporality: 'point_in_time',
    content: {
      text: summary.content.text,
      derivation: {
        derivationKey: derivation.derivationKey,
        compactorId: derivation.compactorId,
        compactorVersion: derivation.compactorVersion,
        sourceCount: derivation.sourceItemIds.length,
        fromItemId: derivation.sourceItemIds[0]!,
        toItemId: derivation.sourceItemIds.at(-1)!,
        fromObservedAt: derivation.fromObservedAt,
        toObservedAt: derivation.toObservedAt,
      },
    },
    assertions: summary.content.assertions,
    provenance: {
      recordType: 'derived_summary',
      recordId: derivation.derivationKey,
      derivedFrom: derivation.sourceItemIds,
      producedBy: `${derivation.compactorId}@${derivation.compactorVersion}`,
    },
    createdAt: derivation.toObservedAt,
    observedAt: derivation.toObservedAt,
    validUntil: summary.validUntil ?? null,
    sensitivity: summary.sensitivity,
    taskId: summary.taskId,
  };
}
