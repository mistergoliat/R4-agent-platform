import type { CallOptions, ItemQuantity, Money } from '../shared/errors.js';

/**
 * Shipping port. The Shipping owner calculates delivery options and cost for
 * a destination and a set of items; callers never compute logistics. A
 * destination the owner does not serve is an answer (`serviceable: false`).
 *
 * The live adapter (Shipping Service / capability) is pending: no contract
 * for it is documented in this repository.
 */
export interface ShippingDestination {
  readonly commune: string;
  readonly region?: string | null;
}

export interface ShippingQuoteRequest {
  readonly destination: ShippingDestination;
  readonly items: readonly ItemQuantity[];
}

export interface ShippingOption {
  readonly serviceLevel: 'standard' | 'express';
  readonly amount: Money;
  readonly etaBusinessDays: { readonly min: number; readonly max: number };
}

export interface ShippingQuote {
  /** The destination as the owner resolved it (echoed so the evidence says what it was for). */
  readonly destination: { readonly commune: string; readonly region: string | null };
  readonly serviceable: boolean;
  readonly options: readonly ShippingOption[];
  readonly totalWeightKg: number;
  readonly quotedAt: string;
}

export interface ShippingService {
  quote(request: ShippingQuoteRequest, options?: CallOptions): Promise<ShippingQuote>;
}
