import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  DomainError,
  type CallOptions,
  type CheckoutAttemptView,
  type CheckoutCommandResult,
  type CheckoutCreateSessionRequest,
  type CheckoutOrdersView,
  type CheckoutService,
  type CheckoutSessionView,
  type DomainErrorCategory,
} from '@r4-adapters/domains';
import type { CheckoutHttpConfig } from './config.js';

/** The subset of `fetch` the client uses (injected). */
export type CheckoutFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export type CheckoutOperationName = 'createSession' | 'getSession' | 'prepareSession' | 'createPaymentAttempt' | 'listPaymentAttempts' | 'getOrders' | 'sandboxReadiness';

/** One owner call for telemetry. Carries no token, key, consent, URL or body. */
export interface CheckoutCallTelemetry {
  readonly kind: 'owner_call';
  readonly operation: CheckoutOperationName;
  readonly outcome: 'ok' | 'failed';
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly replayed: boolean | null;
  readonly errorCategory: DomainErrorCategory | null;
  readonly errorCode: string | null;
  readonly correlationId: string | null;
}

const MAX_JSON_CHARS = 1_000_000;
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

// Tolerant objects (unknown members dropped): additive fields such as C-4 never break R4; statuses stay strings so
// the §6 mapping fails closed on values it does not know.
const money = z.object({ amountMinor: z.string().regex(/^(0|[1-9][0-9]{0,17})$/), currency: z.literal('CLP') });
const iso = z.string().min(1);
const sessionSchema = z.object({
  sessionId: z.string().regex(ID),
  status: z.string().min(1).max(64),
  statusReason: z.string().nullable(),
  quote: z.object({ quoteId: z.string(), quoteVersion: z.int().min(1), expiresAt: iso }),
  purchaseAuthorizationId: z.string().nullable(),
  amount: money,
  orderSyncStatus: z.string().min(1).max(64).nullable(),
  anomaly: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
});
const attemptSchema = z.object({
  paymentAttemptId: z.string().regex(ID),
  sessionId: z.string().regex(ID),
  ordinal: z.int().min(1),
  status: z.string().min(1).max(64),
  amount: money,
  quoteVersion: z.int().min(1),
  expiresAt: iso,
  linkExpired: z.boolean(),
  checkoutUrl: z.string().max(2048).optional(),
  lateCapture: z.boolean(),
  createdAt: iso,
  updatedAt: iso,
});
const ordersSchema = z.object({
  sessionId: z.string().regex(ID),
  orderSyncStatus: z.string().min(1).max(64),
  orders: z.array(z.object({ psOrderId: z.int().min(1), reference: z.string().min(1).max(64), totalPaid: money })),
});
// What /health/ready of the sandbox-purchase runtime must say (Checkout src/sandboxPurchase/runtime.ts readiness()).
const readinessSchema = z.object({ status: z.string(), profile: z.string(), environment: z.string(), orderDestination: z.object({ isolatedTest: z.boolean() }) });
export const CHECKOUT_SANDBOX_PROFILE = 'sandbox-purchase';
export const CHECKOUT_SANDBOX_ENVIRONMENT = 'MERCADOPAGO_SANDBOX_TEST_ONLY';
const errorSchema = z.object({ error: z.object({ code: z.string().min(1).max(80), message: z.string().max(2000), retryable: z.boolean() }) });

/**
 * Checkout HTTP client (contract R-1): the six routes of §11.1 and nothing else. Transport only: no retry of its own
 * (the platform replays the SAME key), no cancel, no query strings, no payment state. Sends `Authorization`,
 * `Idempotency-Key` on commands and `X-Correlation-Id`; parses the error envelope `{error:{code,message,retryable}}`
 * and `GET /payment-attempts` as a bare array. The DomainError `code` is always Checkout's own code.
 *
 * Classification:
 *   400 → validation; 401/403 → unauthorized; 404 → not_found; 409/422 → conflict (no effect)
 *   REQUEST_IN_PROGRESS → unknown_outcome on a command (replay the same key), temporarily_unavailable on a read
 *   5xx with retryable=false (OPERATIONAL_GATE_BLOCKED) → conflict (the gate refused before any effect)
 *   other 5xx, lost connection after send → unknown_outcome on a command; temporarily_unavailable on a read
 *   connection never opened → temporarily_unavailable; deadline → timeout
 *   anything outside the contract → contract_violation
 *
 * Sandbox isolation (D7-6, contract §11.4.6): before EVERY command the client reads the same Checkout's
 * `GET /health/ready` (no credential sent) and sends the command only when it reports status `ready`, profile
 * `sandbox-purchase`, environment `MERCADOPAGO_SANDBOX_TEST_ONLY` and an isolated-test order destination. Otherwise
 * nothing is sent: unreadable → temporarily_unavailable, anything else → conflict SANDBOX_ISOLATION_UNVERIFIED.
 */
