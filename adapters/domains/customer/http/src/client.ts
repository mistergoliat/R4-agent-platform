import { performance } from 'node:perf_hooks';
import {
  CUSTOMER_REF_PATTERN,
  DomainError,
  type CallOptions,
  type CustomerAccessGrant,
  type CustomerProfilePort,
  type CustomerPurchasePage,
  type CustomerPurchasePageRequest,
  type CustomerPurpose,
  type CustomerSalesContext,
  type DomainErrorCategory,
} from '@r4-adapters/domains';
import type { CustomerProfileHttpConfig } from './config.js';
import {
  ownerCodeOf,
  readContextAnswer,
  requiredScopeOf,
  serializeRequest,
  toPurchasePage,
  toSalesContext,
  type AnswerDiagnostics,
  type WireRequest,
} from './wire.js';

/** The subset of `fetch` the client uses (injected: tests and deployments decide the transport). */
export type CustomerProfileFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null }>;

/** One owner call for telemetry. Carries no token, customerRef, grant, body or fact. */
export interface CustomerProfileCallTelemetry {
  readonly kind: 'owner_call';
  readonly owner: 'customer-profile';
  readonly purpose: CustomerPurpose;
  readonly outcome: 'ok' | 'failed';
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly errorCategory: DomainErrorCategory | null;
  readonly errorCode: string | null;
  /** The owner's flat error code or degraded statusDetail.code, when it is code-shaped. */
  readonly ownerCode: string | null;
  readonly correlationId: string | null;
  readonly diagnostics: AnswerDiagnostics | null;
  readonly cacheControlNoStore: boolean | null;
}

export const CUSTOMER_PROFILE_ROUTE = '/v1/capabilities/customer/sales-context';
/** Hard bound of an owner answer, in UTF-8 bytes on the stream (AP-07). */
export const CUSTOMER_PROFILE_MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_MAX_BYTES = 1024;
/** The R4 correlation-id shape, a subset of CP's ^[A-Za-z0-9._:-]{1,128}$ (alignment §4.6). */
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Customer Profile HTTP client (R4-J4-R2), the implementation of CustomerProfilePort over
 * `POST /v1/capabilities/customer/sales-context` (v1-rc1). Transport only: the purpose is fixed by
 * the operation, identifiers travel only in the JSON body, the service bearer token is the only
 * credential sent (the per-customer grant is not sent until D2 exists), and every answer goes
 * through wire.ts before anything reaches the port.
 *
 * Classification:
 *   200                         → answer (available / not_found / not_applicable), validated
 *   503 + valid degraded body   → temporarily_unavailable `profile_unavailable` (owner code kept)
 *   400 / 413 / 415             → validation
 *   401 / 403                   → unauthorized `profile_unauthorized` (never not_found, never retried)
 *   429                         → temporarily_unavailable `rate_limited` (no retry: maxAttempts 1)
 *   500 / 502 / 503 / 504 / 5xx → temporarily_unavailable
 *   404 / 405 / other           → contract_violation `unexpected_status`
 *   network                     → temporarily_unavailable `profile_unreachable`
 *   deadline (caller or local)  → timeout `deadline_exceeded`
 *   anything outside v1-rc1     → contract_violation (never repaired, never retried)
 */
export class CustomerProfileHttpClient implements CustomerProfilePort {
  readonly bindingKind = 'http' as const;
  readonly #config: CustomerProfileHttpConfig;
  readonly #fetch: CustomerProfileFetch;
  readonly #onCall: ((event: CustomerProfileCallTelemetry) => void) | undefined;
  readonly #now: () => Date;

  constructor(options: {
    readonly config: CustomerProfileHttpConfig;
    readonly fetch: CustomerProfileFetch;
    readonly onCall?: (event: CustomerProfileCallTelemetry) => void;
    readonly now?: () => Date;
  }) {
    this.#config = options.config;
    this.#fetch = options.fetch;
    this.#onCall = options.onCall;
    this.#now = options.now ?? (() => new Date());
  }

  async getSalesContext(customerRef: string, grant: CustomerAccessGrant, options?: CallOptions): Promise<CustomerSalesContext> {
    const { answer } = await this.#exchange({ customerRef, purpose: 'sales_context' }, grant, options);
    return toSalesContext(answer);
  }

