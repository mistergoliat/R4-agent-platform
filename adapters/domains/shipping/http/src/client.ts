import { performance } from 'node:perf_hooks';
import type { z } from 'zod';
import { DomainError, SHIPPING_ERROR_CODES, type CallOptions, type DomainErrorCategory } from '@r4-adapters/domains';
import type { ShippingHttpConfig } from './config.js';
import { pcCarrierLocationsSchema, pcCarrierQuoteSchema, type PcCarrierLocations, type PcCarrierQuote } from './schemas.js';

/** The subset of `fetch` the client uses (injected: tests and deployments decide the transport). GET only. */
export type ShippingFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export type PcCarrierOperation = 'getLocations' | 'quoteAll';

/** One owner call's outcome for telemetry. Carries no customer data and no response body. */
export interface PcCarrierCallTelemetry {
  readonly kind: 'owner_call';
  readonly operation: PcCarrierOperation;
  readonly outcome: 'ok' | 'failed';
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly offerCount: number | null;
  readonly errorCategory: DomainErrorCategory | null;
  readonly errorCode: string | null;
  readonly correlationId: string | null;
}

/**
 * What R4 sends to the owner's quote route. Dimensions are not a parameter:
 * the production convention (1×1×1 cm) is fixed inside the client, and
 * `quantity` / `origin_code` are never sent.
 */
export interface PcCarrierQuoteParams {
  /** The owner's commune id (resolved through GET /location). */
  readonly destino: string;
  readonly kilos: number;
  /** Gross declared product value in whole CLP; null = not sent (reference basis). */
  readonly totalBoleta: number | null;
}

/** Production convention shared by every existing pc-carrier caller (R4-J2A): real product dimensions are unknown. */
export const PC_CARRIER_DIMENSIONS_CM = Object.freeze({ alto: 1, ancho: 1, largo: 1 } as const);

/** The only owner routes R4 may call: both read-only. There is deliberately no generic route API. */
type ReadRoute = '/location' | '/carrier/v1/all';

/** Success statuses: the owner answers 202 on the quote route and 200 on the location tree; either is accepted on both. */
const SUCCESS = new Set([200, 202]);
const MAX_RESPONSE_CHARS = 1_000_000;

/**
 * Narrow HTTP client of pc-carrier (R4-J2B). Structurally restricted to two
 * read operations — `getLocations()` and `quoteAll()` — so no execution path
 * can reach the owner's emission, SAP or shipping-method mutation routes.
 * It transports only: deadline, status handling, JSON parsing, schema
 * validation, failure classification and telemetry. No pricing, coverage or
 * carrier logic; owner error text is never interpreted.
 *
 * Failure mapping:
 *   400                    → validation (shipping_owner_rejected_request)
 *   401 / 403              → unauthorized (shipping_owner_unauthorized)
 *   429, 5xx, network      → temporarily_unavailable (shipping_owner_unavailable)
 *   local/caller deadline  → timeout (shipping_owner_timeout)
 *   other status, unparseable or schema-invalid body
 *                          → contract_violation (shipping_owner_invalid_response)
 */
export class PcCarrierClient {
  readonly #config: ShippingHttpConfig;
  readonly #fetch: ShippingFetch;
  readonly #onCall: ((event: PcCarrierCallTelemetry) => void) | undefined;

  constructor(options: { readonly config: ShippingHttpConfig; readonly fetch: ShippingFetch; readonly onCall?: (event: PcCarrierCallTelemetry) => void }) {
    this.#config = options.config;
    this.#fetch = options.fetch;
    this.#onCall = options.onCall;
  }

  /** The owner's canonical commune catalog. */
  getLocations(options?: CallOptions): Promise<PcCarrierLocations> {
    return this.#get('getLocations', '/location', null, pcCarrierLocationsSchema, options);
  }

  /** Every carrier option the owner offers for a destination, in the owner's order. */
  quoteAll(params: PcCarrierQuoteParams, options?: CallOptions): Promise<PcCarrierQuote> {
    const query = new URLSearchParams({
      destino: params.destino,
      alto: String(PC_CARRIER_DIMENSIONS_CM.alto),
      ancho: String(PC_CARRIER_DIMENSIONS_CM.ancho),
      largo: String(PC_CARRIER_DIMENSIONS_CM.largo),
      kilos: formatKilos(params.kilos),
    });
    if (params.totalBoleta !== null) query.set('total_boleta', String(params.totalBoleta));
    return this.#get('quoteAll', '/carrier/v1/all', query, pcCarrierQuoteSchema, options);
  }