export class CheckoutHttpClient implements CheckoutService {
  readonly bindingKind = 'http' as const;
  readonly #config: CheckoutHttpConfig;
  readonly #fetch: CheckoutFetch;
  readonly #onCall: ((event: CheckoutCallTelemetry) => void) | undefined;

  constructor(options: { readonly config: CheckoutHttpConfig; readonly fetch: CheckoutFetch; readonly onCall?: (event: CheckoutCallTelemetry) => void }) {
    this.#config = options.config;
    this.#fetch = options.fetch;
    this.#onCall = options.onCall;
  }

  async createSession(request: CheckoutCreateSessionRequest, idempotencyKey: string, options?: CallOptions): Promise<CheckoutCommandResult<CheckoutSessionView>> {
    // The body is exactly the allowlist {quoteId, quoteVersion, consent}; R4 never sends a buyer identity (§3).
    const body = JSON.stringify({ quoteId: request.quoteId, quoteVersion: request.quoteVersion, consent: { format: request.consent.format, token: request.consent.token } });
    return this.#command('createSession', '/v1/checkout/sessions', idempotencyKey, body, [200, 201], sessionSchema, options);
  }

  async getSession(sessionId: string, options?: CallOptions): Promise<CheckoutSessionView> {
    return this.#read('getSession', `/v1/checkout/sessions/${idPath(sessionId)}`, sessionSchema, options);
  }

  async prepareSession(sessionId: string, idempotencyKey: string, options?: CallOptions): Promise<CheckoutCommandResult<CheckoutSessionView>> {
    return this.#command('prepareSession', `/v1/checkout/sessions/${idPath(sessionId)}/prepare`, idempotencyKey, undefined, [202], sessionSchema, options);
  }

  async createPaymentAttempt(sessionId: string, idempotencyKey: string, options?: CallOptions): Promise<CheckoutCommandResult<CheckoutAttemptView>> {
    return this.#command('createPaymentAttempt', `/v1/checkout/sessions/${idPath(sessionId)}/payment-attempts`, idempotencyKey, undefined, [202], attemptSchema, options).then((r) => ({ ...r, view: attemptOf(r.view) }));
  }

  async listPaymentAttempts(sessionId: string, options?: CallOptions): Promise<readonly CheckoutAttemptView[]> {
    const list = await this.#read('listPaymentAttempts', `/v1/checkout/sessions/${idPath(sessionId)}/payment-attempts`, z.array(attemptSchema).max(100), options);
    return list.map(attemptOf);
  }

  async getOrders(sessionId: string, options?: CallOptions): Promise<CheckoutOrdersView> {
    return this.#read('getOrders', `/v1/checkout/sessions/${idPath(sessionId)}/orders`, ordersSchema, options);
  }