  async getPurchaseHistory(customerRef: string, grant: CustomerAccessGrant, page: CustomerPurchasePageRequest, options?: CallOptions): Promise<CustomerPurchasePage> {
    if (!isIntegerIn(page.offset, 0, 40) || !isIntegerIn(page.limit, 1, 10)) {
      throw new DomainError('validation', 'invalid_page', 'a purchase-history page is offset 0–40 and limit 1–10');
    }
    const { answer, started, diagnostics, httpStatus, noStore } = await this.#exchange(
      { customerRef, purpose: 'purchase_history', page: { limit: page.limit, offset: page.offset } },
      grant,
      options,
      true,
    );
    try {
      const result = toPurchasePage(answer);
      this.#emit({ purpose: 'purchase_history', outcome: 'ok', httpStatus, started, error: null, ownerCode: null, options, diagnostics, noStore });
      return result;
    } catch (error) {
      if (error instanceof DomainError) this.#emit({ purpose: 'purchase_history', outcome: 'failed', httpStatus, started, error, ownerCode: ownerCodeOf(error.details.ownerReason), options, diagnostics, noStore });
      throw error;
    }
  }

  /** One validated exchange. For purchase_history the success telemetry is emitted by the caller (mapping may still fail). */
  async #exchange(request: WireRequest, grant: CustomerAccessGrant, options: CallOptions | undefined, deferOk = false) {
    const started = performance.now();
    const purpose = request.purpose;
    const fail = (error: DomainError, httpStatus: number | null, ownerCode: string | null = null, diagnostics: AnswerDiagnostics | null = null, noStore: boolean | null = null): DomainError => {
      this.#emit({ purpose, outcome: 'failed', httpStatus, started, error, ownerCode, options, diagnostics, noStore });
      return error;
    };

    // Before any network: a foreign reference or a grant that does not cover this purpose never leaves R4.
    if (!CUSTOMER_REF_PATTERN.test(request.customerRef)) throw fail(new DomainError('validation', 'foreign_customer_ref', 'the customer reference is outside the prestashop_customer namespace'), null);
    const now = this.#now();
    const expiresAt = Date.parse(grant.expiresAt);
    if (!grant.purposes.includes(purpose)) throw fail(new DomainError('validation', 'grant_purpose_not_covered', `the customer grant does not cover ${purpose}`), null);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) throw fail(new DomainError('validation', 'grant_expired', 'the customer grant has expired'), null);
    if (options?.signal?.aborted) throw fail(new DomainError('timeout', 'deadline_exceeded', 'the caller deadline passed before Customer Profile was called'), null);

    const body = serializeRequest(request);
    if (Buffer.byteLength(body, 'utf8') > REQUEST_MAX_BYTES) throw fail(new DomainError('validation', 'request_too_large', 'the Customer Profile request exceeds 1 KiB'), null);

    const deadline = AbortSignal.timeout(this.#config.timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${this.#config.bearerToken}`,
    };
    if (options?.correlationId && CORRELATION_ID.test(options.correlationId)) headers['x-correlation-id'] = options.correlationId;
    // D2 does not exist: no grant header is sent (alignment §5.3). The answer must then say service_scope_only.

    let response: Awaited<ReturnType<CustomerProfileFetch>>;
    try {
      response = await this.#fetch(`${this.#config.baseUrl}${CUSTOMER_PROFILE_ROUTE}`, { method: 'POST', headers, body, signal });
    } catch (error) {
      if (signal.aborted) throw fail(new DomainError('timeout', 'deadline_exceeded', 'Customer Profile did not answer before the deadline'), null);
      throw fail(new DomainError('temporarily_unavailable', 'profile_unreachable', `Customer Profile could not be reached (${transportCode(error)})`), null);
    }

    const httpStatus = response.status;
    const noStore = /(^|,)\s*no-store\s*(,|$)/i.test(response.headers.get('cache-control') ?? '');
    let text: string;
    try {
      text = await readBounded(response.body, CUSTOMER_PROFILE_MAX_RESPONSE_BYTES, signal);
    } catch (error) {
      if (error instanceof DomainError) throw fail(error, httpStatus, null, null, noStore);
      if (signal.aborted) throw fail(new DomainError('timeout', 'deadline_exceeded', 'Customer Profile did not finish its answer before the deadline'), httpStatus);
      throw fail(new DomainError('temporarily_unavailable', 'profile_unreachable', 'the connection failed while reading the Customer Profile answer'), httpStatus);
    }

    if (httpStatus === 200 || httpStatus === 503) {
      const json = parseJson(text, response.headers.get('content-type'));
      if (httpStatus === 503 && json === undefined) throw fail(new DomainError('temporarily_unavailable', 'profile_unavailable', 'Customer Profile is unavailable (HTTP 503)', { httpStatus }), httpStatus, null, null, noStore);
      if (json === undefined) throw fail(new DomainError('contract_violation', 'invalid_response', 'the Customer Profile answer is not JSON', { httpStatus }), httpStatus, null, null, noStore);
      let read: ReturnType<typeof readContextAnswer>;
      try {
        read = readContextAnswer(json, {
          customerRef: request.customerRef,
          purpose,
          ...(request.purpose === 'purchase_history' ? { page: request.page } : {}),
          httpStatus,
          lifecycle: this.#config.lifecycle,
          grantSent: false,
          now,
        });
      } catch (error) {
        // A 503 that is not a valid degraded envelope is still an unavailability, unless it leaks forbidden data.
        if (httpStatus === 503 && error instanceof DomainError && !['sensitive_field_present', 'purpose_minimization_violated', 'customer_ref_mismatch', 'foreign_customer_ref'].includes(error.code)) {
          throw fail(new DomainError('temporarily_unavailable', 'profile_unavailable', 'Customer Profile is unavailable (HTTP 503)', { httpStatus }), httpStatus, null, null, noStore);
        }
        if (error instanceof DomainError) throw fail(error, httpStatus, null, null, noStore);
        throw error;
      }
      if (httpStatus === 503) {
        const ownerCode = ownerCodeOf(read.diagnostics.cpStatusCode);
        throw fail(new DomainError('temporarily_unavailable', 'profile_unavailable', `Customer Profile is degraded (${ownerCode ?? 'unknown'})`, { httpStatus, ownerCode }), httpStatus, ownerCode, read.diagnostics, noStore);
      }
      if (!deferOk) this.#emit({ purpose, outcome: 'ok', httpStatus, started, error: null, ownerCode: null, options, diagnostics: read.diagnostics, noStore });
      return { answer: read.answer, started, diagnostics: read.diagnostics, httpStatus, noStore };
    }

    const owner = ownerErrorOf(text);
    throw fail(failureOf(httpStatus, owner), httpStatus, owner.code, null, noStore);
  }

  #emit(event: {
    purpose: CustomerPurpose;
    outcome: 'ok' | 'failed';
    httpStatus: number | null;
    started: number;
    error: DomainError | null;
    ownerCode: string | null;
    options: CallOptions | undefined;
    diagnostics: AnswerDiagnostics | null;
    noStore: boolean | null;
  }): void {
    try {
      this.#onCall?.({
        kind: 'owner_call',
        owner: 'customer-profile',
        purpose: event.purpose,
        outcome: event.outcome,
        httpStatus: event.httpStatus,
        durationMs: Math.round(performance.now() - event.started),
        errorCategory: event.error?.category ?? null,
        errorCode: event.error?.code ?? null,
        ownerCode: event.ownerCode,
        correlationId: event.options?.correlationId && CORRELATION_ID.test(event.options.correlationId) ? event.options.correlationId : null,
        diagnostics: event.diagnostics,
        cacheControlNoStore: event.noStore,
      });
    } catch {
      // Telemetry never changes an outcome.
    }
  }
}