  async #get<S extends z.ZodType>(operation: PcCarrierOperation, route: ReadRoute, query: URLSearchParams | null, schema: S, options: CallOptions | undefined): Promise<z.output<S>> {
    const started = performance.now();
    const correlationId = options?.correlationId ?? null;
    let httpStatus: number | null = null;
    try {
      if (options?.signal?.aborted) throw new DomainError('timeout', SHIPPING_ERROR_CODES.ownerTimeout, 'the caller deadline passed before the shipping owner was called');
      const deadline = AbortSignal.timeout(this.#config.timeoutMs);
      const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      let text: string;
      try {
        const response = await this.#fetch(`${this.#config.baseUrl}${route}${query ? `?${query.toString()}` : ''}`, { method: 'GET', headers: { accept: 'application/json' }, signal });
        httpStatus = response.status;
        text = await response.text();
      } catch (error) {
        if (signal.aborted) throw new DomainError('timeout', SHIPPING_ERROR_CODES.ownerTimeout, 'the shipping owner did not answer before the deadline');
        throw new DomainError('temporarily_unavailable', SHIPPING_ERROR_CODES.ownerUnavailable, `the shipping owner could not be reached (${error instanceof Error ? error.name : 'error'})`);
      }
      if (!SUCCESS.has(httpStatus)) throw failureOf(httpStatus);
      if (text.length > MAX_RESPONSE_CHARS) throw new DomainError('contract_violation', SHIPPING_ERROR_CODES.ownerInvalidResponse, 'the shipping owner answer exceeds the contract size');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new DomainError('contract_violation', SHIPPING_ERROR_CODES.ownerInvalidResponse, 'the shipping owner answer is not JSON', { httpStatus });
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new DomainError('contract_violation', SHIPPING_ERROR_CODES.ownerInvalidResponse, `the shipping owner answer violates the contract at ${issue ? issue.path.join('.') || '(root)' : '(root)'}`, { httpStatus, issues: parsed.error.issues.length });
      }
      const offerCount = operation === 'quoteAll' ? (parsed.data as PcCarrierQuote).options.length : null;
      this.#emit({ kind: 'owner_call', operation, outcome: 'ok', httpStatus, durationMs: elapsed(started), offerCount, errorCategory: null, errorCode: null, correlationId });
      return parsed.data;
    } catch (error) {
      if (error instanceof DomainError) this.#emit({ kind: 'owner_call', operation, outcome: 'failed', httpStatus, durationMs: elapsed(started), offerCount: null, errorCategory: error.category, errorCode: error.code, correlationId });
      throw error;
    }
  }

  #emit(event: PcCarrierCallTelemetry): void {
    try {
      this.#onCall?.(event);
    } catch {
      // Telemetry never changes the outcome of a read.
    }
  }
}

/** Plain decimal kg with at most 3 decimals (never exponent notation, which the owner would silently misread). */
export function formatKilos(kilos: number): string {
  const grams = Math.round(kilos * 1000);
  if (!Number.isSafeInteger(grams) || grams <= 0) throw new DomainError('validation', SHIPPING_ERROR_CODES.invalidWeight, 'the shipment weight must be at least 0.001 kg');
  const whole = Math.trunc(grams / 1000);
  const fraction = String(grams % 1000).padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function failureOf(status: number): DomainError {
  if (status === 400) return new DomainError('validation', SHIPPING_ERROR_CODES.ownerRejectedRequest, 'the shipping owner refused the request as invalid', { httpStatus: status });
  if (status === 401 || status === 403) return new DomainError('unauthorized', SHIPPING_ERROR_CODES.ownerUnauthorized, 'the shipping owner refused the request as unauthorized', { httpStatus: status });
  if (status === 429 || (status >= 500 && status <= 599)) return new DomainError('temporarily_unavailable', SHIPPING_ERROR_CODES.ownerUnavailable, 'the shipping owner is temporarily unavailable', { httpStatus: status });
  return new DomainError('contract_violation', SHIPPING_ERROR_CODES.ownerInvalidResponse, `the shipping owner answered HTTP ${status}, outside its contract`, { httpStatus: status });
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
