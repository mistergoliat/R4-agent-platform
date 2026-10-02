import { AvailabilitySwitch } from '../shared/availability.js';
import { DomainError, type CallOptions } from '../shared/errors.js';
import { normalizeCommuneName, offerPriceOf, quotedBasisOf } from './basis.js';
import { SHIPPING_ERROR_CODES, type ShippingOffer, type ShippingQuote, type ShippingQuoteRequest, type ShippingResolvedDestination, type ShippingService } from './port.js';

interface Zone {
  /** NET CLP, like the production owner. */
  readonly baseNet: number;
  readonly perKgNet: number;
  readonly eta: string;
  readonly express: boolean;
}

const ZONES: Readonly<Record<'metro' | 'central' | 'extended', Zone>> = {
  metro: { baseNet: 8_390, perKgNet: 126, eta: '1 a 3 días hábiles', express: true },
  central: { baseNet: 12_590, perKgNet: 210, eta: '2 a 5 días hábiles', express: true },
  extended: { baseNet: 20_990, perKgNet: 336, eta: '4 a 8 días hábiles', express: false },
};

/** Communes the fixture owner knows (its own commune catalog), with fixture ids — never real owner ids. */
const COMMUNES: readonly (readonly [name: string, zone: keyof typeof ZONES | null, region: string])[] = [
  ...['Santiago Centro', 'Providencia', 'Ñuñoa', 'Las Condes', 'La Florida', 'Maipú', 'Puente Alto', 'Vitacura', 'Lo Barnechea', 'La Reina', 'Macul', 'San Miguel', 'Peñalolén', 'Estación Central'].map((c) => [c, 'metro', 'Metropolitana de Santiago'] as const),
  ['Valparaíso', 'central', 'Valparaíso'],
  ['Viña del Mar', 'central', 'Valparaíso'],
  ['Rancagua', 'central', "Libertador General Bernardo O'Higgins"],
  ['Talca', 'central', 'Maule'],
  ['Concepción', 'central', 'Biobío'],
  ['Antofagasta', 'extended', 'Antofagasta'],
  ['La Serena', 'extended', 'Coquimbo'],
  ['Temuco', 'extended', 'La Araucanía'],
  ['Puerto Montt', 'extended', 'Los Lagos'],
  // Known to the commune catalog but served by no carrier: the owner answers with no offers.
  ['Tirúa', null, 'Biobío'],
];

interface FixtureCommune extends ShippingResolvedDestination {
  readonly zone: keyof typeof ZONES | null;
}

const BY_NAME: ReadonlyMap<string, FixtureCommune> = new Map(
  COMMUNES.map(([name, zone, regionName], index) => [normalizeCommuneName(name), { communeId: `fx-${String(index + 1).padStart(3, '0')}`, communeName: name, regionName, zone }]),
);

/**
 * In-memory Shipping owner with the production contract's semantics
 * (R4-J2B): exact normalized commune resolution against its own catalog,
 * NET tariffs by zone and weight, offers in a fixed owner order (not price
 * ranked; one without an ETA), customer gross derived under the same VAT
 * policy as the production adapter. Deterministic; logistics live here,
 * never in an agent prompt.
 */
export class FixtureShipping implements ShippingService {
  /** What this implementation is, for a shadow composition's binding check (R4-H): an in-memory, deterministic owner. */
  readonly bindingKind = 'fixture' as const;
  readonly availability = new AvailabilitySwitch('shipping');
  readonly #now: () => Date;
  #quotes = 0;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  get quotes(): number {
    return this.#quotes;
  }

  async quote(request: ShippingQuoteRequest, options?: CallOptions): Promise<ShippingQuote> {
    await this.availability.enter(options);
    this.#quotes += 1;
    const basis = quotedBasisOf(request.basis);
    const commune = resolve(request.destination.commune);
    const zone = commune.zone ? ZONES[commune.zone] : null;
    const offers: ShippingOffer[] = [];
    if (zone) {
      const courierNet = netCost(zone, basis.weightKg);
      offers.push({ carrierName: 'Fixture Courier', serviceType: 'NORMAL', price: offerPriceOf(courierNet), estimatedDelivery: zone.eta, ownerPosition: 0 });
      if (zone.express) offers.push({ carrierName: 'Fixture Express', serviceType: 'EXPRESS', price: offerPriceOf(Math.round(courierNet * 1.6)), estimatedDelivery: null, ownerPosition: 1 });
    }
    const { zone: _, ...destination } = commune;
    return {
      destination,
      basis,
      serviceable: offers.length > 0,
      offers,
      asOf: this.#now().toISOString(),
      ownerValidUntil: null,
      provenance: { owner: 'fixture-shipping', endpoint: 'in-memory', ownerContractVersion: 'fixture-1' },
    };
  }

  /**
   * Synchronous owner-side customer gross of the courier service for a
   * commune and weight (used by the fixture/shadow Quote owners, which price
   * shipping themselves). Null when the commune is unknown or unserved.
   */
  standardCost(commune: string, totalWeightKg: number): number | null {
    const entry = BY_NAME.get(normalizeCommuneName(commune));
    const zone = entry?.zone ? ZONES[entry.zone] : null;
    return zone ? offerPriceOf(netCost(zone, totalWeightKg)).customerGross.amount : null;
  }
}

function resolve(commune: string): FixtureCommune {
  const entry = commune.trim() ? BY_NAME.get(normalizeCommuneName(commune)) : undefined;
  if (!entry) throw new DomainError('validation', SHIPPING_ERROR_CODES.invalidDestination, 'the commune is not in the shipping owner commune catalog', { commune: commune.slice(0, 80) });
  return entry;
}

function netCost(zone: Zone, weightKg: number): number {
  return zone.baseNet + zone.perKgNet * Math.ceil(weightKg);
}
