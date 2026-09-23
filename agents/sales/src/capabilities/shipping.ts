import { z } from 'zod';
import type { ShippingService } from '@r4-adapters/domains';
import type { CapabilityRegistration } from '@r4/capability-runtime';
import { CAPABILITY_IDS, SCOPES } from '../ids.js';
import { destinationSchema, domainRead, itemQuantitySchema, moneySchema, readDefinition } from './common.js';

export const shippingQuoteInput = z.strictObject({
  destination: destinationSchema,
  items: z.array(itemQuantitySchema).min(1).max(20),
});
export const shippingQuoteOutput = z.strictObject({
  destination: z.strictObject({ commune: z.string(), region: z.string().nullable() }),
  /** Echo of what was quoted, so the evidence says which selection it is for. */
  requestedItems: z.array(itemQuantitySchema),
  serviceable: z.boolean(),
  options: z.array(z.strictObject({ serviceLevel: z.enum(['standard', 'express']), amount: moneySchema, etaBusinessDays: z.strictObject({ min: z.int(), max: z.int() }) })),
  totalWeightKg: z.number().nonnegative(),
  quotedAt: z.string(),
});

/** Structured arguments in, the Shipping owner's calculation out: logistics never live in the prompt. */
export function shippingCapability(shipping: ShippingService): CapabilityRegistration<z.infer<typeof shippingQuoteInput>, z.infer<typeof shippingQuoteOutput>> {
  return {
    definition: readDefinition({
      capabilityId: CAPABILITY_IDS.shippingQuote,
      description: 'Asks the Shipping owner for delivery options and cost (CLP) to a destination commune for a list of product ids and quantities. The answer is valid for that destination and that list only.',
      owner: 'shipping',
      requiredScopes: [SCOPES.shippingRead],
      freshnessTtlMs: 30 * 60_000,
    }),
    input: shippingQuoteInput,
    output: shippingQuoteOutput,
    handler: (input, context) => domainRead(async () => {
      const quote = await shipping.quote({ destination: { commune: input.destination.commune, region: input.destination.region ?? null }, items: input.items }, { signal: context.signal });
      return {
        destination: { ...quote.destination },
        requestedItems: input.items.map((i) => ({ ...i })),
        serviceable: quote.serviceable,
        options: quote.options.map((o) => ({ serviceLevel: o.serviceLevel, amount: { ...o.amount }, etaBusinessDays: { ...o.etaBusinessDays } })),
        totalWeightKg: quote.totalWeightKg,
        quotedAt: quote.quotedAt,
      };
    }),
  };
}
