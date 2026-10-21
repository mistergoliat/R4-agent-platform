import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import {
  CUSTOMER_PURPOSES,
  CUSTOMER_REF_PATTERN,
  DomainError,
  isSyntheticCustomerRef,
  type CallOptions,
  type ChannelSubject,
  type CustomerIdentityResolver,
  type CustomerPurpose,
  type DomainErrorCategory,
  type IdentityResolution,
} from '@r4-adapters/domains';
import type { CustomerIdentityHttpConfig } from './config.js';

/** The subset of `fetch` the client uses (injected). `redirect: 'manual'`: a 3xx is never followed. */
export type CustomerIdentityFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'manual' },
) => Promise<{ status: number; headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null }>;

/** One owner call for telemetry. Carries no token, subject, customerRef, grant or body. */
export interface CustomerIdentityCallTelemetry {
  readonly kind: 'owner_call';
  readonly owner: 'customer-identity';
  readonly operation: 'resolve';
  readonly purposes: readonly CustomerPurpose[];
  readonly outcome: 'ok' | 'failed';
  /** The resolution status (verified, not_linked, …) of an accepted answer. */
  readonly resolutionStatus: IdentityResolution['status'] | null;
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly errorCategory: DomainErrorCategory | null;
  readonly errorCode: string | null;
  readonly ownerCode: string | null;
  readonly correlationId: string | null;
}

export const CUSTOMER_IDENTITY_ROUTE = '/v1/identity/resolve';
/** Hard bound of a CIA answer, UTF-8 bytes on the stream (specification R4-J4-R1 §8). */
export const CUSTOMER_IDENTITY_MAX_RESPONSE_BYTES = 16 * 1024;
/** Maximum grant lifetime (CIA v1-d2 §6.1, 300 s) plus the 60 s issuer skew it tolerates. */
const MAX_GRANT_AHEAD_MS = 360_000;
const FUTURE_SKEW_MS = 5 * 60_000;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTRACT_DIR = new URL('../contract/', import.meta.url);

// ---------------------------------------------------------------------------------------------
// Pinned contract (CIA v1-d2 @ 7525395, hash-checked on load)
// ---------------------------------------------------------------------------------------------

export class CustomerIdentityContractPinError extends Error {
  override readonly name = 'CustomerIdentityContractPinError';
}

export interface PinnedIdentityContract {
  readonly ownerCommit: string;
  readonly revision: string;
  readonly validateRequest: ValidateFunction;
  readonly validateResponse: ValidateFunction;
  readonly validateError: ValidateFunction;
  /** SEC-S4: POST /v1/identity/verifications/confirm. */
  readonly validateConfirmRequest: ValidateFunction;
  readonly validateConfirmResponse: ValidateFunction;
  /** SEC-S5: POST /v1/identity/verifications. */
  readonly validateStartRequest: ValidateFunction;
  readonly validateStartResponse: ValidateFunction;
}

const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv2020) => Ajv2020;
let pinned: PinnedIdentityContract | undefined;

