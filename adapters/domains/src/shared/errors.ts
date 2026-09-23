/**
 * How a domain owner's failure is classified at the port. Adapters translate
 * transport errors (HTTP status, connection resets, deadlines) into exactly
 * one of these; callers never parse messages.
 *
 * - not_found                the owner has no such record (reads usually answer "found: false" instead)
 * - validation               the owner refused the request as invalid; no effect
 * - conflict                 the owner refused because of its current state (e.g. a version); no effect
 * - temporarily_unavailable  the owner could not be reached before anything was sent; no effect
 * - timeout                  no answer in time; for a write the effect may or may not exist
 * - unknown_outcome          the request may have been applied; only a lookup can tell
 */
export const DOMAIN_ERROR_CATEGORIES = ['not_found', 'validation', 'conflict', 'temporarily_unavailable', 'timeout', 'unknown_outcome'] as const;
export type DomainErrorCategory = (typeof DOMAIN_ERROR_CATEGORIES)[number];

export class DomainError extends Error {
  readonly category: DomainErrorCategory;
  /** The owner's own reason code, when it gives one (e.g. `insufficient_stock`). */
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(category: DomainErrorCategory, code: string, message: string, details: Readonly<Record<string, string | number | boolean | null>> = {}) {
    super(message);
    this.name = 'DomainError';
    this.category = category;
    this.code = code;
    this.retryable = category === 'temporarily_unavailable' || category === 'timeout';
    this.details = details;
  }

  /** True when the owner may have applied a write (the caller must reconcile, never assume). */
  get outcomeUnknown(): boolean {
    return this.category === 'timeout' || this.category === 'unknown_outcome';
  }
}

export interface CallOptions {
  /** Aborted by the caller's deadline; adapters must stop and report `timeout`. */
  readonly signal?: AbortSignal;
}

/** Amounts are integers in the currency's minor-less unit (CLP has no decimals). */
export interface Money {
  readonly amount: number;
  readonly currency: 'CLP';
}

export interface ItemQuantity {
  readonly productId: string;
  readonly quantity: number;
}

/** Accent- and case-insensitive normalization used by fixtures for matching. */
export function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Rejects immediately when the caller already gave up. */
export function throwIfAborted(options: CallOptions | undefined): void {
  if (options?.signal?.aborted) throw new DomainError('timeout', 'deadline_exceeded', 'the caller deadline passed before the owner answered');
}
