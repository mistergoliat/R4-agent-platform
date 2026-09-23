import { AvailabilitySwitch } from '../shared/availability.js';
import { DomainError, normalizeText, type CallOptions } from '../shared/errors.js';
import type { ShippingOption, ShippingQuote, ShippingQuoteRequest, ShippingService } from './port.js';

interface Zone {
  readonly region: string;
  readonly base: number;
  readonly perKg: number;
  readonly eta: { min: number; max: number };
  readonly express: boolean;
}

const ZONES: Readonly<Record<'metro' | 'central' | 'extended', Omit<Zone, 'region'>>> = {
  metro: { base: 9_990, perKg: 150, eta: { min: 1, max: 3 }, express: true },
  central: { base: 14_990, perKg: 250, eta: { min: 2, max: 5 }, express: true },
  extended: { base: 24_990, perKg: 400, eta: { min: 4, max: 8 }, express: false },
};

const SERVED: readonly (readonly [commune: string, zone: keyof typeof ZONES, region: string])[] = [
  ...['Santiago', 'Providencia', 'Ñuñoa', 'Las Condes', 'La Florida', 'Maipú', 'Puente Alto', 'Vitacura', 'Lo Barnechea', 'La Reina', 'Macul', 'San Miguel', 'Peñalolén', 'Estación Central'].map((c) => [c, 'metro', 'Metropolitana'] as const),
  ['Valparaíso', 'central', 'Valparaíso'],
  ['Viña del Mar', 'central', 'Valparaíso'],
  ['Rancagua', 'central', "O'Higgins"],
  ['Talca', 'central', 'Maule'],
  ['Concepción', 'central', 'Biobío'],
  ['Antofagasta', 'extended', 'Antofagasta'],
  ['La Serena', 'extended', 'Coquimbo'],
  ['Temuco', 'extended', 'Araucanía'],
  ['Puerto Montt', 'extended', 'Los Lagos'],
];

const COMMUNES: ReadonlyMap<string, { readonly zone: keyof typeof ZONES; readonly region: string; readonly display: string }> = new Map(
  SERVED.map(([commune, zone, region]) => [normalizeText(commune), { zone, region, display: commune }]),
);

/** Product weights, as the shipping owner obtains them from the catalog owner. */
export type WeightLookup = (productId: string) => number | null;

/**
 * In-memory Shipping owner: cost by destination zone and total weight.
 * Deterministic; logistics live here, never in an agent prompt.
 */
export class FixtureShipping implements ShippingService {
  readonly availability = new AvailabilitySwitch('shipping');
  readonly #weightOf: WeightLookup;
  readonly #now: () => Date;
  #quotes = 0;

  constructor(options: { weightOf: WeightLookup; now?: () => Date }) {
    this.#weightOf = options.weightOf;
    this.#now = options.now ?? (() => new Date());
  }

  get quotes(): number {
    return this.#quotes;
  }

  async quote(request: ShippingQuoteRequest, options?: CallOptions): Promise<ShippingQuote> {
    await this.availability.enter(options);
    this.#quotes += 1;
    if (request.items.length === 0) throw new DomainError('validation', 'no_items', 'at least one item is required to quote shipping');
    let totalWeightKg = 0;
    for (const item of request.items) {
      const weight = this.#weightOf(item.productId);
      if (weight === null) throw new DomainError('validation', 'unknown_product', `the catalog has no product ${item.productId}`, { productId: item.productId });
      totalWeightKg += weight * item.quantity;
    }
    totalWeightKg = Math.round(totalWeightKg * 10) / 10;
    const entry = COMMUNES.get(normalizeText(request.destination.commune));
    const quotedAt = this.#now().toISOString();
    if (!entry) {
      return { destination: { commune: request.destination.commune, region: request.destination.region ?? null }, serviceable: false, options: [], totalWeightKg, quotedAt };
    }
    const zone = ZONES[entry.zone];
    const standard = roundTo10(zone.base + zone.perKg * totalWeightKg);
    const options_: ShippingOption[] = [{ serviceLevel: 'standard', amount: { amount: standard, currency: 'CLP' }, etaBusinessDays: zone.eta }];
    if (zone.express) options_.push({ serviceLevel: 'express', amount: { amount: roundTo10(standard * 1.6), currency: 'CLP' }, etaBusinessDays: { min: 1, max: Math.max(1, zone.eta.min) } });
    return { destination: { commune: entry.display, region: entry.region }, serviceable: true, options: options_, totalWeightKg, quotedAt };
  }

  /** Synchronous owner-side cost for the standard service (used by the fixture Quote owner). */
  standardCost(commune: string, totalWeightKg: number): number | null {
    const entry = COMMUNES.get(normalizeText(commune));
    if (!entry) return null;
    const zone = ZONES[entry.zone];
    return roundTo10(zone.base + zone.perKg * totalWeightKg);
  }
}

function roundTo10(value: number): number {
  return Math.round(value / 10) * 10;
}
