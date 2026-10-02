import type { CallOptions, Money } from '../shared/errors.js';
import type { ShippingVatPolicyId } from './vat.js';

/**
 * Shipping port (R4-J2B). The Shipping owner (production: pc-carrier) prices
 * delivery for a destination commune and a shipment basis; callers never
 * compute logistics, coverage or carrier tariffs.
 *
 * The port speaks R4 concepts only: no carrier ids, no service-level
 * preference, no tax instruction, no address, no customer data and no owner
 * query parameter. The adapter owns the translation to the owner.
 *
 * A destination the owner does not serve is an answer (`serviceable: false`,
 * `offers: []`), never an error. A destination that cannot be resolved to
 * exactly one owner commune is an error (`shipping_invalid_destination`).
 */

/**
 * What the price is computed for.
 *
 * - `reference`: a fixed small reference package, used before any product is
 *   known. Its prices are NOT an absolute minimum tariff and NOT a quote for
 *   the customer's order; they are a reference for "delivery to this commune
 *   starts around".
 * - `order`: an already-resolved shipment — total physical weight and the
 *   gross declared value (product subtotal, tax included, shipping excluded).
 *   Both come from the Catalog owner's data, resolved by the caller.
 */
export type ShippingQuoteBasis =
  | { readonly type: 'reference' }
  | { readonly type: 'order'; readonly totalWeightKg: number; readonly declaredValueGross: Money };

export interface ShippingQuoteRequest {
  readonly destination: { readonly commune: string };
  readonly basis: ShippingQuoteBasis;
}

/** The destination as the owner's commune catalog resolved it. */
export interface ShippingResolvedDestination {
  /** The owner's commune id (opaque). */
  readonly communeId: string;
  readonly communeName: string;
  readonly regionName: string;
}

/** The basis the owner was actually asked to price, echoed so evidence says what it was for. */
export interface ShippingQuotedBasis {
  readonly type: ShippingQuoteBasis['type'];
  readonly weightKg: number;
  /** Present for `order`; null for `reference` (the owner was not given a declared value). */
  readonly declaredValue: { readonly amount: number; readonly currency: 'CLP'; readonly taxIncluded: true } | null;
  /** Production convention: every caller sends 1×1×1 cm; real product dimensions are not known to R4. */
  readonly dimensionsCm: { readonly height: 1; readonly width: 1; readonly depth: 1; readonly source: 'production_convention' };
}

/**
 * One offer's price: the owner's NET amount, untouched, plus the customer
 * gross R4 derives from it under an explicit VAT policy. The owner never
 * states a gross amount; `grossDerivedBy` says who did.
 */
export interface ShippingOfferPrice {
  readonly ownerNet: { readonly amount: number; readonly currency: 'CLP' };
  readonly tax: { readonly policy: ShippingVatPolicyId; readonly rate: number; readonly amount: number };
  readonly customerGross: Money;
  readonly grossDerivedBy: 'r4_shipping_adapter';
}

export interface ShippingOffer {
  readonly carrierName: string;
  readonly serviceType: string;
  readonly price: ShippingOfferPrice;
  /** Owner text, never parsed (a date, free text, or absent). */
  readonly estimatedDelivery: string | null;
  /** 0-based position in the owner's answer. The owner's order is NOT a price ranking and is preserved. */
  readonly ownerPosition: number;
}

export interface ShippingQuote {
  readonly destination: ShippingResolvedDestination;
  readonly basis: ShippingQuotedBasis;
  readonly serviceable: boolean;
  /** Every owner offer, in the owner's order. No offer is selected or recommended. */
  readonly offers: readonly ShippingOffer[];
  /** When the owner answered. */
  readonly asOf: string;
  /** The owner publishes no quote id, TTL or validity: always null. A quote is informational, never a checkout commitment. */
  readonly ownerValidUntil: null;
  readonly provenance: { readonly owner: string; readonly endpoint: string; readonly ownerContractVersion: string };
}

/** Domain error codes of this port (on `DomainError.code`). */
export const SHIPPING_ERROR_CODES = {
  invalidDestination: 'shipping_invalid_destination',
  invalidWeight: 'shipping_invalid_weight',
  invalidDeclaredValue: 'shipping_invalid_declared_value',
  ownerTimeout: 'shipping_owner_timeout',
  ownerUnavailable: 'shipping_owner_unavailable',
  ownerInvalidResponse: 'shipping_owner_invalid_response',
  ownerRejectedRequest: 'shipping_owner_rejected_request',
  ownerUnauthorized: 'shipping_owner_unauthorized',
} as const;

export interface ShippingService {
  quote(request: ShippingQuoteRequest, options?: CallOptions): Promise<ShippingQuote>;
}
