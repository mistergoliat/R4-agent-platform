import { z } from 'zod';
import { MUSCLE_GROUPS } from './classify.js';

/**
 * ADR-058: the store's product graph, as a signed Artifact of kind `product-graph`. Core stores it opaque; this is its
 * schema. The shape is the one the web chat tools already read (`R4_EXP_GRAPH_FILE`, ADR-046), plus `unreviewed`:
 * the published relations the owner has not reviewed yet (still in use, marked). A relation `[area, a, b]` is
 * published as `view[a]['<area>:a']` ∋ b and `view[b]['<area>:b']` ∋ a.
 */
export const PRODUCT_GRAPH_KIND = 'product-graph';

const productKey = z.string().regex(/^P[1-9]\d{0,8}$/u);
const area = z.string().regex(/^[a-z]{1,8}$/u);
const directedArea = z.string().regex(/^[a-z]{1,8}:[ab]$/u);

export const productGraphSchema = z.object({
  schemaVersion: z.literal(1),
  builtAt: z.string().max(40).optional(),
  source: z.string().max(300).optional(),
  labels: z.record(directedArea, z.string().min(1).max(80)),
  products: z.record(productKey, z.object({
    n: z.string().max(300).nullable(),
    act: z.boolean().nullable(),
    price: z.number().nonnegative().nullable(),
    kind: z.string().max(60).nullable().default(null),
    // ADR-058 Decision 8: the muscle groups it trains (optional; absent in versions before G2b).
    muscles: z.array(z.enum(MUSCLE_GROUPS)).max(MUSCLE_GROUPS.length).optional(),
  })),
  view: z.record(productKey, z.record(directedArea, z.array(productKey))),
  unreviewed: z.array(z.tuple([area, productKey, productKey])).default([]),
}).superRefine((g, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  for (const [key, groups] of Object.entries(g.view)) {
    if (!g.products[key]) issue(`view ${key} is not a product`);
    for (const [a, neighbours] of Object.entries(groups)) {
      if (!g.labels[a]) issue(`area ${a} has no label`);
      for (const n of neighbours) if (!g.products[n]) issue(`${key} ${a} → ${n} is not a product`);
    }
  }
  for (const [ar, a, b] of g.unreviewed) {
    if (!g.view[a]?.[`${ar}:a`]?.includes(b) || !g.view[b]?.[`${ar}:b`]?.includes(a)) issue(`unreviewed ${ar} ${a}–${b} is not a published relation`);
  }
});

export type ProductGraph = z.infer<typeof productGraphSchema>;

/** Counts for logs and the console: products, relations (each pair once) and how many are unreviewed. */
export function graphStats(g: ProductGraph): { products: number; relations: number; unreviewed: number } {
  let directed = 0;
  for (const groups of Object.values(g.view)) for (const neighbours of Object.values(groups)) directed += neighbours.length;
  return { products: Object.keys(g.products).length, relations: directed / 2, unreviewed: g.unreviewed.length };
}
