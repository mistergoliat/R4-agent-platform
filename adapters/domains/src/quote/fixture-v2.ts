import { createHash } from 'node:crypto';
import { AvailabilitySwitch } from '../shared/availability.js';
import { DomainError, type CallOptions } from '../shared/errors.js';
import {
  QUOTE_V2_CREATE_OPERATION,
  quoteV2ChargeAmounts,
  quoteV2Totals,
  type QuoteV2Binding,
  type QuoteV2CreateRequest,
  type QuoteV2CreateResult,
  type QuoteV2DocumentBytes,
  type QuoteV2Operation,
  type QuoteV2Quote,
  type QuoteV2Service,
} from './v2.js';

export interface FixtureQuoteV2Faults {
  /** How issuance completes after acceptance: `inline` → 201 issued; `async` → 202 issuing until `completeIssuance` (default `inline`). */
  issuance?: () => 'inline' | 'async';
  /** What the caller sees after a create committed (default `answer`): the lost-response windows. */
  afterCommit?: () => 'answer' | 'timeout' | 'connection_lost';
  /** Document read (default `ok`): `unavailable` = 503 document_storage_failed; `corrupt` = bytes that do not match the manifest. */
  document?: () => 'ok' | 'unavailable' | 'corrupt';
  /** The principal's credential (default `valid`). */
  credential?: () => 'valid' | 'invalid' | 'forbidden';
}

interface Stored {
  quote: QuoteV2Quote;
  operation: QuoteV2Operation;
  pdf: Uint8Array | null;
}

/**
 * In-memory Quote V2 owner for offline tests (R4-J3B). It does exactly what
 * the owner does and nothing it does not: it binds (principal, operation,
 * key) to the request fingerprint, verifies arithmetic and `expectedTotals`,
 * assigns quote id/number, resolves the 5-calendar-day Chile validity, and
 * stores an immutable document with its SHA-256. It never prices, never
 * reads Catalog or Shipping, never sends email.
 */
