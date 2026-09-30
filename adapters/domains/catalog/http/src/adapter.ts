import { performance } from 'node:perf_hooks';
import type { z } from 'zod';
import {
  DomainError,
  type CallOptions,
  type CatalogItemContext,
  type CatalogItemContextRequest,
  type CatalogPort,
  type CatalogProductContext,
  type CatalogSearchAnswer,
  type CatalogSearchRequest,
  type DomainErrorCategory,
} from '@r4-adapters/domains';
import type { CatalogHttpConfig } from './config.js';
import {
  CATALOG_SCHEMA_VERSION,
  catalogErrorBodySchema,
  catalogItemContextResponseSchema,
  catalogKeySchema,
  catalogProductContextResponseSchema,
  catalogSearchResponseSchema,
} from './schemas.js';

/** The subset of `fetch` the adapter uses (injected: tests and deployments decide the transport). */
export type CatalogFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export type CatalogOperation = 'search' | 'getProductContext' | 'getItemContext';

/** One call's outcome for telemetry. Carries no key, no body and no API key. */
export interface CatalogCallTelemetry {
  readonly operation: CatalogOperation;
  readonly outcome: 'ok' | 'failed';
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly errorCategory: DomainErrorCategory | null;
  readonly errorCode: string | null;
  readonly correlationId: string | null;
}

export interface HttpCatalogAdapterOptions {
  readonly config: CatalogHttpConfig;
  readonly fetch: CatalogFetch;
  readonly onCall?: (event: CatalogCallTelemetry) => void;
}

const MAX_RESPONSE_CHARS = 1_000_000;

/**
 * HTTP adapter of the Catalog port against catalog-service's v2 read
 * contract (R4-J1B). It only transports: base URL, API key, correlation id,
 * deadline, status handling, JSON parsing, schema/invariant validation,
 * failure classification, telemetry, and the minimal mapping that drops
 * `schemaVersion`. It contains no Catalog business rule: it never computes
 * or adjusts a price, availability, lifecycle, freshness or ranking, never
 * picks a variant, never deduplicates, and never repairs an invalid answer.
 *
 * Failure mapping (§7 of the J1B document):
 *   400                         → validation (not retryable)
 *   401 / 403                   → unauthorized (deployment misconfiguration; fail closed)
 *   404, other 4xx, 2xx≠200     → contract_violation (the contract answers not_found as data)
 *   429                         → temporarily_unavailable (rate_limited; retryable)
 *   5xx                         → temporarily_unavailable (retryable)
 *   network failure             → temporarily_unavailable (catalog_unreachable)
 *   local deadline              → timeout
 *   unparseable / invalid body  → contract_violation (not retryable)
 *   unsupported schemaVersion   → contract_violation (breaking change)
 */
export class HttpCatalogAdapter implements CatalogPort {
  readonly bindingKind = 'http' as const;
  readonly #config: CatalogHttpConfig;
  readonly #fetch: CatalogFetch;
  readonly #onCall: ((event: CatalogCallTelemetry) => void) | undefined;

  constructor(options: HttpCatalogAdapterOptions) {
    this.#config = options.config;
    this.#fetch = options.fetch;
    this.#onCall = options.onCall;
  }

  async search(request: CatalogSearchRequest, options?: CallOptions): Promise<CatalogSearchAnswer> {
    const body = JSON.stringify({ query: request.query, ...(request.filters ? { filters: request.filters } : {}), ...(request.limit !== undefined ? { limit: request.limit } : {}) });
    const parsed = await this.#call('search', 'POST', '/v2/catalog/search', body, catalogSearchResponseSchema, options);
    const { schemaVersion: _, ...answer } = parsed;
    return answer;
  }

  async getProductContext(productKey: string, options?: CallOptions): Promise<CatalogProductContext> {
    requireKey(productKey, 'productKey');
    const parsed = await this.#call('getProductContext', 'GET', `/v2/catalog/products/${encodeURIComponent(productKey)}/context`, undefined, catalogProductContextResponseSchema, options);
    if (parsed.productKey !== productKey) throw this.#violation('getProductContext', 'key_mismatch', 'the owner answered for a different productKey', options);
    const { schemaVersion: _, ...context } = parsed;
    return context;
  }

  async getItemContext(request: CatalogItemContextRequest, options?: CallOptions): Promise<CatalogItemContext> {
    requireKey(request.itemKey, 'itemKey');
    if (!Number.isInteger(request.quantity) || request.quantity < 1 || request.quantity > 99) throw new DomainError('validation', 'invalid_request', 'quantity must be an integer between 1 and 99');
    const path = `/v2/catalog/items/${encodeURIComponent(request.itemKey)}/context?quantity=${request.quantity}`;
    const parsed = await this.#call('getItemContext', 'GET', path, undefined, catalogItemContextResponseSchema, options);
    if (parsed.itemKey !== request.itemKey) throw this.#violation('getItemContext', 'key_mismatch', 'the owner answered for a different itemKey', options);
    if (parsed.status === 'found' && parsed.pricing.status === 'available' && parsed.pricing.quantity !== request.quantity) throw this.#violation('getItemContext', 'quantity_mismatch', 'the owner priced a different quantity', options);
    const { schemaVersion: _, ...context } = parsed;
    return context;
  }

