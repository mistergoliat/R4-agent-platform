import type { ContextContributionInput, JsonValue } from '@r4/contracts';
import type { ContextSource, ContextSourceRequest } from '@r4/context-compiler';
import type { ProductionStore } from '@r4/live-ops';
import { DomainError, type QuoteV2Quote, type QuoteV2Service } from '@r4-adapters/domains';
import { QUOTE_RECOVERY_SOURCE_ID, SALES_TASK_TYPE } from '../ids.js';
import type { ConversationQuoteRecord, PostgresSalesStore } from './store.js';

const ABOUT =
  'Quotes formally issued earlier in this same conversation with this contact (this task or earlier tasks of the conversation), newest first, ' +
  'each with its state as the Quote owner reports it NOW (stateFrom quote_owner) or, when the owner could not be read, what R4 recorded at issuance (stateFrom r4_record). ' +
  'A quote can be relied on only while its state is issued (stillValid true). An expired or cancelled quote is no longer valid: it cannot be accepted, paid or issued again, and its prices are not current. ' +
  'If the contact asks about it or about the same products, you may say its state and offer an updated proposal: put the items in the workspace (sales.workspace.update), read quote.preview for today\'s prices and availability, ' +
  'present that new offer, and issue a NEW quote only when the contact accepts it. Never reuse an old quote number, total or validity for a new proposal, and never say a quote is valid when stillValid is not true. ' +
  'When stillValid is null its current state is unknown: say you cannot confirm it right now. This is no reason to contact anyone on your own.';

const MEANING: Readonly<Record<string, string>> = {
  issued: 'valid until validUntilExclusive (last valid day validThroughLocalDate, Chile)',
  expired: 'expired: its validity ended; it can no longer be honored as issued',
  cancelled: 'cancelled by the quote owner: not valid',
  issuing: 'accepted by the quote owner but its document is not ready yet',
};

type OwnerRead = { readonly quote: QuoteV2Quote } | { readonly error: 'not_found' | 'unavailable' };

export interface QuoteRecoveryDeps {
  readonly conversation: Pick<ProductionStore, 'earlierConversationTasks'>;
  readonly sales: Pick<PostgresSalesStore, 'conversationQuotes'>;
  readonly quotes: Pick<QuoteV2Service, 'getQuote'>;
  /** Quotes shown, newest first (default 3). */
  readonly maxQuotes?: number;
  /** Earlier tasks of the conversation searched (default 10). */
  readonly maxTasks?: number;
  /** Only quotes issued in the last `windowDays` (default 30). */
  readonly windowDays?: number;
  /** Per owner read (default 2000 ms); past it the quote shows R4's record. */
  readonly ownerTimeoutMs?: number;
}

/**
 * (M3 — quote recovery) The quotes R4 issued in this conversation — this task and the earlier tasks of the same
 * channel conversation — with their CURRENT state read from the Quote V2 owner (`getQuote`), so a returning contact
 * can be told that a quote expired and be offered an updated proposal. One `state` item (AUTHORITATIVE, `live`: the
 * owner's current record read during this compilation), bounded to the newest `maxQuotes`. Read-only: it never
 * writes, never re-issues, and an updated proposal goes through quote.preview / quote.create like any other.
 *
 * Only R4's own records of this conversation's lineage are read (never a lookup by customer), so no other contact's
 * quote can appear. Each owner answer is kept for the rest of the run (the context is compiled per iteration);
 * an unreachable owner degrades to R4's recorded validity, never to a guess.
 */
export class SalesQuoteRecoveryContextSource implements ContextSource {
  readonly id = QUOTE_RECOVERY_SOURCE_ID;
  readonly #deps: QuoteRecoveryDeps;
  readonly #reads = new Map<string, Promise<OwnerRead>>();

  constructor(deps: QuoteRecoveryDeps) {
    this.#deps = deps;
  }