export class FixtureQuoteV2Service implements QuoteV2Service {
  readonly bindingKind = 'fixture' as const;
  readonly availability = new AvailabilitySwitch('quote');
  readonly faults: FixtureQuoteV2Faults = {};
  readonly #now: () => Date;
  readonly #bindings = new Map<string, { fingerprint: string; quoteId: string; boundAt: string }>();
  readonly #quotes = new Map<string, Stored>();
  #sequence = 0;
  #createCalls = 0;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  /** Quotes the owner committed (the duplicate detector). */
  get quotes(): readonly QuoteV2Quote[] {
    return [...this.#quotes.values()].map((s) => s.quote);
  }

  get createCalls(): number {
    return this.#createCalls;
  }

  async createAndIssue(request: QuoteV2CreateRequest, idempotencyKey: string, options?: CallOptions): Promise<QuoteV2CreateResult> {
    await this.#enter(options);
    this.#createCalls += 1;
    const fingerprint = fingerprintOf(request);
    const bound = this.#bindings.get(idempotencyKey);
    if (bound) {
      if (bound.fingerprint !== fingerprint) throw new DomainError('conflict', 'idempotency_key_conflict', 'this Idempotency-Key is already bound to a different request', { httpStatus: 409 });
      return this.#after(this.#result(bound.quoteId, true));
    }
    const totals = this.#verify(request);
    const issuedAt = this.#now().toISOString();
    this.#sequence += 1;
    const quoteId = uuidOf('quote', this.#sequence);
    const operationId = uuidOf('operation', this.#sequence);
    const quote: QuoteV2Quote = {
      quoteId,
      status: 'issuing',
      version: 1,
      quoteNumber: `PC-${String(this.#sequence).padStart(6, '0')}`,
      currency: 'CLP',
      externalCorrelation: request.externalCorrelation,
      lines: request.lines.map((l, i) => ({ position: i + 1, amounts: quoteV2ChargeAmounts(l.unitPrice, l.quantity.value) })),
      shipping: request.shipping ? { amounts: quoteV2ChargeAmounts(request.shipping.amount, '1') } : null,
      totals,
      validity: chileFiveDayValidity(issuedAt),
      issuance: { issuedAt, operationId, issuerProfileId: 'pesaschile-cl-v1' },
      document: { available: false, pdfSha256: null, byteLength: null, artifactRef: null, generatedAt: null },
    };
    const operation: QuoteV2Operation = { operationId, status: 'pending', quoteId, deadlineAt: new Date(Date.parse(issuedAt) + 86_400_000).toISOString(), completedAt: null, attempts: { count: 0, lastErrorCode: null, nextAttemptAt: null } };
    this.#quotes.set(quoteId, { quote, operation, pdf: null });
    this.#bindings.set(idempotencyKey, { fingerprint, quoteId, boundAt: issuedAt });
    if ((this.faults.issuance?.() ?? 'inline') === 'inline') this.completeIssuance(quoteId, 'succeed');
    return this.#after(this.#result(quoteId, false));
  }

  /** The issuance worker: renders and stores the document (`succeed`) or fails the operation terminally (`fail`; the quote stays `issuing`). */
  completeIssuance(quoteId: string, outcome: 'succeed' | 'fail'): void {
    const stored = this.#quotes.get(quoteId);
    if (!stored || stored.quote.status !== 'issuing') throw new Error(`quote ${quoteId} is not issuing`);
    const completedAt = this.#now().toISOString();
    if (outcome === 'fail') {
      stored.operation = { ...stored.operation, status: 'failed', completedAt, attempts: { count: stored.operation.attempts.count + 1, lastErrorCode: 'document_generation_failed', nextAttemptAt: null } };
      return;
    }
    const pdf = new TextEncoder().encode(`%PDF-1.7\n% fixture quote ${stored.quote.quoteNumber}\n${JSON.stringify(stored.quote.totals)}\n%%EOF\n`);
    const sha = createHash('sha256').update(pdf).digest('hex');
    stored.pdf = pdf;
    stored.quote = { ...stored.quote, status: 'issued', version: 2, document: { available: true, pdfSha256: sha, byteLength: pdf.byteLength, artifactRef: `sha256:${sha}`, generatedAt: completedAt } };
    stored.operation = { ...stored.operation, status: 'succeeded', completedAt, attempts: { count: stored.operation.attempts.count + 1, lastErrorCode: null, nextAttemptAt: null } };
  }

  async getQuote(quoteId: string, options?: CallOptions): Promise<QuoteV2Quote> {
    await this.#enter(options);
    const stored = this.#quotes.get(quoteId);
    if (!stored) throw new DomainError('not_found', 'quote_not_found', 'no such quote', { httpStatus: 404 });
    const { quote } = stored;
    // Projection: an issued quote past its validity reads as expired.
    if (quote.status === 'issued' && quote.validity && this.#now().getTime() >= Date.parse(quote.validity.validUntilExclusive)) return { ...quote, status: 'expired' };
    return quote;
  }

  async getOperation(operationId: string, options?: CallOptions): Promise<QuoteV2Operation> {
    await this.#enter(options);
    const stored = [...this.#quotes.values()].find((s) => s.operation.operationId === operationId);
    if (!stored) throw new DomainError('not_found', 'operation_not_found', 'no such operation', { httpStatus: 404 });
    return stored.operation;
  }

  async lookupIdempotency(idempotencyKey: string, options?: CallOptions): Promise<QuoteV2Binding | null> {
    await this.#enter(options);
    const bound = this.#bindings.get(idempotencyKey);
    if (!bound) return null;
    const stored = this.#quotes.get(bound.quoteId)!;
    return { boundAt: bound.boundAt, requestFingerprint: bound.fingerprint, quoteId: bound.quoteId, operationId: stored.operation.operationId, quoteStatus: stored.quote.status };
  }

  async getDocument(quoteId: string, options?: CallOptions): Promise<QuoteV2DocumentBytes> {
    await this.#enter(options);
    const stored = this.#quotes.get(quoteId);
    if (!stored) throw new DomainError('not_found', 'quote_not_found', 'no such quote', { httpStatus: 404 });
    if (!stored.pdf) throw new DomainError('conflict', 'document_not_available', 'the quote never reached issued', { httpStatus: 409 });
    const mode = this.faults.document?.() ?? 'ok';
    if (mode === 'unavailable') throw new DomainError('temporarily_unavailable', 'document_storage_failed', 'stored artifact unavailable', { httpStatus: 503 });
    const bytes = mode === 'corrupt' ? new TextEncoder().encode('%PDF-1.7\n% tampered\n') : stored.pdf;
    return { bytes, declaredSha256: stored.quote.document.pdfSha256 };
  }

  async #enter(options: CallOptions | undefined): Promise<void> {
    await this.availability.enter(options);
    const credential = this.faults.credential?.() ?? 'valid';
    if (credential === 'invalid') throw new DomainError('unauthorized', 'unauthenticated', 'invalid credential', { httpStatus: 401 });
    if (credential === 'forbidden') throw new DomainError('unauthorized', 'forbidden', 'missing scope', { httpStatus: 403 });
  }

  /** Owner-side checks before acceptance (nothing is bound when one fails). */
  #verify(request: QuoteV2CreateRequest): QuoteV2Quote['totals'] {
    const invalid = (message: string) => new DomainError('validation', 'validation_error', message, { httpStatus: 422 });
    if (request.lines.length < 1 || request.lines.length > 100) throw invalid('1 to 100 lines are required on issue');
    const customer = request.customer as { kind: string; displayName?: string; legalName?: string };
    if (customer.kind === 'person' && !customer.displayName) throw invalid('customer.displayName is required');
    if (customer.kind === 'company' && !customer.legalName) throw invalid('customer.legalName is required');
    let totals: QuoteV2Quote['totals'];
    try {
      totals = quoteV2Totals(request);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : 'invalid charge');
    }
    const expected = request.expectedTotals;
    if (expected && (expected.net !== totals.net || expected.tax !== totals.tax || expected.gross !== totals.gross)) {
      throw new DomainError('validation', 'arithmetic_mismatch', 'expectedTotals do not match owner-computed totals', { httpStatus: 422, expectedGross: expected.gross, computedGross: totals.gross });
    }
    return totals;
  }

  #result(quoteId: string, replayed: boolean): QuoteV2CreateResult {
    const { quote, operation } = this.#quotes.get(quoteId)!;
    return { httpStatus: quote.status === 'issuing' ? 202 : 201, replayed, quote, operation };
  }

  #after(result: QuoteV2CreateResult): Promise<QuoteV2CreateResult> {
    const mode = this.faults.afterCommit?.() ?? 'answer';
    if (mode === 'timeout') return Promise.reject(new DomainError('timeout', 'quote_owner_timeout', 'the quote owner did not answer in time; the quote may exist'));
    if (mode === 'connection_lost') return Promise.reject(new DomainError('unknown_outcome', 'quote_owner_connection_lost', 'connection lost after the request was sent'));
    return Promise.resolve(result);
  }
}

