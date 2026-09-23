import type { ContextAssertion, ContextItem } from '@r4/contracts';

export interface CompactionInput {
  /** The raw items to summarize, oldest first. They remain durable; the summary never replaces them. */
  readonly items: readonly ContextItem[];
}

export interface CompactionResult {
  readonly text: string;
  /** Claims carried over from the items. They become DERIVED claims: never truth. */
  readonly assertions: readonly ContextAssertion[];
}

/**
 * Seam for compaction: a strategy to fit the context budget, never a source of
 * truth. Whatever it returns is recorded as a DERIVED_SUMMARY with its full
 * derivation (source items, compactor id/version, range); it cannot touch
 * authoritative state, and the items it covers are never deleted.
 *
 * A model-backed compactor can implement this later behind the Model Gateway;
 * R4-C2 ships only the deterministic implementation below.
 */
export interface ContextCompactor {
  readonly id: string;
  readonly version: string;
  compact(input: CompactionInput): Promise<CompactionResult>;
}

export interface DeterministicCompactorOptions {
  /** Upper bound of the summary text, in characters. */
  readonly maxChars?: number;
  /** Characters kept per summarized item. */
  readonly excerptChars?: number;
}

/**
 * Deterministic, extractive compactor (no model): one line per item with its
 * actor and an excerpt, bounded in size, plus the latest claim per subject.
 * Same items → same summary, byte for byte. Its purpose is to prove the
 * architecture and semantics of compaction, not the quality of summaries.
 */
export class DeterministicCompactor implements ContextCompactor {
  readonly id = 'deterministic-extractive';
  readonly version = '1';
  readonly #maxChars: number;
  readonly #excerptChars: number;

  constructor(options: DeterministicCompactorOptions = {}) {
    this.#maxChars = options.maxChars ?? 1_200;
    this.#excerptChars = options.excerptChars ?? 60;
  }

  compact(input: CompactionInput): Promise<CompactionResult> {
    const { items } = input;
    const header = `Summary of ${items.length} earlier items (${items[0]?.observedAt ?? '?'} to ${items.at(-1)?.observedAt ?? '?'}).`;
    const lines: string[] = [header];
    let length = header.length;
    for (const [index, item] of items.entries()) {
      const line = `- ${speaker(item)}: ${excerpt(item, this.#excerptChars)}`;
      if (length + line.length + 1 > this.#maxChars) {
        lines.push(`- (${items.length - index} more)`);
        break;
      }
      lines.push(line);
      length += line.length + 1;
    }
    const latest = new Map<string, ContextAssertion>();
    for (const item of items) for (const assertion of item.assertions) latest.set(assertion.subject, assertion);
    const assertions = [...latest.values()].sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
    return Promise.resolve({ text: lines.join('\n'), assertions });
  }
}

function speaker(item: ContextItem): string {
  const content = item.content as { actor?: { role?: unknown } } | null;
  const role = content && typeof content === 'object' ? content.actor?.role : undefined;
  return typeof role === 'string' ? role : item.kind;
}

function excerpt(item: ContextItem, chars: number): string {
  const content = item.content as { text?: unknown } | null;
  const text = content && typeof content === 'object' && typeof content.text === 'string' ? content.text : JSON.stringify(item.content);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat;
}
