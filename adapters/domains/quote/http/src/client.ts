import { performance } from 'node:perf_hooks';
import type { z } from 'zod';
import {
  DomainError,
  QUOTE_V2_CREATE_OPERATION,
  type CallOptions,
  type DomainErrorCategory,
  type QuoteV2Binding,
  type QuoteV2CreateRequest,
  type QuoteV2CreateResult,
  type QuoteV2DocumentBytes,
  type QuoteV2Operation,
  type QuoteV2Quote,
  type QuoteV2Service,
} from '@r4-adapters/domains';
import type { QuoteHttpConfig } from './config.js';
import { errorResponseSchema, idempotencyLookupSchema, operationSchema, quoteOperationResultSchema, quoteSchema } from './schemas.js';

/** The subset of `fetch` the client uses (injected: tests and deployments decide the transport). */
export type QuoteFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export type QuoteOperationName = 'createAndIssue' | 'getQuote' | 'getOperation' | 'lookupIdempotency' | 'getDocument';

/** One owner call for telemetry. Carries no token, idempotency key, customer data or body. */
export interface QuoteCallTelemetry {
  readonly kind: 'owner_call';
  readonly operation: QuoteOperationName;
  readonly outcome: 'ok' | 'failed';
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly replayed: boolean | null;
  readonly errorCategory: DomainErrorCategory | null;
  readonly errorCode: string | null;
  readonly correlationId: string | null;
}

const MAX_JSON_CHARS = 2_000_000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Transport failures that prove the request never left this host (connection never established). */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * Quote V2 HTTP client (R4-J3B), the production implementation of the
 * Quote V2 port. Transport only: bearer auth, `Idempotency-Key`, deadline,
 * cancellation, JSON/size/schema validation, typed owner errors, telemetry.
 * No pricing, no arithmetic, no document rendering, no email route: the only
 * reachable mutation is `POST /v2/quotes`.
 *
 * Mutation outcome classification (POST /v2/quotes):
 *   201 / 202                → answer (the caller checks quote/operation state; never success by status)
 *   400 / 413 / 422          → validation (nothing bound)
 *   401 / 403                → unauthorized (nothing bound)
 *   409                      → conflict, code = owner code (idempotency_key_conflict vs lifecycle)
 *   500 / 503                → unknown_outcome (conservative: reconcile by key before anything else)
 *   connection never opened  → temporarily_unavailable (nothing sent)
 *   any other network error  → unknown_outcome; deadline → timeout (outcome unknown)
 * Reads: 5xx / network → temporarily_unavailable; 404 → not_found; deadline → timeout.
 * Anything outside the contract → contract_violation (never repaired, never retried).
 */
export class QuoteV2HttpClient implements QuoteV2Service {
  readonly bindingKind = 'http' as const;
  readonly #config: QuoteHttpConfig;
  readonly #fetch: QuoteFetch;
  readonly #onCall: ((event: QuoteCallTelemetry) => void) | undefined;

  constructor(options: { readonly config: QuoteHttpConfig; readonly fetch: QuoteFetch; readonly onCall?: (event: QuoteCallTelemetry) => void }) {
    this.#config = options.config;
    this.#fetch = options.fetch;
    this.#onCall = options.onCall;
  }

  async createAndIssue(request: QuoteV2CreateRequest, idempotencyKey: string, options?: CallOptions): Promise<QuoteV2CreateResult> {
    const started = performance.now();
    assertKey(idempotencyKey);
    const response = await this.#call(started, 'createAndIssue', 'POST', '/v2/quotes', options, { 'idempotency-key': idempotencyKey, 'content-type': 'application/json' }, JSON.stringify(request));
    if (response.status !== 201 && response.status !== 202) throw this.#unexpected(response.status);
    const replayed = response.headers.get('idempotent-replay') === 'true';
    const body = this.#parse(quoteOperationResultSchema, await this.#json(response), response.status);
    // 202 ⇔ issuing (owner contract); any other combination is outside the contract.
    if ((response.status === 202) !== (body.quote.status === 'issuing') || body.operation.quoteId !== body.quote.quoteId) {
      throw new DomainError('contract_violation', 'quote_owner_invalid_response', `HTTP ${response.status} does not match quote status ${body.quote.status}`, { httpStatus: response.status });
    }
    this.#emitOk(started, 'createAndIssue', response.status, replayed, options);
    return { httpStatus: response.status, replayed, quote: body.quote as QuoteV2Quote, operation: body.operation };
  }

  async getQuote(quoteId: string, options?: CallOptions): Promise<QuoteV2Quote> {
    const started = performance.now();
    const response = await this.#call(started, 'getQuote', 'GET', `/v2/quotes/${uuidPath(quoteId)}`, options, {});
    if (response.status !== 200) throw this.#unexpected(response.status);
    const quote = this.#parse(quoteSchema, await this.#json(response), 200);
    this.#emitOk(started, 'getQuote', 200, null, options);
    return quote as QuoteV2Quote;
  }

