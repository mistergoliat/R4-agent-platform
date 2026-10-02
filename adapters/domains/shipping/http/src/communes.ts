import { DomainError, SHIPPING_ERROR_CODES, normalizeCommuneName, type ShippingResolvedDestination } from '@r4-adapters/domains';
import type { PcCarrierLocations } from './schemas.js';

/** The owner's commune catalog, flattened and indexed by normalized name. */
export type CommuneIndex = ReadonlyMap<string, readonly ShippingResolvedDestination[]>;

/** Flattens Region > Ciudad > Comuna into canonical communes keyed by normalized name (cities carry no meaning here). */
export function indexCommunes(locations: PcCarrierLocations): CommuneIndex {
  const index = new Map<string, ShippingResolvedDestination[]>();
  for (const region of locations) {
    for (const city of region.ciudades) {
      for (const commune of city.comunas) {
        const key = normalizeCommuneName(commune.comuna_name);
        const entry: ShippingResolvedDestination = { communeId: String(commune.id_comuna), communeName: commune.comuna_name, regionName: region.region_name };
        const existing = index.get(key);
        // The same owner commune listed twice is one commune, not an ambiguity.
        if (existing?.some((e) => e.communeId === entry.communeId)) continue;
        index.set(key, existing ? [...existing, entry] : [entry]);
      }
    }
  }
  return index;
}

/**
 * Exact normalized match only (trim, diacritics, case): no fuzzy matching,
 * no typo correction, no alias the owner data does not contain. Zero or
 * several matches fail closed.
 */
export function resolveCommune(index: CommuneIndex, input: string): ShippingResolvedDestination {
  const key = normalizeCommuneName(input);
  if (!key) throw new DomainError('validation', SHIPPING_ERROR_CODES.invalidDestination, 'a destination commune is required');
  const matches = index.get(key) ?? [];
  if (matches.length === 0) throw new DomainError('validation', SHIPPING_ERROR_CODES.invalidDestination, 'the commune is not in the shipping owner commune catalog', { reason: 'no_match' });
  if (matches.length > 1) throw new DomainError('validation', SHIPPING_ERROR_CODES.invalidDestination, 'the commune name matches several owner communes', { reason: 'ambiguous', matches: matches.length });
  return matches[0]!;
}
