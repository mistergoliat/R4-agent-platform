import { performance } from 'node:perf_hooks';
import {
  CATALOG_DISCOVER_MAX_KEYS,
  CATALOG_DISCOVER_MAX_LIMIT,
  CATALOG_DISCOVER_MAX_NEED_CHARS,
  CATALOG_DISCOVER_SCHEMA_VERSION,
  CatalogDiscoverError,
  type CallOptions,
  type CatalogDiscoverAnswer,
  type CatalogDiscoverFailure,
  type CatalogDiscoverPort,
  type CatalogDiscoverRequest,
} from '@r4-adapters/domains';
import { CatalogConfigError, loadCatalogHttpConfig, type CatalogHttpConfig } from './config.js';
import { catalogDiscoverAnswerSchema, type CatalogDiscoverWireRequest } from './discover-schemas.js';
import { catalogKeySchema } from './schemas.js';

/** `fetch` subset for Discover: like CatalogFetch, plus response headers (Retry-After on saturation). */
export type CatalogDiscoverFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

export const CATALOG_DISCOVER_ROUTE = '/v2/catalog/discover';

/**
 * Discover configuration, explicit and fail-closed. Discover is OFF unless
 * R4_CATALOG_DISCOVER_ENABLED=true (non-production integration, I1):
 *
 *   R4_CATALOG_DISCOVER_ENABLED     false (default) | true
 *   R4_CATALOG_DISCOVER_API_KEY     optional: a key the owner lists in CATALOG_DISCOVER_API_KEYS;
 *                                   defaults to R4_CATALOG_API_KEY (which must then be listed)
 *   R4_CATALOG_DISCOVER_TIMEOUT_MS  per-call deadline, 1000–10000 ms, default 4500
 *                                   (owner worst case ≈ 250 ms admission + 2 × 1500 ms owner batches + CPU;
 *                                   provisional: no MariaDB measurement backs the owner's bounds)
 * Base URL and network rules are the Catalog adapter's (R4_CATALOG_BASE_URL, R4_PROD_ALLOW_NETWORK).
 */
export const CATALOG_DISCOVER_DEFAULT_TIMEOUT_MS = 4_500;

export function loadCatalogDiscoverConfig(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean }): CatalogHttpConfig | null {
  if ((env.R4_CATALOG_DISCOVER_ENABLED ?? '').trim().toLowerCase() !== 'true') return null;
  const discoverKey = env.R4_CATALOG_DISCOVER_API_KEY?.trim();
  const rawTimeout = env.R4_CATALOG_DISCOVER_TIMEOUT_MS?.trim() || String(CATALOG_DISCOVER_DEFAULT_TIMEOUT_MS);
  const timeoutMs = /^\d{1,6}$/.test(rawTimeout) ? Number(rawTimeout) : Number.NaN;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10_000) throw new CatalogConfigError('invalid_catalog_config', 'R4_CATALOG_DISCOVER_TIMEOUT_MS must be an integer between 1000 and 10000');
  // The base check (URL, network, key length) is the Catalog adapter's; Discover only swaps key and deadline.
  const base = loadCatalogHttpConfig({ ...env, ...(discoverKey ? { R4_CATALOG_API_KEY: discoverKey } : {}), R4_CATALOG_TIMEOUT_MS: String(timeoutMs) }, options);
  return base;
}

/** One call's outcome for telemetry: no need text, no keys, no API key. */
export interface CatalogDiscoverTelemetry {
  readonly operation: 'discover';
  readonly outcome: 'ok' | 'failed';
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly answerStatus: CatalogDiscoverAnswer['status'] | null;
  readonly failure: CatalogDiscoverFailure | null;
  readonly errorCode: string | null;
  readonly correlationId: string | null;
  readonly needLength: number;
}