/** SHA-256 over canonical JSON (sorted keys) of {operation, pathParameters, body}, like the owner's RFC 8785 fingerprint. */
export function fingerprintOf(request: QuoteV2CreateRequest): string {
  return createHash('sha256').update(canonicalJson({ operation: QUOTE_V2_CREATE_OPERATION, pathParameters: {}, body: request })).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Owner policy cl-retail-5-calendar-days-v1: issue civil date (America/Santiago) + 4 days inclusive; expires at the next local midnight. */
function chileFiveDayValidity(issuedAt: string): NonNullable<QuoteV2Quote['validity']> {
  const issueLocalDate = santiagoDate(new Date(issuedAt));
  const [y, m, d] = issueLocalDate.split('-').map(Number) as [number, number, number];
  const through = new Date(Date.UTC(y, m - 1, d + 4)).toISOString().slice(0, 10);
  const nextMidnightUtc = Date.UTC(y, m - 1, d + 5);
  // Santiago midnight = UTC midnight minus the zone offset in force at that instant.
  const offsetMs = santiagoOffsetMs(new Date(nextMidnightUtc));
  return { source: 'policy', policyId: 'cl-retail-5-calendar-days-v1', issueLocalDate, validThroughLocalDate: through, validUntilExclusive: new Date(nextMidnightUtc - offsetMs).toISOString().replace('.000Z', 'Z') };
}

function santiagoDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

function santiagoOffsetMs(instant: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', timeZoneName: 'longOffset' }).formatToParts(instant).find((p) => p.type === 'timeZoneName')!.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

function uuidOf(kind: 'quote' | 'operation', sequence: number): string {
  const hex = createHash('sha256').update(`${kind}:${sequence}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