  async getOperation(operationId: string, options?: CallOptions): Promise<QuoteV2Operation> {
    const started = performance.now();
    const response = await this.#call(started, 'getOperation', 'GET', `/v2/operations/${uuidPath(operationId)}`, options, {});
    if (response.status !== 200) throw this.#unexpected(response.status);
    const operation = this.#parse(operationSchema, await this.#json(response), 200);
    this.#emitOk(started, 'getOperation', 200, null, options);
    return operation;
  }

  async lookupIdempotency(idempotencyKey: string, options?: CallOptions): Promise<QuoteV2Binding | null> {
    const started = performance.now();
    assertKey(idempotencyKey);
    const response = await this.#call(started, 'lookupIdempotency', 'GET', `/v2/idempotency/current?operation=${QUOTE_V2_CREATE_OPERATION}`, options, { 'idempotency-key': idempotencyKey });
    if (response.status !== 200) throw this.#unexpected(response.status);
    const lookup = this.#parse(idempotencyLookupSchema, await this.#json(response), 200);
    this.#emitOk(started, 'lookupIdempotency', 200, null, options);
    if (lookup.state === 'not_found') return null;
    const { boundAt, requestFingerprint, quoteId, operationId, quoteStatus } = lookup.binding;
    return { boundAt, requestFingerprint, quoteId, operationId, quoteStatus };
  }

  async getDocument(quoteId: string, options?: CallOptions): Promise<QuoteV2DocumentBytes> {
    const started = performance.now();
    const response = await this.#call(started, 'getDocument', 'GET', `/v2/quotes/${uuidPath(quoteId)}/document`, options, { accept: 'application/pdf' });
    if (response.status !== 200) throw this.#unexpected(response.status);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/pdf')) throw this.#violation(started, 'getDocument', 'the document is not application/pdf', 200);
    const bytes = new Uint8Array(await this.#read(response, () => response.arrayBuffer()));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PDF_BYTES) throw this.#violation(started, 'getDocument', 'the document size is outside the contract', 200);
    const declared = response.headers.get('x-document-sha256');
    this.#emitOk(started, 'getDocument', 200, null, options);
    return { bytes, declaredSha256: declared && /^[0-9a-f]{64}$/.test(declared) ? declared : null };
  }

  /** One HTTP exchange up to the status line. Non-2xx answers are mapped to typed errors here. */
  async #call(started: number, operation: QuoteOperationName, method: 'GET' | 'POST', path: string, options: CallOptions | undefined, headers: Record<string, string>, body?: string) {
    const mutation = method === 'POST';
    const fail = (error: DomainError, httpStatus: number | null): DomainError => {
      this.#emit({ kind: 'owner_call', operation, outcome: 'failed', httpStatus, durationMs: elapsed(started), replayed: null, errorCategory: error.category, errorCode: error.code, correlationId: options?.correlationId ?? null });
      return error;
    };
    if (options?.signal?.aborted) throw fail(new DomainError('timeout', 'quote_owner_timeout', 'the caller deadline passed before the quote owner was called'), null);
    const deadline = AbortSignal.timeout(this.#config.timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const requestHeaders: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${this.#config.bearerToken}`, ...headers };
    if (options?.correlationId && /^[!-~](?:[ -~]{0,198}[!-~])?$/.test(options.correlationId)) requestHeaders['x-correlation-id'] = options.correlationId;
    let response: Awaited<ReturnType<QuoteFetch>>;
    try {
      response = await this.#fetch(`${this.#config.baseUrl}${path}`, { method, headers: requestHeaders, ...(body !== undefined ? { body } : {}), signal });
    } catch (error) {
      if (signal.aborted) throw fail(new DomainError('timeout', 'quote_owner_timeout', mutation ? 'the quote owner did not answer before the deadline; the quote may exist' : 'the quote owner did not answer before the deadline'), null);
      const code = transportCode(error);
      if (!mutation || NOT_SENT.has(code)) throw fail(new DomainError('temporarily_unavailable', 'quote_owner_unavailable', `the quote owner could not be reached (${code})`), null);
      throw fail(new DomainError('unknown_outcome', 'quote_owner_connection_lost', `the connection failed after the request may have been sent (${code})`), null);
    }
    if (response.status >= 200 && response.status < 300) return response;
    const owner = await this.#ownerError(response);
    throw fail(failureOf(response.status, owner, mutation), response.status);
  }

  async #ownerError(response: Awaited<ReturnType<QuoteFetch>>): Promise<{ code: string | null; requestId: string | null; details: Record<string, unknown> }> {
    try {
      const text = await response.text();
      const parsed = errorResponseSchema.safeParse(JSON.parse(text.slice(0, 20_000)));
      if (parsed.success) return { code: parsed.data.error.code, requestId: parsed.data.error.requestId, details: parsed.data.error.details ?? {} };
    } catch {
      // An unreadable error body is classified by status alone.
    }
    return { code: null, requestId: null, details: {} };
  }

