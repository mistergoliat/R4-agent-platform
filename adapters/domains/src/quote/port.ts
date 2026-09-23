import type { CallOptions, ItemQuantity, Money } from '../shared/errors.js';

/**
 * Quote port. The Quote owner is the authority for quote identity, number,
 * line prices, totals, validity, issued status and the document reference.
 * It prices lines itself from the current catalog and computes shipping
 * itself: callers send only what was chosen, never amounts.
 *
 * Idempotency: `create` takes the caller's idempotency key (R4 passes its
 * platform execution key). The same key always denotes one logical quote:
 * repeating it returns that quote (`replayed: true`) instead of issuing a
 * second one, and `findByIdempotencyKey` answers whether it exists. Changing
 * the solution means a new quote (a new key); issued quotes are not edited.
 *
 * Failure semantics: a `rejected` answer and a `temporarily_unavailable`
 * error mean no quote was issued; a `timeout` / `unknown_outcome` error means
 * it may have been — only `findByIdempotencyKey` can tell.
 *
 * The live adapter (Quote Service public API) is pending: no contract for it
 * is documented in this repository.
 */
export interface QuoteCustomer {
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
}

export interface QuoteCreateRequest {
  readonly customer: QuoteCustomer;
  readonly lines: readonly ItemQuantity[];
  readonly delivery: { readonly commune: string; readonly region?: string | null };
}

export interface QuoteLine {
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
}

export interface Quote {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly status: 'issued';
  readonly customer: QuoteCustomer;
  readonly lines: readonly QuoteLine[];
  readonly shipping: { readonly serviceLevel: 'standard'; readonly commune: string; readonly amount: Money };
  readonly subtotal: Money;
  readonly total: Money;
  readonly issuedAt: string;
  readonly validUntil: string;
  readonly documentRef: string;
}

export type QuoteCreateOutcome =
  | { readonly status: 'created'; readonly quote: Quote; readonly replayed: boolean }
  /** The owner refused; nothing was issued. */
  | { readonly status: 'rejected'; readonly code: string; readonly message: string; readonly details: Readonly<Record<string, string | number | boolean | null>> };

export interface QuoteService {
  create(request: QuoteCreateRequest, idempotencyKey: string, options?: CallOptions): Promise<QuoteCreateOutcome>;
  findByIdempotencyKey(idempotencyKey: string, options?: CallOptions): Promise<Quote | null>;
}
