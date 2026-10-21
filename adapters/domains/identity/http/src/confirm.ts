import { performance } from 'node:perf_hooks';
import { CUSTOMER_IDENTITY_MAX_RESPONSE_BYTES, ownerCodeOf, pinnedIdentityContract, readBounded, type CustomerIdentityFetch } from './client.js';
import type { CiaVerificationConfirmConfig } from './config.js';

export const CIA_CONFIRM_ROUTE = '/v1/identity/verifications/confirm';
/** A 409 operation_in_progress is retried after at most this long (plan §4.5). */
const MAX_RETRY_AFTER_MS = 30_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type CiaConfirmOutcomeValue = 'linked' | 'no_eligible_account' | 'ineligible_account' | 'ambiguous' | 'conflicted' | 'invalid_code' | 'expired' | 'locked';

/** What the gateway sends: the context comes from the binding of the expectation, identical on every retry. */
export interface CiaConfirmRequest {
  readonly context: { readonly channel: string; readonly channelAccountRef: string; readonly subjectRef: string; readonly sessionRef: string };
  readonly verificationId: string;
  /** Six ASCII digits, unsealed by the gateway for this attempt only. Never logged, never kept. */
  readonly code: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

/**
 * How one confirm attempt ended (plan §4.5). Only the dispatcher decides what follows:
 *   outcome  the CIA consumed (or rejected) the attempt;
 *   retry    nothing definitive: same key, same body, later (409 in progress, 429, 5xx, timeout, network);
 *   refused  definitive refusal of the request itself (400, 401, 403, 409 idempotency_conflict, off-contract answer).
 */
export type CiaConfirmAnswer =
  | { readonly kind: 'outcome'; readonly outcome: CiaConfirmOutcomeValue; readonly attemptsRemaining?: number }
  | { readonly kind: 'retry'; readonly code: string; readonly retryAfterMs: number | null }
  | { readonly kind: 'refused'; readonly code: string; readonly credentialRejected: boolean };

/** One confirm call for telemetry: no code, verificationId, subject, token or body. */
export interface CiaConfirmCallTelemetry {
  readonly kind: 'owner_call';
  readonly owner: 'customer-identity';
  readonly operation: 'verification_confirm';
  readonly answer: CiaConfirmAnswer['kind'];
  readonly outcome: CiaConfirmOutcomeValue | null;
  readonly code: string | null;
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly correlationId: string | null;
}

/**
 * SEC-S4 — CIA confirm client (contract v1-d2 §5.2, pinned at 7525395) with the channel-integration
 * credential. Transport and classification only: one attempt per call, `redirect: 'manual'`, 3 s
 * deadline, 16 KiB cap, closed validation of the request and the answer. It holds the code only for
 * the duration of the call and never puts it in an error, a log or the telemetry.
 */
export class CiaVerificationConfirmClient {
  readonly #config: CiaVerificationConfirmConfig;
  readonly #fetch: CustomerIdentityFetch;
  readonly #onCall: ((event: CiaConfirmCallTelemetry) => void) | undefined;

  constructor(options: { readonly config: CiaVerificationConfirmConfig; readonly fetch: CustomerIdentityFetch; readonly onCall?: (event: CiaConfirmCallTelemetry) => void }) {
    this.#config = options.config;
    this.#fetch = options.fetch;
    this.#onCall = options.onCall;
  }

  async confirm(request: CiaConfirmRequest): Promise<CiaConfirmAnswer> {
    const started = performance.now();
    let httpStatus: number | null = null;
    const answer = await this.#confirm(request, (status) => (httpStatus = status));
    try {
      this.#onCall?.({
        kind: 'owner_call', owner: 'customer-identity', operation: 'verification_confirm', answer: answer.kind,
        outcome: answer.kind === 'outcome' ? answer.outcome : null, code: answer.kind === 'outcome' ? null : answer.code,
        httpStatus, durationMs: Math.round(performance.now() - started), correlationId: CORRELATION_ID.test(request.correlationId) ? request.correlationId : null,
      });
    } catch {
      // Telemetry never changes an outcome.
    }
    return answer;
  }

  async #confirm(request: CiaConfirmRequest, onStatus: (status: number) => void): Promise<CiaConfirmAnswer> {
    const contract = pinnedIdentityContract();
    const body = {
      schemaVersion: 1,
      context: { ...request.context, subjectAssurance: 'provider_signed' },
      verificationId: request.verificationId,
      code: request.code,
    };
    if (!IDEMPOTENCY_KEY.test(request.idempotencyKey) || !contract.validateConfirmRequest(body)) return { kind: 'refused', code: 'invalid_request', credentialRejected: false };
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${this.#config.bearerToken}`,
      'idempotency-key': request.idempotencyKey,
    };
    if (CORRELATION_ID.test(request.correlationId)) headers['x-correlation-id'] = request.correlationId;
    const signal = AbortSignal.timeout(this.#config.timeoutMs);

    let response: Awaited<ReturnType<CustomerIdentityFetch>>;
    try {
      response = await this.#fetch(`${this.#config.baseUrl}${CIA_CONFIRM_ROUTE}`, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'manual' });
    } catch {
      return { kind: 'retry', code: signal.aborted ? 'deadline_exceeded' : 'identity_unreachable', retryAfterMs: null };
    }
    onStatus(response.status);
    let text: string;
    try {
      text = await readBounded(response.body, CUSTOMER_IDENTITY_MAX_RESPONSE_BYTES, signal);
    } catch {
      // The CIA may have applied the attempt: retrying with the same key returns its stored answer (I06).
      return { kind: 'retry', code: signal.aborted ? 'deadline_exceeded' : 'identity_unreachable', retryAfterMs: null };
    }

    const status = response.status;
    if (status === 200) {
      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        return { kind: 'refused', code: 'invalid_response', credentialRejected: false };
      }
      if (!/^application\/json(\s*;|$)/i.test((response.headers.get('content-type') ?? '').trim()) || !contract.validateConfirmResponse(json)) {
        return { kind: 'refused', code: 'invalid_response', credentialRejected: false };
      }
      const wire = json as { outcome: CiaConfirmOutcomeValue; attemptsRemaining?: number };
      return wire.outcome === 'invalid_code' ? { kind: 'outcome', outcome: wire.outcome, attemptsRemaining: wire.attemptsRemaining ?? 0 } : { kind: 'outcome', outcome: wire.outcome };
    }
    const ownerCode = ownerCodeOf(text, contract);
    if (status === 409 && ownerCode === 'operation_in_progress') return { kind: 'retry', code: 'operation_in_progress', retryAfterMs: retryAfterOf(response.headers.get('retry-after')) };
    if (status === 429) return { kind: 'retry', code: 'rate_limited', retryAfterMs: retryAfterOf(response.headers.get('retry-after')) };
    if (status >= 500 && status <= 599) return { kind: 'retry', code: ownerCode ?? 'identity_unavailable', retryAfterMs: null };
    if (status === 401 || status === 403) return { kind: 'refused', code: 'identity_unauthorized', credentialRejected: true };
    if (status === 400 || status === 409) return { kind: 'refused', code: ownerCode ?? (status === 400 ? 'invalid_request' : 'conflict'), credentialRejected: false };
    return { kind: 'refused', code: 'unexpected_status', credentialRejected: false };
  }
}

/** `Retry-After` in seconds (the CIA form), capped; anything else is ignored. */
function retryAfterOf(header: string | null): number | null {
  if (header === null || !/^\d{1,4}$/.test(header.trim())) return null;
  return Math.min(Number(header.trim()) * 1000, MAX_RETRY_AFTER_MS);
}