  async #json(response: Awaited<ReturnType<QuoteFetch>>): Promise<unknown> {
    const text = await this.#read(response, () => response.text());
    if (text.length > MAX_JSON_CHARS) throw new DomainError('contract_violation', 'quote_owner_invalid_response', 'the quote owner answer exceeds the contract size', { httpStatus: response.status });
    try {
      return JSON.parse(text);
    } catch {
      throw new DomainError('contract_violation', 'quote_owner_invalid_response', 'the quote owner answer is not JSON', { httpStatus: response.status });
    }
  }

  async #read<T>(response: Awaited<ReturnType<QuoteFetch>>, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch {
      // The status line arrived (a mutation committed if it was 201/202): losing the body is a lost answer.
      throw new DomainError('unknown_outcome', 'quote_owner_connection_lost', 'the connection failed while reading the answer', { httpStatus: response.status });
    }
  }

  #parse<S extends z.ZodType>(schema: S, json: unknown, httpStatus: number): z.output<S> {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new DomainError('contract_violation', 'quote_owner_invalid_response', `the quote owner answer violates the contract at ${issue ? issue.path.join('.') || '(root)' : '(root)'}`, { httpStatus, issues: parsed.error.issues.length });
    }
    return parsed.data;
  }

  #unexpected(status: number): DomainError {
    return new DomainError('contract_violation', 'quote_owner_invalid_response', `the quote owner answered HTTP ${status}, outside its contract`, { httpStatus: status });
  }

  #violation(started: number, operation: QuoteOperationName, message: string, httpStatus: number): DomainError {
    const error = new DomainError('contract_violation', 'quote_owner_invalid_response', message, { httpStatus });
    this.#emit({ kind: 'owner_call', operation, outcome: 'failed', httpStatus, durationMs: elapsed(started), replayed: null, errorCategory: error.category, errorCode: error.code, correlationId: null });
    return error;
  }

  #emitOk(started: number, operation: QuoteOperationName, httpStatus: number, replayed: boolean | null, options: CallOptions | undefined): void {
    this.#emit({ kind: 'owner_call', operation, outcome: 'ok', httpStatus, durationMs: elapsed(started), replayed, errorCategory: null, errorCode: null, correlationId: options?.correlationId ?? null });
  }

  #emit(event: QuoteCallTelemetry): void {
    try {
      this.#onCall?.(event);
    } catch {
      // Telemetry never changes an outcome.
    }
  }
}

/** Typed owner error. `details` keeps only scalar, non-PII members the contract defines. */
export function failureOf(status: number, owner: { code: string | null; requestId: string | null; details: Record<string, unknown> }, mutation: boolean): DomainError {
  const code = owner.code ?? `http_${status}`;
  const details: Record<string, string | number | boolean | null> = { httpStatus: status, ...(owner.requestId ? { ownerRequestId: owner.requestId } : {}) };
  const expected = owner.details.expected as Record<string, unknown> | undefined;
  const computed = owner.details.computed as Record<string, unknown> | undefined;
  if (code === 'arithmetic_mismatch' && expected && computed) {
    for (const key of ['net', 'tax', 'gross'] as const) {
      if (typeof expected[key] === 'number') details[`expected_${key}`] = expected[key];
      if (typeof computed[key] === 'number') details[`computed_${key}`] = computed[key];
    }
  }
  if (typeof owner.details.boundRequestFingerprint === 'string') details.boundRequestFingerprint = owner.details.boundRequestFingerprint;
  if (status === 400 || status === 413 || status === 422) return new DomainError('validation', code, `the quote owner refused the request (${code})`, details);
  if (status === 401 || status === 403) return new DomainError('unauthorized', code, `the quote owner refused R4's credential (${code})`, details);
  if (status === 404) return new DomainError('not_found', code, `the quote owner has no such resource (${code})`, details);
  if (status === 409) return new DomainError('conflict', code, `the quote owner refused the request in its current state (${code})`, details);
  if (status === 500 || status === 503 || status === 502 || status === 504) {
    return mutation
      ? new DomainError('unknown_outcome', code, `the quote owner answered HTTP ${status}; the outcome must be reconciled by key`, details)
      : new DomainError('temporarily_unavailable', code, `the quote owner is temporarily unavailable (${code})`, details);
  }
  return new DomainError('contract_violation', 'quote_owner_invalid_response', `the quote owner answered HTTP ${status}, outside its contract`, details);
}

function assertKey(key: string): void {
  if (!/^[!-~]{1,200}$/.test(key)) throw new DomainError('validation', 'invalid_idempotency_key', 'an idempotency key is 1–200 printable ASCII characters');
}

function uuidPath(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new DomainError('validation', 'invalid_quote_reference', 'a quote or operation id is a UUID');
  return id;
}

function transportCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  const own = (error as { code?: unknown } | null)?.code;
  return typeof own === 'string' ? own : error instanceof Error ? error.name : 'error';
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
