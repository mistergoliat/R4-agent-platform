import { performance } from 'node:perf_hooks';
import {
  DomainError,
  SHIPPING_ERROR_CODES,
  offerPriceOf,
  quotedBasisOf,
  type CallOptions,
  type DomainErrorCategory,
  type ShippingQuote,
  type ShippingQuoteRequest,
  type ShippingResolvedDestination,
  type ShippingService,
} from '@r4-adapters/domains';
import { PcCarrierClient, type PcCarrierCallTelemetry, type ShippingFetch } from './client.js';
import { indexCommunes, resolveCommune } from './communes.js';
import type { ShippingHttpConfig } from './config.js';
import { PC_CARRIER_CONTRACT_VERSION } from './schemas.js';

/** One quote's outcome for telemetry. Carries no customer text, identity or address — only the resolved owner commune. */
export interface ShippingQuoteTelemetry {
  readonly kind: 'quote';
  readonly operation: 'quote';
  readonly basisType: 'reference' | 'order';
  readonly outcome: 'ok' | 'failed';
  readonly destinationResolved: boolean;
  readonly communeId: string | null;
  readonly communeName: string | null;
  readonly offerCount: number | null;
  readonly serviceable: boolean | null;
  readonly durationMs: number;
  readonly errorCategory: DomainErrorCategory | null;
  readonly errorCode: string | null;
  readonly correlationId: string | null;
}

export type ShippingTelemetry = ShippingQuoteTelemetry | PcCarrierCallTelemetry;

export interface ProductionShippingAdapterOptions {
  readonly config: ShippingHttpConfig;
  readonly fetch: ShippingFetch;
  readonly onEvent?: (event: ShippingTelemetry) => void;
  readonly now?: () => Date;
}

/**
 * Production Shipping adapter over pc-carrier (R4-J2B). It owns the
 * translation from the R4 Shipping port to the owner:
 *
 *   validate basis (before any call)
 *   → resolve the commune against GET /location (exact normalized match)
 *   → GET /carrier/v1/all with destino=<owner commune id>, kilos, 1×1×1 cm
 *     and, for an order basis only, total_boleta = gross declared value
 *   → map every owner option in the owner's order: the owner NET is kept
 *     untouched and the customer gross is derived under the explicit VAT
 *     policy (`SHIPPING_VAT_POLICY`).
 *
 * It never selects or ranks a carrier, never infers coverage, never
 * substitutes a weight, price or fallback, and never repairs an owner answer.
 * An empty owner answer for a resolved commune is `serviceable: false`.
 * The commune catalog is read on every quote (correctness over caching: the
 * owner publishes no freshness for it).
 */
export class ProductionShippingAdapter implements ShippingService {
  readonly bindingKind = 'http' as const;
  readonly #client: PcCarrierClient;
  readonly #onEvent: ((event: ShippingTelemetry) => void) | undefined;
  readonly #now: () => Date;

  constructor(options: ProductionShippingAdapterOptions) {
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? (() => new Date());
    this.#client = new PcCarrierClient({ config: options.config, fetch: options.fetch, onCall: (event) => this.#emit(event) });
  }

  async quote(request: ShippingQuoteRequest, options?: CallOptions): Promise<ShippingQuote> {
    const started = performance.now();
    const basisType = request.basis?.type === 'order' ? 'order' : 'reference';
    let destination: ShippingResolvedDestination | null = null;
    try {
      const basis = quotedBasisOf(request.basis);
      if (typeof request.destination?.commune !== 'string' || !request.destination.commune.trim()) {
        throw new DomainError('validation', SHIPPING_ERROR_CODES.invalidDestination, 'a destination commune is required');
      }
      destination = resolveCommune(indexCommunes(await this.#client.getLocations(options)), request.destination.commune);
      const owner = await this.#client.quoteAll({ destino: destination.communeId, kilos: basis.weightKg, totalBoleta: basis.declaredValue?.amount ?? null }, options);
      const asOf = this.#now().toISOString();
      const offers = owner.options.map((option, ownerPosition) => ({
        carrierName: option.carrier_name,
        serviceType: option.service_type,
        price: offerPriceOf(option.total_cost),
        estimatedDelivery: option.estimated_delivery ?? null,
        ownerPosition,
      }));
      this.#emit(quoteEvent({ basisType, outcome: 'ok', destination, offerCount: offers.length, serviceable: offers.length > 0, started, error: null, options }));
      return {
        destination: { ...destination },
        basis,
        serviceable: offers.length > 0,
        offers,
        asOf,
        ownerValidUntil: null,
        provenance: { owner: 'pc-carrier', endpoint: '/carrier/v1/all', ownerContractVersion: PC_CARRIER_CONTRACT_VERSION },
      };
    } catch (error) {
      if (error instanceof DomainError) this.#emit(quoteEvent({ basisType, outcome: 'failed', destination, offerCount: null, serviceable: null, started, error, options }));
      throw error;
    }
  }

  #emit(event: ShippingTelemetry): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // Telemetry never changes the outcome of a read.
    }
  }
}

function quoteEvent(input: {
  basisType: 'reference' | 'order';
  outcome: 'ok' | 'failed';
  destination: ShippingResolvedDestination | null;
  offerCount: number | null;
  serviceable: boolean | null;
  started: number;
  error: DomainError | null;
  options: CallOptions | undefined;
}): ShippingQuoteTelemetry {
  return {
    kind: 'quote',
    operation: 'quote',
    basisType: input.basisType,
    outcome: input.outcome,
    destinationResolved: input.destination !== null,
    communeId: input.destination?.communeId ?? null,
    communeName: input.destination?.communeName ?? null,
    offerCount: input.offerCount,
    serviceable: input.serviceable,
    durationMs: Math.round(performance.now() - input.started),
    errorCategory: input.error?.category ?? null,
    errorCode: input.error?.code ?? null,
    correlationId: input.options?.correlationId ?? null,
  };
}