const MAX_RESPONSE_CHARS = 256_000;
const CORRELATION = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * HTTP adapter of catalog.discover (R4-DISCOVER-I1) against the owner's
 * internal route POST /v2/catalog/discover (CAT-DISCOVER-V1-B1). Transport
 * only: no semantic rule, no retry, no repair.
 *
 * Failure mapping (owner matrix, V1-B1 §F):
 *   400 / 413 / 415                       → INVALID_REQUEST (owner issue codes kept: code@path, never values)
 *   401 / 403                             → AUTH_FAILED (403 = key not in the owner's Discover allowlist)
 *   429                                   → RATE_LIMITED (retryable)
 *   503 capability_disabled               → DISABLED (not retryable)
 *   503 capability_not_ready / index_incompatible / capability_shutting_down / request_cancelled
 *                                         → NOT_READY (retryability = the owner's)
 *   503 capability_saturated              → SATURATED (retryable after Retry-After; never retried here)
 *   500 / other 5xx                       → SERVICE_ERROR (retryability = the owner's; 500 is terminal)
 *   network failure                       → UNREACHABLE; local deadline → TIMEOUT
 *   200 that is not JSON, not schemaVersion 1, FAILED, or violates the contract → CONTRACT_VIOLATION
 * A 200 COMPLETE / PARTIAL / DEGRADED is an ANSWER, never an error: the caller
 * must read status, completeness, degradation and each candidate's commercial state.
 */
export class HttpCatalogDiscoverAdapter implements CatalogDiscoverPort {
  readonly bindingKind = 'http' as const;
  readonly #config: CatalogHttpConfig;
  readonly #fetch: CatalogDiscoverFetch;
  readonly #onCall: ((event: CatalogDiscoverTelemetry) => void) | undefined;

  constructor(options: { readonly config: CatalogHttpConfig; readonly fetch: CatalogDiscoverFetch; readonly onCall?: (event: CatalogDiscoverTelemetry) => void }) {
    this.#config = options.config;
    this.#fetch = options.fetch;
    this.#onCall = options.onCall;
  }

  async discover(request: CatalogDiscoverRequest, options?: CallOptions): Promise<CatalogDiscoverAnswer> {
    const started = performance.now();
    const correlationId = options?.correlationId ?? null;
    const needLength = request.need.trim().length;
    let httpStatus: number | null = null;
    try {
      const body = JSON.stringify(wireRequest(request, correlationId));
      if (options?.signal?.aborted) throw new CatalogDiscoverError('TIMEOUT', 'deadline_exceeded', 'the caller deadline passed before catalog.discover was called', { retryable: true });
      const deadline = AbortSignal.timeout(this.#config.timeoutMs);
      const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': this.#config.apiKey };
      if (correlationId) headers['x-correlation-id'] = correlationId;
      let text: string;
      let retryAfter: string | null = null;
      try {
        const response = await this.#fetch(`${this.#config.baseUrl}${CATALOG_DISCOVER_ROUTE}`, { method: 'POST', headers, body, signal });
        httpStatus = response.status;
        retryAfter = response.headers?.get('retry-after') ?? null;
        text = await response.text();
      } catch (error) {
        if (signal.aborted) throw new CatalogDiscoverError('TIMEOUT', 'deadline_exceeded', 'catalog.discover did not answer before the deadline', { retryable: true });
        throw new CatalogDiscoverError('UNREACHABLE', 'catalog_unreachable', `catalog.discover could not be reached (${error instanceof Error ? error.name : 'error'})`, { retryable: true });
      }
      if (httpStatus !== 200) throw failureOf(httpStatus, text, retryAfter);
      const answer = parseAnswer(text);
      this.#emit({ operation: 'discover', outcome: 'ok', httpStatus, durationMs: elapsed(started), answerStatus: answer.status, failure: null, errorCode: null, correlationId, needLength });
      return answer;
    } catch (error) {
      if (error instanceof CatalogDiscoverError) this.#emit({ operation: 'discover', outcome: 'failed', httpStatus, durationMs: elapsed(started), answerStatus: null, failure: error.failure, errorCode: error.code, correlationId, needLength });
      throw error;
    }
  }

  #emit(event: CatalogDiscoverTelemetry): void {
    try {
      this.#onCall?.(event);
    } catch {
      // Telemetry never changes the outcome of a read.
    }
  }
}

/** Local bounds the owner would reject anyway (cheaper and never sent): structure only, never meaning. */
function wireRequest(request: CatalogDiscoverRequest, correlationId: string | null): CatalogDiscoverWireRequest {
  const invalid = (code: string, message: string) => new CatalogDiscoverError('INVALID_REQUEST', code, message, { retryable: false });
  const need = request.need.trim();
  if (need.length < 1 || need.length > CATALOG_DISCOVER_MAX_NEED_CHARS) throw invalid('need_out_of_bounds', `need must have 1 to ${CATALOG_DISCOVER_MAX_NEED_CHARS} characters`);
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > CATALOG_DISCOVER_MAX_LIMIT)) throw invalid('limit_out_of_range', `limit must be an integer 1..${CATALOG_DISCOVER_MAX_LIMIT}`);
  for (const [name, list] of [['productKeys', request.productKeys], ['selectedItemKeys', request.selectedItemKeys]] as const) {
    if (list === undefined) continue;
    if (list.length > CATALOG_DISCOVER_MAX_KEYS) throw invalid('too_many_keys', `${name} holds at most ${CATALOG_DISCOVER_MAX_KEYS} keys`);
    if (list.some((key) => !catalogKeySchema.safeParse(key).success)) throw invalid('invalid_key', `${name} holds a value that is not a catalog key`);
  }
  const constraints = Object.fromEntries(Object.entries(request.constraints ?? {}).filter(([, value]) => value !== undefined)) as Record<string, number | boolean>;
  return {
    schemaVersion: CATALOG_DISCOVER_SCHEMA_VERSION,
    need,
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
    ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
    ...(request.productKeys && request.productKeys.length > 0 ? { hints: { productKeys: [...request.productKeys] } } : {}),
    ...(request.selectedItemKeys && request.selectedItemKeys.length > 0 ? { selectedItemKeys: [...request.selectedItemKeys] } : {}),
    ...(correlationId && CORRELATION.test(correlationId) ? { context: { correlationId } } : {}),
  };
}

function parseAnswer(text: string): CatalogDiscoverAnswer {
  const violation = (code: string, message: string) => new CatalogDiscoverError('CONTRACT_VIOLATION', code, message, { retryable: false, httpStatus: 200 });
  if (text.length > MAX_RESPONSE_CHARS) throw violation('response_too_large', 'the catalog.discover answer exceeds the contract size');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw violation('unparseable_response', 'the catalog.discover answer is not JSON');
  }
  const body = json as { schemaVersion?: unknown; status?: unknown } | null;
  if (body?.schemaVersion !== CATALOG_DISCOVER_SCHEMA_VERSION) throw violation('unsupported_schema_version', `catalog.discover answered schemaVersion ${typeof body?.schemaVersion === 'number' ? body.schemaVersion : 'missing'}; R4 speaks ${CATALOG_DISCOVER_SCHEMA_VERSION}`);
  if (body.status === 'FAILED') throw violation('failed_answer_as_200', 'catalog.discover sent a FAILED answer with HTTP 200 (terminal failures are never 200)');
  const parsed = catalogDiscoverAnswerSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw violation('invalid_response', `the catalog.discover answer violates the contract at ${issue ? issue.path.join('.') || '(root)' : '(root)'}`);
  }
  const { schemaVersion: _, ...answer } = parsed.data;
  return answer;
}

