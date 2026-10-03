import { z } from 'zod';
import type { CatalogPort, ShippingService } from '@r4-adapters/domains';
import type { CapabilityRegistration } from '@r4/capability-runtime';
import { CAPABILITY_IDS, SCOPES } from '../ids.js';
import { domainRead, itemQuantitySchema, moneySchema, readDefinition } from './common.js';
import { referenceLowestGross, resolveOrderBasis } from './shipping-basis.js';

/** R4-side runtime freshness of a shipping observation. The owner publishes no quote validity (ownerValidUntil is always null). */
export const SHIPPING_FRESHNESS_TTL_MS = 15 * 60_000;

export const shippingQuoteInput = z
  .strictObject({
    destination: z.strictObject({ commune: z.string().trim().min(2).max(80) }),
    /** reference = a small reference package before products are known; order = the listed items. */
    basis: z.enum(['reference', 'order']),
    /** Required for basis=order, forbidden for basis=reference. */
    items: z.array(itemQuantitySchema).min(1).max(20).optional(),
  })
  .refine((input) => (input.basis === 'order') === (input.items !== undefined), { message: 'items are required for basis=order and not allowed for basis=reference', path: ['items'] });

const netSchema = z.strictObject({ amount: z.number().nonnegative(), currency: z.literal('CLP') });

export const shippingQuoteOutput = z.strictObject({
  destination: z.strictObject({ communeId: z.string(), communeName: z.string(), regionName: z.string() }),
  basis: z.strictObject({
    type: z.enum(['reference', 'order']),
    weightKg: z.number().positive(),
    declaredValue: z.strictObject({ amount: z.int().nonnegative(), currency: z.literal('CLP'), taxIncluded: z.literal(true) }).nullable(),
    dimensionsCm: z.strictObject({ height: z.literal(1), width: z.literal(1), depth: z.literal(1), source: z.literal('production_convention') }),
  }),
  /** Echo of what was quoted (empty for basis=reference), so the evidence says which selection it is for. */
  requestedItems: z.array(itemQuantitySchema),
  serviceable: z.boolean(),
  offers: z.array(
    z.strictObject({
      carrierName: z.string(),
      serviceType: z.string(),
      price: z.strictObject({
        ownerNet: netSchema,
        tax: z.strictObject({ policy: z.string(), rate: z.number(), amount: z.number() }),
        customerGross: moneySchema,
        grossDerivedBy: z.literal('r4_shipping_adapter'),
      }),
      estimatedDelivery: z.string().nullable(),
      ownerPosition: z.int().nonnegative(),
    }),
  ),
  /** basis=reference only: the lowest customerGross among the offers (null otherwise, or with no offers). */
  referenceLowestGross: moneySchema.nullable(),
  asOf: z.string(),
  ownerValidUntil: z.null(),
  provenance: z.strictObject({ owner: z.string(), endpoint: z.string(), ownerContractVersion: z.string() }),
});

/**
 * Structured arguments in, the Shipping owner's prices out (R4-J2B). For
 * basis=order the weight and declared value are resolved from the Catalog
 * owner, never taken from the model. Logistics never live in the prompt.
 */
export function shippingCapability(shipping: ShippingService, catalog: CatalogPort): CapabilityRegistration<z.infer<typeof shippingQuoteInput>, z.infer<typeof shippingQuoteOutput>> {
  return {
    definition: readDefinition({
      capabilityId: CAPABILITY_IDS.shippingQuote,
      description:
        'Asks the Shipping owner what delivery to a destination commune costs (CLP). basis=reference (no items) prices a small 1 kg reference package, for when the customer asks before choosing products: referenceLowestGross is only an approximate starting point ("desde aprox."), never a quote or a guaranteed minimum, and the final cost depends on the weight and size of the products. basis=order prices the listed catalog items (itemKeys and quantities; weight and value come from the catalog). Every carrier offer is returned in the owner\'s order, which is not a price ranking; the customer chooses, never pick one for them. price.customerGross is the tax-included amount to tell the customer (derived by R4 from the owner\'s net); price.ownerNet is the owner\'s net. An unknown commune fails; serviceable=false means no carrier delivers there. Valid for that destination and basis only; it is not a checkout guarantee.',
      owner: 'shipping',
      requiredScopes: [SCOPES.shippingRead],
      freshnessTtlMs: SHIPPING_FRESHNESS_TTL_MS,
    }),
    input: shippingQuoteInput,
    output: shippingQuoteOutput,
    handler: (input, context) =>
      domainRead(async () => {
        const items = input.basis === 'order' ? (input.items ?? []) : [];
        const basis = input.basis === 'order' ? { type: 'order' as const, ...(await resolveOrderBasis(catalog, items, { signal: context.signal })) } : { type: 'reference' as const };
        const quote = await shipping.quote({ destination: { commune: input.destination.commune }, basis }, { signal: context.signal });
        const offers = quote.offers.map((o) => ({
          carrierName: o.carrierName,
          serviceType: o.serviceType,
          price: { ownerNet: { ...o.price.ownerNet }, tax: { ...o.price.tax }, customerGross: { ...o.price.customerGross }, grossDerivedBy: o.price.grossDerivedBy },
          estimatedDelivery: o.estimatedDelivery,
          ownerPosition: o.ownerPosition,
        }));
        return {
          destination: { ...quote.destination },
          basis: { type: quote.basis.type, weightKg: quote.basis.weightKg, declaredValue: quote.basis.declaredValue ? { ...quote.basis.declaredValue } : null, dimensionsCm: { ...quote.basis.dimensionsCm } },
          requestedItems: items.map((i) => ({ ...i })),
          serviceable: quote.serviceable,
          offers,
          referenceLowestGross: quote.basis.type === 'reference' ? referenceLowestGross(quote.offers) : null,
          asOf: quote.asOf,
          ownerValidUntil: null,
          provenance: { ...quote.provenance },
        };
      }),
  };
}