  async #command<S extends z.ZodType>(operation: CheckoutOperationName, path: string, key: string, body: string | undefined, accepted: readonly number[], schema: S, options: CallOptions | undefined): Promise<CheckoutCommandResult<z.output<S>>> {
    const started = performance.now();
    if (!KEY.test(key)) throw new DomainError('validation', 'invalid_idempotency_key', 'a Checkout Idempotency-Key is 8–128 characters of [A-Za-z0-9._:-]');
    await this.#assertSandboxIsolation(options);
    const response = await this.#call(started, operation, 'POST', path, options, { 'idempotency-key': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body);
    if (!accepted.includes(response.status)) throw this.#violation(started, operation, `Checkout answered HTTP ${response.status}, outside its contract`, response.status, options);
    const replayed = response.headers.get('idempotent-replay') === 'true';
    const view = this.#parse(started, operation, schema, await this.#json(started, operation, response, true, options), response.status, options);
    this.#emit({ kind: 'owner_call', operation, outcome: 'ok', httpStatus: response.status, durationMs: elapsed(started), replayed, errorCategory: null, errorCode: null, correlationId: options?.correlationId ?? null });
    return { httpStatus: response.status, replayed, view };
  }

  /** Fail closed: a command leaves only after this Checkout proved, just now, that it is the isolated sandbox. */
  async #assertSandboxIsolation(options: CallOptions | undefined): Promise<void> {
    const started = performance.now();
    const unverified = (category: 'temporarily_unavailable' | 'conflict', why: string, httpStatus: number | null): DomainError =>
      this.#failed(started, 'sandboxReadiness', new DomainError(category, 'SANDBOX_ISOLATION_UNVERIFIED', `Checkout sandbox isolation not proven (${why}); nothing was sent`), httpStatus, options);
    if (options?.signal?.aborted) throw unverified('temporarily_unavailable', 'caller deadline passed', null);
    const deadline = AbortSignal.timeout(this.#config.timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let status: number;
    let text: string;
    try {
      const response = await this.#fetch(`${this.#config.readinessUrl}/health/ready`, { method: 'GET', headers: { accept: 'application/json' }, signal });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw unverified('temporarily_unavailable', `readiness unreachable: ${signal.aborted ? 'timeout' : transportCode(error)}`, null);
    }
    let body: z.output<typeof readinessSchema>;
    try {
      const parsed = readinessSchema.safeParse(JSON.parse(text.slice(0, MAX_JSON_CHARS)));
      if (!parsed.success) throw new Error('shape');
      body = parsed.data;
    } catch {
      throw unverified('temporarily_unavailable', `readiness unreadable (HTTP ${status})`, status);
    }
    const ok = status === 200 && body.status === 'ready' && body.profile === CHECKOUT_SANDBOX_PROFILE && body.environment === CHECKOUT_SANDBOX_ENVIRONMENT && body.orderDestination.isolatedTest;
    if (!ok) throw unverified('conflict', `HTTP ${status}, status ${body.status.slice(0, 20)}, profile ${body.profile.slice(0, 40)}, environment ${body.environment.slice(0, 40)}, isolatedTest ${body.orderDestination.isolatedTest}`, status);
    this.#emit({ kind: 'owner_call', operation: 'sandboxReadiness', outcome: 'ok', httpStatus: status, durationMs: elapsed(started), replayed: null, errorCategory: null, errorCode: null, correlationId: options?.correlationId ?? null });
  }

  async #read<S extends z.ZodType>(operation: CheckoutOperationName, path: string, schema: S, options: CallOptions | undefined): Promise<z.output<S>> {
    const started = performance.now();
    const response = await this.#call(started, operation, 'GET', path, options, {});
    if (response.status !== 200) throw this.#violation(started, operation, `Checkout answered HTTP ${response.status}, outside its contract`, response.status, options);
    const view = this.#parse(started, operation, schema, await this.#json(started, operation, response, false, options), 200, options);
    this.#emit({ kind: 'owner_call', operation, outcome: 'ok', httpStatus: 200, durationMs: elapsed(started), replayed: null, errorCategory: null, errorCode: null, correlationId: options?.correlationId ?? null });
    return view;
  }

  async #call(started: number, operation: CheckoutOperationName, method: 'GET' | 'POST', path: string, options: CallOptions | undefined, headers: Record<string, string>, body?: string) {
    const command = method === 'POST';
    const fail = (error: DomainError, httpStatus: number | null): DomainError => {
      this.#emit({ kind: 'owner_call', operation, outcome: 'failed', httpStatus, durationMs: elapsed(started), replayed: null, errorCategory: error.category, errorCode: error.code, correlationId: options?.correlationId ?? null });
      return error;
    };
    if (options?.signal?.aborted) throw fail(new DomainError('timeout', 'checkout_timeout', 'the caller deadline passed before Checkout was called'), null);
    const deadline = AbortSignal.timeout(this.#config.timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const requestHeaders: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${this.#config.bearerToken}`, ...headers };
    if (options?.correlationId && /^[!-~]{1,200}$/.test(options.correlationId)) requestHeaders['x-correlation-id'] = options.correlationId;
    let response: Awaited<ReturnType<CheckoutFetch>>;
    try {
      response = await this.#fetch(`${this.#config.baseUrl}${path}`, { method, headers: requestHeaders, ...(body !== undefined ? { body } : {}), signal });
    } catch (error) {
      if (signal.aborted) throw fail(new DomainError('timeout', 'checkout_timeout', command ? 'Checkout did not answer before the deadline; the command may have been applied' : 'Checkout did not answer before the deadline'), null);
      const code = transportCode(error);
      if (!command || NOT_SENT.has(code)) throw fail(new DomainError('temporarily_unavailable', 'checkout_unavailable', `Checkout could not be reached (${code})`), null);
      throw fail(new DomainError('unknown_outcome', 'checkout_connection_lost', `the connection failed after the command may have been sent (${code})`), null);
    }
    if (response.status >= 200 && response.status < 300) return response;
    let owner: { code: string; retryable: boolean } | null = null;
    try {
      const parsed = errorSchema.safeParse(JSON.parse((await response.text()).slice(0, 20_000)));
      if (parsed.success) owner = { code: parsed.data.error.code, retryable: parsed.data.error.retryable };
    } catch {
      // An unreadable error body is classified by status alone.
    }
    throw fail(checkoutFailureOf(response.status, owner, command), response.status);
  }

  async #json(started: number, operation: CheckoutOperationName, response: Awaited<ReturnType<CheckoutFetch>>, command: boolean, options: CallOptions | undefined): Promise<unknown> {
    let text: string;
    try {
      text = await response.text();
    } catch {
      // The status line arrived: for a command the effect may exist; replaying the same key returns it.
      throw this.#failed(started, operation, new DomainError(command ? 'unknown_outcome' : 'temporarily_unavailable', 'checkout_connection_lost', 'the connection failed while reading the answer', { httpStatus: response.status }), response.status, options);
    }
    if (text.length > MAX_JSON_CHARS) throw this.#violation(started, operation, 'the Checkout answer exceeds the contract size', response.status, options);
    try {
      return JSON.parse(text);
    } catch {
      throw this.#violation(started, operation, 'the Checkout answer is not JSON', response.status, options);
    }
  }

  #parse<S extends z.ZodType>(started: number, operation: CheckoutOperationName, schema: S, json: unknown, httpStatus: number, options: CallOptions | undefined): z.output<S> {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw this.#violation(started, operation, `the Checkout answer violates the contract at ${issue ? issue.path.join('.') || '(root)' : '(root)'}`, httpStatus, options);
    }
    return parsed.data;
  }

  #violation(started: number, operation: CheckoutOperationName, message: string, httpStatus: number, options: CallOptions | undefined): DomainError {
    return this.#failed(started, operation, new DomainError('contract_violation', 'checkout_invalid_response', message, { httpStatus }), httpStatus, options);
  }

  #failed(started: number, operation: CheckoutOperationName, error: DomainError, httpStatus: number | null, options: CallOptions | undefined): DomainError {
    this.#emit({ kind: 'owner_call', operation, outcome: 'failed', httpStatus, durationMs: elapsed(started), replayed: null, errorCategory: error.category, errorCode: error.code, correlationId: options?.correlationId ?? null });
    return error;
  }

  #emit(event: CheckoutCallTelemetry): void {
    try {
      this.#onCall?.(event);
    } catch {
      // Telemetry never changes an outcome.
    }
  }
}