/** Loads the copied CIA schemas once, refusing any byte that differs from contract/SOURCE.json. */
export function pinnedIdentityContract(): PinnedIdentityContract {
  if (pinned) return pinned;
  const source = JSON.parse(readFileSync(new URL('SOURCE.json', CONTRACT_DIR), 'utf8')) as {
    ownerCommit: string;
    revision: string;
    files: readonly { file: string; sha256: string }[];
  };
  const load = (file: string): { $id: string } => {
    const bytes = Buffer.from(readFileSync(new URL(file, CONTRACT_DIR), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
    const expected = source.files.find((entry) => entry.file === file)?.sha256;
    if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) {
      throw new CustomerIdentityContractPinError(`contract/${file} does not match the pinned CIA copy (${source.ownerCommit})`);
    }
    return JSON.parse(bytes.toString('utf8')) as { $id: string };
  };
  const ajv = addFormats(new Ajv2020({ strict: true, strictTypes: false, allErrors: false }));
  ajv.addSchema(load('schemas/cia-common.v1.schema.json'));
  const resolve = load('schemas/resolve.v1.schema.json');
  const error = load('schemas/error.v1.schema.json');
  const confirm = load('schemas/verification-confirm.v1.schema.json');
  ajv.addSchema(resolve);
  ajv.addSchema(error);
  const start = load('schemas/verification-start.v1.schema.json');
  ajv.addSchema(confirm);
  ajv.addSchema(start);
  const validateRequest = ajv.getSchema(`${resolve.$id}#/$defs/request`);
  const validateResponse = ajv.getSchema(`${resolve.$id}#/$defs/response`);
  const validateError = ajv.getSchema(error.$id);
  const validateConfirmRequest = ajv.getSchema(`${confirm.$id}#/$defs/request`);
  const validateConfirmResponse = ajv.getSchema(`${confirm.$id}#/$defs/response`);
  const validateStartRequest = ajv.getSchema(`${start.$id}#/$defs/request`);
  const validateStartResponse = ajv.getSchema(`${start.$id}#/$defs/response`);
  if (!validateRequest || !validateResponse || !validateError || !validateConfirmRequest || !validateConfirmResponse || !validateStartRequest || !validateStartResponse) {
    throw new CustomerIdentityContractPinError('the pinned CIA schemas did not compile');
  }
  pinned = { ownerCommit: source.ownerCommit, revision: source.revision, validateRequest, validateResponse, validateError, validateConfirmRequest, validateConfirmResponse, validateStartRequest, validateStartResponse };
  return pinned;
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

type WireResolution =
  | { schemaVersion: 1; status: 'verified'; customerRef: string; grant: { token: string; expiresAt: string; purposes: string[] }; resolvedAt: string }
  | { schemaVersion: 1; status: Exclude<IdentityResolution['status'], 'verified'>; resolvedAt: string };

const violation = (code: string, message: string, details: Readonly<Record<string, string | number | boolean | null>> = {}) =>
  new DomainError('contract_violation', code, message, details);

/**
 * CIA HTTP client (R4-J4-R3): the CustomerIdentityResolver over `POST /v1/identity/resolve`,
 * contract CIA v1-d2 (§5.3, §7). Transport only. The subject travels in the JSON body only, the
 * agent bearer is the only credential, and every answer is validated against the pinned schema
 * (closed) before it becomes an IdentityResolution. The grant stays opaque: R4 checks its
 * transport shape, `expiresAt` and `purposes`, and never decodes the token.
 *
 * Classification (no retries):
 *   200                → resolution, validated (only `verified` carries customerRef and grant)
 *   400                → validation
 *   401 / 403          → unauthorized `identity_unauthorized`
 *   429                → temporarily_unavailable `rate_limited`
 *   5xx                → temporarily_unavailable (owner code kept, e.g. dependency_unavailable)
 *   3xx / 404 / other  → contract_violation `unexpected_status` (a redirect is never followed)
 *   network            → temporarily_unavailable `identity_unreachable`
 *   deadline / abort   → timeout `deadline_exceeded`
 *   anything outside the contract → contract_violation (never repaired)
 */
export class CustomerIdentityHttpClient implements CustomerIdentityResolver {
  readonly bindingKind = 'http' as const;
  readonly #config: CustomerIdentityHttpConfig;
  readonly #fetch: CustomerIdentityFetch;
  readonly #onCall: ((event: CustomerIdentityCallTelemetry) => void) | undefined;
  readonly #now: () => Date;

  constructor(options: {
    readonly config: CustomerIdentityHttpConfig;
    readonly fetch: CustomerIdentityFetch;
    readonly onCall?: (event: CustomerIdentityCallTelemetry) => void;
    readonly now?: () => Date;
  }) {
    this.#config = options.config;
    this.#fetch = options.fetch;
    this.#onCall = options.onCall;
    this.#now = options.now ?? (() => new Date());
  }

  async resolve(subject: ChannelSubject, purposes: readonly CustomerPurpose[], options?: CallOptions): Promise<IdentityResolution> {
    const started = performance.now();
    let httpStatus: number | null = null;
    let ownerCode: string | null = null;
    try {
      const resolution = await this.#resolve(subject, purposes, options, (status) => (httpStatus = status), (code) => (ownerCode = code));
      this.#emit(purposes, 'ok', resolution.status, httpStatus, started, null, null, options);
      return resolution;
    } catch (error) {
      if (error instanceof DomainError) this.#emit(purposes, 'failed', null, httpStatus, started, error, ownerCode, options);
      throw error;
    }
  }

  async #resolve(
    subject: ChannelSubject,
    purposes: readonly CustomerPurpose[],
    options: CallOptions | undefined,
    onStatus: (status: number) => void,
    onOwnerCode: (code: string | null) => void,
  ): Promise<IdentityResolution> {
    const contract = pinnedIdentityContract();
    const requested = [...purposes];
    if (requested.length === 0 || new Set(requested).size !== requested.length || !requested.every((p) => (CUSTOMER_PURPOSES as readonly string[]).includes(p))) {
      throw new DomainError('validation', 'invalid_purposes', 'the purposes must be distinct customer purposes');
    }
    // The subject as the CIA expects it: an authenticated channel event (provider-signed ingress).
    const body = {
      schemaVersion: 1,
      context: { channel: subject.channel, channelAccountRef: subject.accountRef, subjectRef: subject.subjectRef, sessionRef: subject.sessionRef, subjectAssurance: 'provider_signed' },
      purposes: requested,
    };
    if (!contract.validateRequest(body)) throw new DomainError('validation', 'invalid_subject', 'the channel subject is outside the CIA request schema');
    if (options?.signal?.aborted) throw new DomainError('timeout', 'deadline_exceeded', 'the caller deadline passed before the CIA was called');

    const deadline = AbortSignal.timeout(this.#config.timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${this.#config.bearerToken}`,
    };
    if (options?.correlationId && CORRELATION_ID.test(options.correlationId)) headers['x-correlation-id'] = options.correlationId;

    let response: Awaited<ReturnType<CustomerIdentityFetch>>;
    try {
      response = await this.#fetch(`${this.#config.baseUrl}${CUSTOMER_IDENTITY_ROUTE}`, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'manual' });
    } catch {
      if (signal.aborted) throw new DomainError('timeout', 'deadline_exceeded', 'the CIA did not answer before the deadline');
      throw new DomainError('temporarily_unavailable', 'identity_unreachable', 'the CIA could not be reached');
    }
    onStatus(response.status);

    let text: string;
    try {
      text = await readBounded(response.body, CUSTOMER_IDENTITY_MAX_RESPONSE_BYTES, signal);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (signal.aborted) throw new DomainError('timeout', 'deadline_exceeded', 'the CIA did not finish its answer before the deadline');
      throw new DomainError('temporarily_unavailable', 'identity_unreachable', 'the connection failed while reading the CIA answer');
    }

    if (response.status !== 200) {
      const code = ownerCodeOf(text, contract);
      onOwnerCode(code);
      throw failureOf(response.status, code);
    }
    if (!/^application\/json(\s*;|$)/i.test((response.headers.get('content-type') ?? '').trim())) throw violation('invalid_response', 'the CIA answer is not JSON');
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw violation('invalid_response', 'the CIA answer is not JSON');
    }
    if (!contract.validateResponse(json)) {
      const first = contract.validateResponse.errors?.[0];
      throw violation('invalid_response', 'the CIA answer violates the pinned resolve schema', { schemaPath: safePath(first?.instancePath || '/'), keyword: first?.keyword ?? null });
    }
    return this.#toResolution(json as WireResolution, requested);
  }

  #toResolution(wire: WireResolution, requested: readonly CustomerPurpose[]): IdentityResolution {
    const now = this.#now().getTime();
    if (Date.parse(wire.resolvedAt) > now + FUTURE_SKEW_MS) throw violation('freshness_incoherent', 'the CIA answer is dated in the future');
    if (wire.status !== 'verified') return { status: wire.status, resolvedAt: wire.resolvedAt };

    if (!CUSTOMER_REF_PATTERN.test(wire.customerRef)) throw violation('foreign_customer_ref', 'the CIA resolved a customer reference outside the prestashop_customer namespace');
    if (this.#config.lifecycle === 'synthetic' && !isSyntheticCustomerRef(wire.customerRef)) {
      throw violation('customer_ref_outside_synthetic_range', 'a synthetic binding resolved a customer outside the synthetic id range');
    }
    // The grant covers exactly the purposes asked (CIA §5.3) and lives within the contract's TTL.
    const granted = new Set(wire.grant.purposes);
    const expiresAt = Date.parse(wire.grant.expiresAt);
    if (granted.size !== requested.length || !requested.every((purpose) => granted.has(purpose))) throw violation('incoherent_grant', 'the grant does not cover exactly the purposes asked');
    if (!(expiresAt > now) || expiresAt > now + MAX_GRANT_AHEAD_MS) throw violation('incoherent_grant', 'the grant is expired or outlives the contract TTL');
    return {
      status: 'verified',
      customerRef: wire.customerRef,
      grant: { token: wire.grant.token, expiresAt: wire.grant.expiresAt, purposes: [...requested] },
      resolvedAt: wire.resolvedAt,
    };
  }

  #emit(
    purposes: readonly CustomerPurpose[],
    outcome: 'ok' | 'failed',
    resolutionStatus: IdentityResolution['status'] | null,
    httpStatus: number | null,
    started: number,
    error: DomainError | null,
    ownerCode: string | null,
    options: CallOptions | undefined,
  ): void {
    try {
      this.#onCall?.({
        kind: 'owner_call',
        owner: 'customer-identity',
        operation: 'resolve',
        purposes: [...purposes],
        outcome,
        resolutionStatus,
        httpStatus,
        durationMs: Math.round(performance.now() - started),
        errorCategory: error?.category ?? null,
        errorCode: error?.code ?? null,
        ownerCode,
        correlationId: options?.correlationId && CORRELATION_ID.test(options.correlationId) ? options.correlationId : null,
      });
    } catch {
      // Telemetry never changes an outcome.
    }
  }
}