  async load(request: ContextSourceRequest): Promise<readonly ContextContributionInput[]> {
    const { task, run } = request.execution;
    if (task.taskType !== SALES_TASK_TYPE) return [];
    const maxQuotes = this.#deps.maxQuotes ?? 3;
    const earlier = await this.#deps.conversation.earlierConversationTasks(task.taskId, this.#deps.maxTasks ?? 10);
    const since = new Date(request.now.getTime() - (this.#deps.windowDays ?? 30) * 86_400_000).toISOString();
    // One more than shown: whether older quotes were left out.
    const records = await this.#deps.sales.conversationQuotes([task.taskId, ...earlier], { since, limit: maxQuotes + 1 });
    if (records.length === 0) return [];
    const shown = records.slice(0, maxQuotes);
    const reads = await Promise.all(shown.map((r) => this.#read(run.runId, r.quoteId)));
    const newest = shown[0]!;
    return [
      {
        itemId: `sales_quotes:${task.taskId}`,
        kind: 'state',
        authority: 'AUTHORITATIVE',
        temporality: 'live',
        content: {
          about: ABOUT,
          quotes: shown.map((r, i) => quoteView(r, reads[i]!, task.taskId, request.now)),
          olderQuotesOmitted: records.length > maxQuotes,
        } as unknown as JsonValue,
        provenance: { recordType: 'sales_quote_v2_issued', recordId: newest.quoteId, producedBy: 'quote' },
        createdAt: newest.issuedAt,
        taskId: task.taskId,
        required: true,
      },
    ];
  }

  #read(runId: string, quoteId: string): Promise<OwnerRead> {
    const key = `${runId}|${quoteId}`;
    let read = this.#reads.get(key);
    if (!read) {
      // ponytail: crude bound on a per-run cache; an LRU if a worker ever serves many runs with quotes at once.
      if (this.#reads.size >= 500) this.#reads.clear();
      read = this.#deps.quotes.getQuote(quoteId, { signal: AbortSignal.timeout(this.#deps.ownerTimeoutMs ?? 2000) }).then(
        (quote): OwnerRead => ({ quote }),
        (error: unknown): OwnerRead => ({ error: error instanceof DomainError && error.category === 'not_found' ? 'not_found' : 'unavailable' }),
      );
      this.#reads.set(key, read);
    }
    return read;
  }
}

/** Pure: one quote as the model sees it. No prices except the owner's current total; no customer data. */
export function quoteView(r: ConversationQuoteRecord, owner: OwnerRead, currentTaskId: string, now: Date): Record<string, unknown> {
  const quote = 'quote' in owner ? owner.quote : null;
  const validUntilExclusive = quote?.validity?.validUntilExclusive ?? r.validUntilExclusive;
  const validThroughLocalDate = quote?.validity?.validThroughLocalDate ?? r.validThroughLocalDate;
  // Without the owner: past R4's recorded validity the quote is expired or cancelled (both terminal), never valid again.
  const pastValidity = now.getTime() >= Date.parse(validUntilExclusive);
  // The owner's own projection (state machine T9), at THIS compilation's clock: an answer cached earlier in the run
  // as issued reads as expired once its validity ends.
  const status = quote ? (quote.status === 'issued' && pastValidity ? 'expired' : quote.status) : null;
  return {
    quoteNumber: r.quoteNumber,
    issuedAt: r.issuedAt,
    earlierTask: r.taskId !== currentTaskId,
    state: status ?? 'unknown',
    stateFrom: quote ? 'quote_owner' : 'r4_record',
    stillValid: status ? status === 'issued' : pastValidity ? false : null,
    meaning: status ? (MEANING[status] ?? status) : pastValidity ? 'no longer valid (its recorded validity ended); the quote owner could not be read now' : `the quote owner could not be read now (${'error' in owner ? owner.error : ''}): its current state is unknown`,
    validThroughLocalDate,
    validUntilExclusive,
    ...(quote ? { totalGrossClp: quote.totals.gross } : {}),
    items: r.snapshotLines ?? r.request.lines.map((l) => ({ itemKey: null, description: l.item.description, quantity: Number(l.quantity.value) })),
    delivery: r.request.shipping ? { commune: r.request.shipping.destination.commune, carrierName: r.request.shipping.carrier.name } : null,
  };
}