/** Checkout's error → DomainError; `code` is Checkout's code (or `http_<status>` for an unreadable body). */
export function checkoutFailureOf(status: number, owner: { readonly code: string; readonly retryable: boolean } | null, command: boolean): DomainError {
  const code = owner?.code ?? `http_${status}`;
  const details = { httpStatus: status, retryable: owner?.retryable ?? null };
  const message = `Checkout refused the call (${code})`;
  if (code === 'REQUEST_IN_PROGRESS') return new DomainError(command ? 'unknown_outcome' : 'temporarily_unavailable', code, 'the same command is still running at Checkout; replay the same key', details);
  if (status === 400) return new DomainError('validation', code, message, details);
  if (status === 401 || status === 403) return new DomainError('unauthorized', code, message, details);
  if (status === 404) return new DomainError('not_found', code, message, details);
  if (status === 409 || status === 422) return new DomainError('conflict', code, message, details);
  if (status >= 500 && status <= 599) {
    if (owner?.retryable === false) return new DomainError('conflict', code, message, details);
    return command ? new DomainError('unknown_outcome', code, `Checkout answered HTTP ${status}; replay the same key`, details) : new DomainError('temporarily_unavailable', code, message, details);
  }
  return new DomainError('contract_violation', 'checkout_invalid_response', `Checkout answered HTTP ${status}, outside its contract`, details);
}

function attemptOf(a: z.output<typeof attemptSchema>): CheckoutAttemptView {
  return { ...a, checkoutUrl: a.checkoutUrl ?? null };
}

function idPath(id: string): string {
  if (!ID.test(id)) throw new DomainError('validation', 'invalid_checkout_reference', 'a Checkout id is 1–128 characters of [A-Za-z0-9._:-]');
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
