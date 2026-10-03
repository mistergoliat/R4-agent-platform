import { DomainError, type CallOptions, type CatalogItemContext, type CatalogPort, type Money, type ShippingOffer } from '@r4-adapters/domains';

/** One selected line of an order basis: a Catalog sellable-item key and its quantity. */
export interface ShippingBasisItem {
  readonly productId: string;
  readonly quantity: number;
}

export interface ResolvedOrderBasis {
  readonly totalWeightKg: number;
  readonly declaredValueGross: Money;
}

/**
 * Resolves an order basis from the Catalog owner's data (R4-J2B), so no
 * weight or price ever comes from the model:
 *
 * - weight: the owner's product-level `facts.weightKg` × quantity, summed in
 *   whole grams (no floating-point drift); null weight fails closed;
 * - declared value: the owner's effective unit `finalGross` for that quantity
 *   tier × quantity, summed — the gross product subtotal, shipping excluded.
 *   Catalog pricing is used as given, never recomputed; cart/quote-wide
 *   discounts are outside J2 v1.
 *
 * Any line that is unknown, needs a variant, or has no price or weight fails
 * the whole basis: never a partial total.
 */
export async function resolveOrderBasis(catalog: CatalogPort, items: readonly ShippingBasisItem[], options?: CallOptions): Promise<ResolvedOrderBasis> {
  const contexts = await Promise.all(items.map((item) => catalog.getItemContext({ itemKey: item.productId, quantity: item.quantity }, options)));
  const found = contexts.map((context, i) => requireFound(context, items[i]!.productId));
  const productKeys = [...new Set(found.map((c) => c.parentProduct.productKey))];
  const weights = new Map<string, number>();
  await Promise.all(
    productKeys.map(async (productKey) => {
      const product = await catalog.getProductContext(productKey, options);
      if (product.status !== 'found') throw new DomainError('validation', 'shipping_item_not_found', 'a selected item is not in the catalog', { productKey });
      if (product.facts.weightKg === null) throw new DomainError('validation', 'shipping_item_weight_unavailable', 'the catalog has no weight for a selected product', { productKey });
      weights.set(productKey, product.facts.weightKg);
    }),
  );
  let grams = 0;
  let declared = 0;
  found.forEach((context, i) => {
    const quantity = items[i]!.quantity;
    if (context.pricing.status !== 'available') throw new DomainError('validation', 'shipping_item_price_unavailable', 'the catalog has no price for a selected item', { itemKey: context.itemKey });
    grams += Math.round(weights.get(context.parentProduct.productKey)! * 1000) * quantity;
    declared += context.pricing.finalGross.amount * quantity;
  });
  return { totalWeightKg: grams / 1000, declaredValueGross: { amount: declared, currency: 'CLP' } };
}

function requireFound(context: CatalogItemContext, itemKey: string): Extract<CatalogItemContext, { status: 'found' }> {
  if (context.status === 'not_found') throw new DomainError('validation', 'shipping_item_not_found', 'a selected item is not in the catalog', { itemKey });
  if (context.status === 'variant_required') throw new DomainError('validation', 'shipping_item_variant_required', 'a selected product needs a variant before shipping can be quoted', { itemKey });
  return context;
}

/**
 * Reference-basis helper: the lowest customer gross among the owner's
 * offers, or null when there is none. It is a "delivery starts around"
 * reference for a small package — NOT a selected offer, NOT an owner
 * recommendation, NOT a guaranteed minimum and NOT a checkout price. It
 * never reorders or marks the offers.
 */
export function referenceLowestGross(offers: readonly ShippingOffer[]): Money | null {
  let lowest: number | null = null;
  for (const offer of offers) if (lowest === null || offer.price.customerGross.amount < lowest) lowest = offer.price.customerGross.amount;
  return lowest === null ? null : { amount: lowest, currency: 'CLP' };
}
