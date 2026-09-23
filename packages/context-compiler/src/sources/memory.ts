import { MEMORY_AUTHORITY, MEMORY_ITEM_KIND, type ContextContributionInput, type MemoryEntry } from '@r4/contracts';
import type { ContextSource, ContextSourceRequest } from '../source.js';
import { MEMORY_SOURCE_ID, derivedSummaryContribution } from '../summary.js';

/**
 * Read port for durable memory. Implemented by the persistence adapter; the
 * compiler and its sources never know the storage. Returns every entry of the
 * task — superseded and expired ones included, so the compiler can record why
 * they were left out.
 */
export interface MemoryReader {
  listForTask(taskId: string): Promise<readonly MemoryEntry[]>;
}

/**
 * Memory as context. The item's kind and authority come from the memory type
 * (MEMORY_ITEM_KIND / MEMORY_AUTHORITY), never from the entry itself, so no
 * memory entry can enter the context as AUTHORITATIVE.
 */
export class MemoryContextSource implements ContextSource {
  readonly id = MEMORY_SOURCE_ID;
  readonly #reader: MemoryReader;

  constructor(reader: MemoryReader) {
    this.#reader = reader;
  }

  async load(request: ContextSourceRequest): Promise<readonly ContextContributionInput[]> {
    const entries = await this.#reader.listForTask(request.scope.taskId);
    return entries.map(memoryEntryContribution);
  }
}

/** Effective end of validity: the declared one, or the explicit expiry if earlier. */
function endOf(entry: MemoryEntry): string | null {
  if (entry.expiredAt === null) return entry.validUntil;
  if (entry.validUntil === null) return entry.expiredAt;
  return Date.parse(entry.expiredAt) < Date.parse(entry.validUntil) ? entry.expiredAt : entry.validUntil;
}

export function memoryItemId(entryId: string): string {
  return `memory:${entryId}`;
}

export function memoryEntryContribution(entry: MemoryEntry): ContextContributionInput {
  if (entry.memoryType === 'DERIVED_SUMMARY') {
    return derivedSummaryContribution({ taskId: entry.taskId, sensitivity: entry.sensitivity, content: entry.content, validUntil: endOf(entry) });
  }
  const common = {
    itemId: memoryItemId(entry.entryId),
    kind: MEMORY_ITEM_KIND[entry.memoryType],
    authority: MEMORY_AUTHORITY[entry.memoryType],
    provenance: { recordType: 'memory_entry', recordId: entry.entryId, producedBy: `${entry.recordedBy.kind}:${entry.recordedBy.ref}` },
    createdAt: entry.occurredAt,
    validUntil: endOf(entry),
    sensitivity: entry.sensitivity,
    taskId: entry.taskId,
    supersedes: entry.supersedesEntryId === null ? [] : [memoryItemId(entry.supersedesEntryId)],
  } satisfies Partial<ContextContributionInput>;

  switch (entry.memoryType) {
    case 'WORKING':
      // The agent's current working state for this task: live until superseded or expired.
      return { ...common, temporality: 'live', content: { category: entry.content.category, text: entry.content.text } };
    case 'CONVERSATIONAL':
      return {
        ...common,
        temporality: 'point_in_time',
        observedAt: entry.occurredAt,
        content: { actor: entry.content.actor, text: entry.content.text, interactionRef: entry.content.interactionRef },
        assertions: entry.content.assertions,
      };
    case 'EPISODIC':
      return { ...common, temporality: 'point_in_time', observedAt: entry.occurredAt, content: { event: entry.content.event, text: entry.content.text, refs: entry.content.refs } };
  }
}