/** Typed owner error from the flat body `{"error": "<code>", "requiredScope"?}` (AP-06). The category comes from the status. */
export function failureOf(status: number, owner: { readonly code: string | null; readonly requiredScope: string | null }): DomainError {
  const details: Record<string, string | number | boolean | null> = { httpStatus: status, ownerCode: owner.code };
  if (status === 400 || status === 413 || status === 415) return new DomainError('validation', owner.code ?? 'invalid_request', `Customer Profile refused the request (${owner.code ?? status})`, details);
  if (status === 401 || status === 403) {
    // requiredScope is a diagnostic, never a security authority.
    return new DomainError('unauthorized', 'profile_unauthorized', `Customer Profile refused R4's credential (HTTP ${status})`, { ...details, requiredScope: owner.requiredScope });
  }
  if (status === 429) return new DomainError('temporarily_unavailable', 'rate_limited', 'Customer Profile is rate limiting R4', details);
  if (status === 504) return new DomainError('temporarily_unavailable', owner.code ?? 'request_budget_exceeded', 'Customer Profile exceeded its request budget', details);
  if (status >= 500 && status <= 599) return new DomainError('temporarily_unavailable', owner.code ?? 'profile_unavailable', `Customer Profile is temporarily unavailable (HTTP ${status})`, details);
  return new DomainError('contract_violation', 'unexpected_status', `Customer Profile answered HTTP ${status}, outside its contract`, details);
}

function ownerErrorOf(text: string): { code: string | null; requiredScope: string | null } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const body = parsed as Record<string, unknown>;
      return { code: ownerCodeOf(body.error), requiredScope: requiredScopeOf(body.requiredScope) };
    }
  } catch {
    // An unreadable error body is classified by status alone.
  }
  return { code: null, requiredScope: null };
}

/** JSON only when the content type says so; undefined otherwise. */
function parseJson(text: string, contentType: string | null): unknown {
  if (!/^application\/json(\s*;|$)/i.test((contentType ?? '').trim())) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Reads the body as UTF-8, cutting the stream as soon as it exceeds `maxBytes` (never buffers more). */
export async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadlinePassed = () => new DomainError('timeout', 'deadline_exceeded', 'Customer Profile did not finish its answer before the deadline');
  // A stalled body must not outlive the deadline: cancelling the reader settles a pending read.
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw deadlinePassed();
      const { done, value } = await reader.read();
      if (signal.aborted) throw deadlinePassed();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DomainError('contract_violation', 'response_too_large', `the Customer Profile answer exceeds ${maxBytes} bytes`, { maxBytes });
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new DomainError('contract_violation', 'invalid_response', 'the Customer Profile answer is not UTF-8');
  }
}

function transportCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(cause.code)) return cause.code;
  return error instanceof Error ? error.name : 'error';
}

function isIntegerIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}
