import { performance } from 'node:perf_hooks';
import { DomainError } from '@r4-adapters/domains';
import { CUSTOMER_IDENTITY_MAX_RESPONSE_BYTES, failureOf, ownerCodeOf, pinnedIdentityContract, readBounded, type CustomerIdentityFetch } from './client.js';
import type { CustomerIdentityHttpConfig } from './config.js';

export const CIA_START_ROUTE = '/v1/identity/verifications';
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CiaStartRequest {
  readonly context: { readonly channel: string; readonly channelAccountRef: string; readonly subjectRef: string; readonly sessionRef: string };
  /** Declared by the customer: untrusted, never logged. */
  readonly email: string;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
  readonly signal?: AbortSignal;
}

export interface CiaStartChallenge {
  /** Kept by the platform (the expectation); never shown to a model. */
  readonly verificationId: string;
  readonly expiresAt: string;
  readonly resendAvailableAt: string;
}

/** One start call for telemetry: no e-mail, subject, verificationId, token or body. */
export interface CiaStartCallTelemetry {
  readonly kind: 'owner_call';
  readonly owner: 'customer-identity';
  readonly operation: 'verification_start';
  readonly outcome: 'ok' | 'failed';
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly durationMs: number;
  readonly correlationId: string | null;
}

/**
 * SEC-S5 — CIA start client (contract v1-d2 §5.1, pinned at 7525395) with the `agent` credential of
 * `r4-sales` (OA-06): `POST /v1/identity/verifications` (202 challenge_issued). The 202 is identical for
 * every well-formed e-mail (the CIA looks no account up before the code). Classification as `resolve`:
 * 400 validation, 401/403 unauthorized, 409 conflict, 429 rate_limited, 5xx temporarily_unavailable,
 * network temporarily_unavailable, deadline timeout, off-contract contract_violation. No retries here:
 * the governed write replays the same idempotency key (the CIA returns the first answer).
 */
export class CiaVerificationStartClient {
  readonly #config: CustomerIdentityHttpConfig;
  readonly #fetch: CustomerIdentityFetch;
  readonly #onCall: ((event: CiaStartCallTelemetry) => void) | undefined;

  constructor(options: { readonly config: CustomerIdentityHttpConfig; readonly fetch: CustomerIdentityFetch; readonly onCall?: (event: CiaStartCallTelemetry) => void }) {
    this.#config = options.config;
    this.#fetch = options.fetch;
    this.#onCall = options.onCall;
  }

  async start(request: CiaStartRequest): Promise<CiaStartChallenge> {
    const started = performance.now();
    let httpStatus: number | null = null;
    try {
      const challenge = await this.#start(request, (status) => (httpStatus = status));
      this.#emit('ok', httpStatus, null, started, request);
      return challenge;
    } catch (error) {
      this.#emit('failed', httpStatus, error instanceof DomainError ? error.code : 'internal_error', started, request);
      throw error;
    }
  }

  async #start(request: CiaStartRequest, onStatus: (status: number) => void): Promise<CiaStartChallenge> {
    const contract = pinnedIdentityContract();
    const body = {
      schemaVersion: 1,
      context: { ...request.context, subjectAssurance: 'provider_signed' },
      verificationPurpose: 'link_commercial_account',
      email: request.email,
      purposes: ['sales_context', 'purchase_history'],
    };
    if (!IDEMPOTENCY_KEY.test(request.idempotencyKey)) throw new DomainError('validation', 'invalid_idempotency_key', 'the start idempotency key is outside the contract grammar');
    if (!contract.validateStartRequest(body)) throw new DomainError('validation', 'invalid_start_request', 'the e-mail or the channel subject is outside the CIA start schema');
    if (request.signal?.aborted) throw new DomainError('timeout', 'deadline_exceeded', 'the caller deadline passed before the CIA was called');
    const deadline = AbortSignal.timeout(this.#config.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${this.#config.bearerToken}`,
      'idempotency-key': request.idempotencyKey,
    };
    if (request.correlationId && CORRELATION_ID.test(request.correlationId)) headers['x-correlation-id'] = request.correlationId;

    let response: Awaited<ReturnType<CustomerIdentityFetch>>;
    try {
      response = await this.#fetch(`${this.#config.baseUrl}${CIA_START_ROUTE}`, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'manual' });
    } catch {
      if (signal.aborted) throw new DomainError('timeout', 'deadline_exceeded', 'the CIA did not answer the start before the deadline');
      throw new DomainError('temporarily_unavailable', 'identity_unreachable', 'the CIA could not be reached');
    }
    onStatus(response.status);
    let text: string;
    try {
      text = await readBounded(response.body, CUSTOMER_IDENTITY_MAX_RESPONSE_BYTES, signal);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (signal.aborted) throw new DomainError('timeout', 'deadline_exceeded', 'the CIA did not finish its start answer before the deadline');
      throw new DomainError('temporarily_unavailable', 'identity_unreachable', 'the connection failed while reading the CIA start answer');
    }
    if (response.status !== 202) {
      const code = ownerCodeOf(text, contract);
      if (response.status === 409 && code === 'operation_in_progress') throw new DomainError('temporarily_unavailable', 'operation_in_progress', 'the same start is still in progress at the CIA', { httpStatus: 409, ownerCode: code });
      if (response.status === 409) throw new DomainError('conflict', code ?? 'conflict', 'the CIA refused the start (idempotency)', { httpStatus: 409, ownerCode: code });
      throw failureOf(response.status, code);
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new DomainError('contract_violation', 'invalid_response', 'the CIA start answer is not JSON');
    }
    if (!/^application\/json(\s*;|$)/i.test((response.headers.get('content-type') ?? '').trim()) || !contract.validateStartResponse(json)) {
      throw new DomainError('contract_violation', 'invalid_response', 'the CIA start answer violates the pinned schema');
    }
    const wire = json as { verificationId: string; expiresAt: string; resendAvailableAt: string };
    return { verificationId: wire.verificationId, expiresAt: wire.expiresAt, resendAvailableAt: wire.resendAvailableAt };
  }

  #emit(outcome: 'ok' | 'failed', httpStatus: number | null, errorCode: string | null, started: number, request: CiaStartRequest): void {
    try {
      this.#onCall?.({
        kind: 'owner_call', owner: 'customer-identity', operation: 'verification_start', outcome, httpStatus, errorCode,
        durationMs: Math.round(performance.now() - started), correlationId: request.correlationId && CORRELATION_ID.test(request.correlationId) ? request.correlationId : null,
      });
    } catch {
      // Telemetry never changes an outcome.
    }
  }
}
