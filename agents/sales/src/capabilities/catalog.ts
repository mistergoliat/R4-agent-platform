import { z } from 'zod';
import type { CatalogService } from '@r4-adapters/domains';
import type { CapabilityRegistration } from '@r4/capability-runtime';
import { CAPABILITY_IDS, SCOPES } from '../ids.js';
import { domainRead, moneySchema, readDefinition } from './common.js';

/** How long a catalog answer (price, stock) may be treated as current. The owner's data, the owner's window. */
export const CATALOG_FRESHNESS_TTL_MS = 15 * 60_000;

const stockSchema = z.strictObject({ status: z.enum(['in_stock', 'low_stock', 'out_of_stock', 'discontinued']), units: z.int().nonnegative() });
const summarySchema = z.strictObject({
  productId: z.string(),
  name: z.string(),
  category: z.string(),
  brand: z.string(),
  unitPrice: moneySchema,
  stock: stockSchema,
  recordVersion: z.int().positive(),
  updatedAt: z.string(),
});

export const catalogSearchInput = z.strictObject({
  text: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  maxUnitPrice: z.int().positive().optional(),
  inStockOnly: z.boolean().optional(),
  limit: z.int().min(1).max(20).default(10),
});
export const catalogSearchOutput = z.strictObject({
  totalMatches: z.int().nonnegative(),
  categories: z.array(z.string()),
  results: z.array(summarySchema),
});

export const productContextInput = z.strictObject({ productId: z.string().trim().min(1).max(48) });
export const productContextOutput = z.union([
  z.strictObject({ found: z.literal(false), productId: z.string() }),
  z.strictObject({
    found: z.literal(true),
    product: summarySchema.extend({
      description: z.string(),
      weightKg: z.number().nonnegative(),
      footprintCm: z.strictObject({ width: z.number(), depth: z.number(), height: z.number() }).nullable(),
      specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      compatibleWith: z.array(z.string()),
      alternatives: z.array(z.string()),
    }),
  }),
]);

/** Read-only by construction: the Catalog port offers no write, and both capabilities are READ. */
export function catalogCapabilities(catalog: CatalogService): [CapabilityRegistration<z.infer<typeof catalogSearchInput>, z.infer<typeof catalogSearchOutput>>, CapabilityRegistration<z.infer<typeof productContextInput>, z.infer<typeof productContextOutput>>] {
  return [
    {
      definition: readDefinition({
        capabilityId: CAPABILITY_IDS.catalogSearch,
        description: 'Searches the store catalog (owner: Catalog). Filters by free text, category, maximum unit price (CLP) and availability; returns product ids with current price and stock as of now. It applies no recommendation logic.',
        owner: 'catalog',
        requiredScopes: [SCOPES.catalogRead],
        freshnessTtlMs: CATALOG_FRESHNESS_TTL_MS,
      }),
      input: catalogSearchInput,
      output: catalogSearchOutput,
      handler: (input, context) => domainRead(async () => {
        const answer = await catalog.search(
          { limit: input.limit, ...(input.text ? { text: input.text } : {}), ...(input.category ? { category: input.category } : {}), ...(input.maxUnitPrice ? { maxUnitPrice: input.maxUnitPrice } : {}), ...(input.inStockOnly ? { inStockOnly: true } : {}) },
          { signal: context.signal },
        );
        return { totalMatches: answer.totalMatches, categories: [...answer.categories], results: answer.results.map((r) => ({ ...r })) };
      }),
    },
    {
      definition: readDefinition({
        capabilityId: CAPABILITY_IDS.productContext,
        description: 'Reads one product from the catalog (owner: Catalog) by product id: description, specifications, weight, footprint, current price and stock, compatible accessories and declared alternatives. Answers found=false for an unknown id.',
        owner: 'catalog',
        requiredScopes: [SCOPES.catalogRead],
        freshnessTtlMs: CATALOG_FRESHNESS_TTL_MS,
      }),
      input: productContextInput,
      output: productContextOutput,
      handler: (input, context) => domainRead(async () => {
        const product = await catalog.getProduct(input.productId, { signal: context.signal });
        return product ? { found: true as const, product: { ...product, specs: { ...product.specs }, compatibleWith: [...product.compatibleWith], alternatives: [...product.alternatives] } } : { found: false as const, productId: input.productId };
      }),
    },
  ];
}