/** Category from the HTTP status; the owner code (validated) is a diagnostic only. */
export function failureOf(status: number, ownerCode: string | null): DomainError {
  const details = { httpStatus: status, ownerCode };
  if (status === 400) return new DomainError('validation', ownerCode ?? 'invalid_request', 'the CIA refused the request', details);
  if (status === 401 || status === 403) return new DomainError('unauthorized', 'identity_unauthorized', `the CIA refused R4's credential (HTTP ${status})`, details);
  if (status === 429) return new DomainError('temporarily_unavailable', 'rate_limited', 'the CIA is rate limiting R4', details);
  if (status >= 500 && status <= 599) return new DomainError('temporarily_unavailable', ownerCode ?? 'identity_unavailable', `the CIA is temporarily unavailable (HTTP ${status})`, details);
  return violation('unexpected_status', `the CIA answered HTTP ${status}, outside its contract`, details);
}

export function ownerCodeOf(text: string, contract: PinnedIdentityContract): string | null {
  try {
    const body = JSON.parse(text) as unknown;
    return contract.validateError(body) ? (body as { error: { code: string } }).error.code : null;
  } catch {
    return null;
  }
}

function safePath(path: string): string {
  return path.replace(/[^A-Za-z0-9_.[\]/]/g, '?').slice(0, 120);
}

/** Reads the body as UTF-8, cutting the stream as soon as it exceeds `maxBytes`; a stalled body ends at the deadline. */
export async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadlinePassed = () => new DomainError('timeout', 'deadline_exceeded', 'the CIA did not finish its answer before the deadline');
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
        throw violation('response_too_large', `the CIA answer exceeds ${maxBytes} bytes`, { maxBytes });
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
    throw violation('invalid_response', 'the CIA answer is not UTF-8');
  }
}
