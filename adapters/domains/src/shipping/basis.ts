import { DomainError } from '../shared/errors.js';
import { SHIPPING_ERROR_CODES, type ShippingOfferPrice, type ShippingQuoteBasis, type ShippingQuotedBasis } from './port.js';
import { deriveShippingGross } from './vat.js';

/** The reference package: what the owner is asked to price when no product is known (production convention, R4-J2B). */
export const SHIPPING_REFERENCE_WEIGHT_KG = 1;

const DIMENSIONS_CM: ShippingQuotedBasis['dimensionsCm'] = Object.freeze({ height: 1, width: 1, depth: 1, source: 'production_convention' });

/**
 * Validates a basis before any owner call and echoes what will be priced.
 *
 * An order basis must carry a real, positive, finite weight and a whole,
 * non-negative CLP declared value: the production owner silently prices a
 * missing/zero/invalid weight like its default package, so letting one
 * through would fabricate a quote.
 */
export function quotedBasisOf(basis: ShippingQuoteBasis): ShippingQuotedBasis {
  if (basis.type === 'reference') return { type: 'reference', weightKg: SHIPPING_REFERENCE_WEIGHT_KG, declaredValue: null, dimensionsCm: DIMENSIONS_CM };
  const weight = basis.totalWeightKg;
  // At least 1 g: the owner receives plain decimal kg with at most 3 decimals.
  if (typeof weight !== 'number' || !Number.isFinite(weight) || Math.round(weight * 1000) < 1) {
    throw new DomainError('validation', SHIPPING_ERROR_CODES.invalidWeight, 'an order shipping quote needs a positive, finite total weight of at least 0.001 kg');
  }
  const declared = basis.declaredValueGross;
  if (!declared || declared.currency !== 'CLP' || !Number.isSafeInteger(declared.amount) || declared.amount < 0) {
    throw new DomainError('validation', SHIPPING_ERROR_CODES.invalidDeclaredValue, 'an order shipping quote needs a whole, non-negative CLP declared gross value');
  }
  return { type: 'order', weightKg: weight, declaredValue: { amount: declared.amount, currency: 'CLP', taxIncluded: true }, dimensionsCm: DIMENSIONS_CM };
}

/** The owner's net, untouched, and the customer gross derived from it under the explicit VAT policy. */
export function offerPriceOf(ownerNet: number): ShippingOfferPrice {
  const derived = deriveShippingGross(ownerNet);
  return {
    ownerNet: { amount: ownerNet, currency: 'CLP' },
    tax: { policy: derived.policy, rate: derived.rate, amount: derived.taxAmount },
    customerGross: { amount: derived.grossAmount, currency: 'CLP' },
    grossDerivedBy: 'r4_shipping_adapter',
  };
}

/** The commune-name normalization R4 allows for exact matching: trim, Unicode diacritic removal, lowercase. Nothing fuzzy. */
export function normalizeCommuneName(value: string): string {
  return value.trim().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}