interface OwnerError {
  readonly code: string | null;
  readonly retryable: boolean | null;
  readonly issues: string | null;
}

function ownerError(text: string): OwnerError {
  try {
    const error = (JSON.parse(text) as { error?: { code?: unknown; retryable?: unknown; issues?: unknown } } | null)?.error;
    const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : null;
    const issues = Array.isArray(error?.issues)
      ? error.issues
          .flatMap((i: { code?: unknown; path?: unknown }) => (typeof i.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(i.code) ? [`${i.code}@${typeof i.path === 'string' ? i.path.replace(/[^A-Za-z0-9_.[\]-]/g, '').slice(0, 64) : ''}`] : []))
          .slice(0, 16)
          .join(',')
      : null;
    return { code, retryable: typeof error?.retryable === 'boolean' ? error.retryable : null, issues: issues || null };
  } catch {
    return { code: null, retryable: null, issues: null };
  }
}

function failureOf(status: number, text: string, retryAfter: string | null): CatalogDiscoverError {
  const owner = ownerError(text);
  const base = { httpStatus: status };
  if (status === 400 || status === 413 || status === 415) {
    return new CatalogDiscoverError('INVALID_REQUEST', owner.code ?? 'invalid_request', 'catalog.discover refused the request (fix the request; this never means "no products")', { ...base, retryable: false, issues: owner.issues });
  }
  if (status === 401) return new CatalogDiscoverError('AUTH_FAILED', owner.code ?? 'unauthorized', 'catalog.discover refused R4 credentials; check the Discover API key', { ...base, retryable: false });
  if (status === 403) return new CatalogDiscoverError('AUTH_FAILED', owner.code ?? 'forbidden', 'the R4 key is not authorized for catalog.discover (owner allowlist)', { ...base, retryable: false });
  if (status === 429) return new CatalogDiscoverError('RATE_LIMITED', 'rate_limited', 'the catalog is rate limiting R4', { ...base, retryable: true });
  if (status === 503) {
    switch (owner.code) {
      case 'capability_disabled':
        return new CatalogDiscoverError('DISABLED', owner.code, 'catalog.discover is disabled by its owner', { ...base, retryable: false });
      case 'capability_saturated': {
        const seconds = retryAfter !== null && /^\d{1,4}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
        return new CatalogDiscoverError('SATURATED', owner.code, 'catalog.discover is at capacity; do not retry immediately', { ...base, retryable: true, retryAfterSeconds: seconds });
      }
      case 'capability_not_ready':
      case 'index_incompatible':
      case 'capability_shutting_down':
      case 'request_cancelled':
        return new CatalogDiscoverError('NOT_READY', owner.code, 'catalog.discover is not ready', { ...base, retryable: owner.retryable ?? false });
      default:
        return new CatalogDiscoverError('SERVICE_ERROR', owner.code ?? 'catalog_unavailable', 'catalog.discover is unavailable', { ...base, retryable: owner.retryable ?? true });
    }
  }
  if (status >= 500 && status <= 599) return new CatalogDiscoverError('SERVICE_ERROR', owner.code ?? 'catalog_error', 'catalog.discover failed', { ...base, retryable: owner.retryable ?? status !== 500 });
  return new CatalogDiscoverError('CONTRACT_VIOLATION', 'unexpected_status', `catalog.discover answered HTTP ${status}, outside its contract`, { ...base, retryable: false });
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