  async #call<S extends z.ZodType>(operation: CatalogOperation, method: 'GET' | 'POST', path: string, body: string | undefined, schema: S, options: CallOptions | undefined): Promise<z.output<S>> {
    const started = performance.now();
    const correlationId = options?.correlationId ?? null;
    let httpStatus: number | null = null;
    try {
      if (options?.signal?.aborted) throw new DomainError('timeout', 'deadline_exceeded', 'the caller deadline passed before the catalog was called');
      const deadline = AbortSignal.timeout(this.#config.timeoutMs);
      const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const headers: Record<string, string> = { accept: 'application/json', 'x-api-key': this.#config.apiKey };
      if (correlationId) headers['x-correlation-id'] = correlationId;
      if (body !== undefined) headers['content-type'] = 'application/json';
      let text: string;
      try {
        const response = await this.#fetch(`${this.#config.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}), signal });
        httpStatus = response.status;
        text = await response.text();
      } catch (error) {
        if (signal.aborted) throw new DomainError('timeout', 'deadline_exceeded', 'the catalog did not answer before the deadline');
        throw new DomainError('temporarily_unavailable', 'catalog_unreachable', `the catalog could not be reached (${error instanceof Error ? error.name : 'error'})`);
      }
      if (httpStatus !== 200) throw failureOf(httpStatus, text);
      if (text.length > MAX_RESPONSE_CHARS) throw new DomainError('contract_violation', 'response_too_large', 'the catalog answer exceeds the contract size');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new DomainError('contract_violation', 'unparseable_response', 'the catalog answer is not JSON');
      }
      const version = (json as { schemaVersion?: unknown } | null)?.schemaVersion;
      if (version !== CATALOG_SCHEMA_VERSION) throw new DomainError('contract_violation', 'unsupported_schema_version', `the catalog answered schemaVersion ${typeof version === 'number' ? version : 'missing'}; R4 speaks ${CATALOG_SCHEMA_VERSION}`);
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new DomainError('contract_violation', 'invalid_response', `the catalog answer violates the contract at ${issue ? issue.path.join('.') || '(root)' : '(root)'}`, { issues: parsed.error.issues.length });
      }
      this.#emit({ operation, outcome: 'ok', httpStatus, durationMs: elapsed(started), errorCategory: null, errorCode: null, correlationId });
      return parsed.data;
    } catch (error) {
      if (error instanceof DomainError) this.#emit({ operation, outcome: 'failed', httpStatus, durationMs: elapsed(started), errorCategory: error.category, errorCode: error.code, correlationId });
      throw error;
    }
  }

  #violation(operation: CatalogOperation, code: string, message: string, options: CallOptions | undefined): DomainError {
    const error = new DomainError('contract_violation', code, message);
    this.#emit({ operation, outcome: 'failed', httpStatus: 200, durationMs: 0, errorCategory: error.category, errorCode: code, correlationId: options?.correlationId ?? null });
    return error;
  }

  #emit(event: CatalogCallTelemetry): void {
    try {
      this.#onCall?.(event);
    } catch {
      // Telemetry never changes the outcome of a read.
    }
  }
}

function requireKey(value: string, name: string): void {
  if (!catalogKeySchema.safeParse(value).success) throw new DomainError('validation', 'invalid_request', `${name} is not a catalog key`);
}

function failureOf(status: number, text: string): DomainError {
  const code = ownerCode(text);
  if (status === 400) return new DomainError('validation', code ?? 'invalid_request', 'the catalog refused the request as invalid', { httpStatus: status });
  if (status === 401 || status === 403) return new DomainError('unauthorized', code ?? 'unauthorized', 'the catalog refused R4 credentials; check R4_CATALOG_API_KEY', { httpStatus: status });
  if (status === 429) return new DomainError('temporarily_unavailable', 'rate_limited', 'the catalog is rate limiting R4', { httpStatus: status });
  if (status >= 500 && status <= 599) return new DomainError('temporarily_unavailable', code ?? 'catalog_unavailable', 'the catalog is temporarily unavailable', { httpStatus: status });
  // 404 included: the contract answers "not found" as data, so an HTTP 404 means a wrong route or a broken contract.
  return new DomainError('contract_violation', 'unexpected_status', `the catalog answered HTTP ${status}, outside its contract`, { httpStatus: status });
}

function ownerCode(text: string): string | null {
  try {
    const parsed = catalogErrorBodySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.error.code : null;
  } catch {
    return null;
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
