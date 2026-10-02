import { z } from 'zod';

/**
 * Wire schemas of the pc-carrier read contract (Swagger "PC Carrier API"
 * v1.2.0, verified against production in the R4-J2A audit).
 *
 * Compatibility policy (same as the Catalog adapter):
 * - Objects are NOT strict: an unknown additional field is tolerated and
 *   dropped (additive owner evolution never breaks R4).
 * - Every field R4 uses is REQUIRED and typed — no defaults, no coercion —
 *   except `estimated_delivery`, which the owner omits for some carriers.
 * - A payload that violates the schema is rejected, never repaired.
 */
export const PC_CARRIER_CONTRACT_VERSION = '1.2.0';

const name = z.string().trim().min(1).max(200);
const ownerId = z.int().nonnegative();

/** GET /location — Region > Ciudad > Comuna (HTTP 200). */
export const pcCarrierLocationsSchema = z
  .array(
    z.object({
      id_region: ownerId,
      region_name: name,
      ciudades: z.array(
        z.object({
          id_city: ownerId,
          city_name: name,
          comunas: z.array(z.object({ id_comuna: ownerId, comuna_name: name })),
        }),
      ),
    }),
  )
  .min(1);

export type PcCarrierLocations = z.output<typeof pcCarrierLocationsSchema>;

/** GET /carrier/v1/all — shipping options (HTTP 202). The owner's order is preserved; it is not a price ranking. */
export const pcCarrierQuoteSchema = z.object({
  options: z.array(
    z.object({
      carrier_name: name,
      service_type: z.string().max(200),
      /** NET CLP (owner-confirmed, R4-J2A). */
      total_cost: z.number().nonnegative(),
      estimated_delivery: z.string().max(200).nullable().optional(),
    }),
  ),
});

export type PcCarrierQuote = z.output<typeof pcCarrierQuoteSchema>;
