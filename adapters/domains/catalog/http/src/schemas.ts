import { z } from 'zod';
import { CATALOG_KEY_PATTERN, CATALOG_SELLABILITY, CATALOG_SELLABILITY_REASONS, CATALOG_SELLABILITY_REASON_VALUES } from '@r4-adapters/domains';

/**
 * Wire schemas of the Catalog read contract, schemaVersion 1, converged with
 * the owner's executable contract (catalog-service
 * `src/domain/catalog/v2/contracts.ts`; R4-J1C §3). Field names and text
 * bounds are the owner's, verbatim; the owner's published fixtures
 * (`../fixtures`, pinned by MANIFEST.json) are the test oracle.
 *
 * Compatibility policy:
 * - `schemaVersion` changes only on a breaking change; any other version is
 *   rejected before parsing (contract_violation).
 * - Objects are NOT strict: an unknown additional field is tolerated and
 *   dropped (additive evolution by the owner never breaks R4). Owner fields
 *   R4 does not use (weight, stock totals, the default-variant flag, product-level leadTime)
 *   are dropped the same way.
 * - Every field R4 uses is REQUIRED and typed: a missing or mistyped known
 *   field is rejected — no defaults, no coercion.
 * - The contract's invariants are checked (identity shape, sellability/reason
 *   pairing, completeness, price ordering, freshness ordering). A payload that
 *   violates them is rejected, never repaired.
 *
 * Nothing here computes: a refinement only compares values the owner sent.
 */
export const CATALOG_SCHEMA_VERSION = 1;

/** Opaque owner key: bounded and path-safe. Its structure is never interpreted. */
export const catalogKeySchema = z.string().regex(CATALOG_KEY_PATTERN, 'an opaque catalog key');
const idSchema = z.string().min(1).max(32);
const timestamp = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().min(1).max(max);
// Owner bounds (PrestaShop source columns): names 128, sku 64, brand 64, feature value 255.
const nameText = text(128);
const skuText = text(64);

const money = z.object({ amount: z.int().nonnegative(), currency: z.literal('CLP') });
const category = z.object({ id: idSchema, name: nameText });
const productIds = z.object({ productId: idSchema });
const itemIds = z.object({ productId: idSchema, variantId: idSchema.nullable() });
const sellableItem = z.object({ itemKey: catalogKeySchema, ref: itemIds });
const attribute = z.object({ group: nameText, value: nameText });
const specification = z.object({ name: nameText, value: text(255) });
const productStatus = z.object({ active: z.boolean(), listed: z.boolean(), orderable: z.boolean() });
const provenance = z.object({ source: text(64), service: text(64), serviceBuildRef: text(128).nullable(), sourceUpdatedAt: timestamp.nullable() });

const freshness = z
  .object({
    asOf: timestamp,
    cache: z.object({ hit: z.boolean(), ageMs: z.int().nonnegative() }),
    validUntil: timestamp.nullable(),
  })
  .superRefine((f, ctx) => {
    if (f.validUntil !== null && Date.parse(f.validUntil) < Date.parse(f.asOf)) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'validUntil precedes asOf' });
  });

const sellability = z.enum(CATALOG_SELLABILITY);
const reason = z.enum(CATALOG_SELLABILITY_REASON_VALUES);
function checkReason(value: { sellability: (typeof CATALOG_SELLABILITY)[number]; reason: string }, ctx: z.RefinementCtx): void {
  if (!(CATALOG_SELLABILITY_REASONS[value.sellability] as readonly string[]).includes(value.reason)) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: `reason ${value.reason} is not valid for sellability ${value.sellability}` });
  }
}

const priceSummary = z
  .object({ kind: z.enum(['exact', 'from']), basis: z.enum(['offerable', 'not_offerable']), finalGross: money, regularGross: money, discounted: z.boolean() })
  .superRefine((p, ctx) => {
    if (p.finalGross.amount > p.regularGross.amount) ctx.addIssue({ code: 'custom', path: ['finalGross'], message: 'final price above regular price' });
    if (p.discounted !== p.finalGross.amount < p.regularGross.amount) ctx.addIssue({ code: 'custom', path: ['discounted'], message: 'discounted disagrees with the prices' });
  });

const availabilitySummary = z
  .object({ sellability, reason, sellableVariants: z.int().nonnegative().nullable() })
  .superRefine(checkReason);

// ---- A. search (PRODUCT-level: productKey, never itemKey) -------------------------------

const searchResult = z
  .object({
    productKey: catalogKeySchema,
    ref: productIds,
    name: nameText,
    sku: skuText.nullable(),
    category: category.nullable(),
    variants: z.object({ count: z.int().nonnegative(), requiresSelection: z.boolean() }),
    priceSummary: priceSummary.nullable(),
    availabilitySummary,
    match: z.object({ type: text(40), matchedTokens: z.int().nonnegative(), totalTokens: z.int().positive() }),
  })
  .superRefine((r, ctx) => {
    if (r.variants.count === 0 && r.variants.requiresSelection) ctx.addIssue({ code: 'custom', path: ['variants'], message: 'a product without variants cannot require a selection' });
    if (r.priceSummary?.kind === 'from' && r.variants.count === 0) ctx.addIssue({ code: 'custom', path: ['priceSummary', 'kind'], message: 'a "from" price needs variants' });
    if ((r.availabilitySummary.sellableVariants === null) !== (r.variants.count === 0)) ctx.addIssue({ code: 'custom', path: ['availabilitySummary', 'sellableVariants'], message: 'sellableVariants must be counted exactly when the product has variants' });
  });

export const catalogSearchResponseSchema = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    results: z.array(searchResult).max(10),
    completeness: z.object({ totalMatches: z.int().nonnegative(), truncated: z.boolean() }),
    searchMode: text(40),
    freshness,
  })
  .superRefine((r, ctx) => {
    const { totalMatches, truncated } = r.completeness;
    if (totalMatches < r.results.length) ctx.addIssue({ code: 'custom', path: ['completeness', 'totalMatches'], message: 'fewer total matches than results' });
    if (truncated !== totalMatches > r.results.length) ctx.addIssue({ code: 'custom', path: ['completeness', 'truncated'], message: 'truncated disagrees with totalMatches' });
    // Deduplication is the owner's job; a duplicated identity is a contract violation, not something R4 merges.
    if (new Set(r.results.map((x) => x.productKey)).size !== r.results.length) ctx.addIssue({ code: 'custom', path: ['results'], message: 'duplicated productKey in results' });
  });

// ---- B. product context --------------------------------------------------------

const frequentlyBoughtTogether = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    snapshotId: text(128),
    builtAt: timestamp,
    items: z.array(z.object({ productKey: catalogKeySchema, name: nameText, confidence: z.number().min(0).max(1), jointCount: z.int().nonnegative() })).max(5),
  }),
  z.object({ status: z.literal('unavailable'), reason: text(64) }),
]);

const productFound = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    status: z.literal('found'),
    productKey: catalogKeySchema,
    ref: productIds,
    facts: z.object({
      name: nameText,
      sku: skuText.nullable(),
      category: category.nullable(),
      brand: text(64).nullable(),
      shortDescription: z.string().max(600).nullable(),
      specifications: z.array(specification).max(40),
      status: productStatus,
      sellableItem: sellableItem.nullable(),
      variantOptions: z.array(z.object({ itemKey: catalogKeySchema, ref: itemIds, sku: skuText.nullable(), attributes: z.array(attribute).max(10) })).max(100),
    }),
    derived: z.object({ priceSummary: priceSummary.nullable(), availability: availabilitySummary, publicUrl: z.url().max(500).nullable() }),
    inferred: z.object({ frequentlyBoughtTogether }),
    provenance,
    freshness,
  })
  .superRefine((p, ctx) => {
    const { facts, ref } = p;
    const options = facts.variantOptions;
    if ((facts.sellableItem === null) === (options.length === 0)) ctx.addIssue({ code: 'custom', path: ['facts', 'sellableItem'], message: 'sellableItem must be present exactly when the product has no variants' });
    if (facts.sellableItem && (facts.sellableItem.ref.variantId !== null || facts.sellableItem.ref.productId !== ref.productId)) ctx.addIssue({ code: 'custom', path: ['facts', 'sellableItem'], message: 'the product-level sellable item must be this product with variantId null' });
    options.forEach((o, i) => {
      if (o.ref.variantId === null || o.ref.productId !== ref.productId) ctx.addIssue({ code: 'custom', path: ['facts', 'variantOptions', i, 'ref'], message: 'a variant option must name a variant of this product' });
    });
    if (new Set(options.map((o) => o.itemKey)).size !== options.length) ctx.addIssue({ code: 'custom', path: ['facts', 'variantOptions'], message: 'duplicated itemKey' });
    if (p.derived.priceSummary?.kind === 'from' && options.length === 0) ctx.addIssue({ code: 'custom', path: ['derived', 'priceSummary', 'kind'], message: 'a "from" price needs variants' });
    if ((p.derived.availability.sellableVariants === null) !== (options.length === 0)) ctx.addIssue({ code: 'custom', path: ['derived', 'availability', 'sellableVariants'], message: 'sellableVariants must be counted exactly when the product has variants' });
    if (!facts.status.active && p.derived.availability.sellability !== 'not_sellable') ctx.addIssue({ code: 'custom', path: ['derived', 'availability'], message: 'an inactive product cannot be sellable' });
  });

export const catalogProductContextResponseSchema = z.discriminatedUnion('status', [
  z.object({ schemaVersion: z.literal(CATALOG_SCHEMA_VERSION), status: z.literal('not_found'), productKey: catalogKeySchema }),
  productFound,
]);

// ---- C. item context -------------------------------------------------------------

const pricing = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      quantity: z.int().positive(),
      regularGross: money,
      finalGross: money,
      promotion: z
        .discriminatedUnion('type', [
          z.object({ type: z.literal('percentage'), percentOff: z.number().gt(0).max(1), amountOffGross: z.null(), validUntil: timestamp.nullable() }),
          z.object({ type: z.literal('amount'), percentOff: z.null(), amountOffGross: money, validUntil: timestamp.nullable() }),
        ])
        .nullable(),
      tax: z.object({ included: z.literal(true), rate: z.number().min(0).max(1), basis: text(64) }),
      engineVersion: text(64),
    })
    .superRefine((p, ctx) => {
      if (p.finalGross.amount > p.regularGross.amount) ctx.addIssue({ code: 'custom', path: ['finalGross'], message: 'final price above regular price' });
    }),
  z.object({ status: z.literal('unavailable'), reason: text(64) }),
]);

const itemFound = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    status: z.literal('found'),
    itemKey: catalogKeySchema,
    ref: itemIds,
    parentProduct: z.object({ productKey: catalogKeySchema, name: nameText, sku: skuText.nullable() }),
    variant: z.object({ variantId: idSchema.nullable(), sku: skuText.nullable(), attributes: z.array(attribute).max(10) }),
    pricing,
    availability: z.object({ sellability, reason, availableQuantity: z.int().nullable(), leadTime: z.null() }).superRefine(checkReason),
    provenance,
    freshness,
  })
  .superRefine((i, ctx) => {
    if (i.variant.variantId !== i.ref.variantId) ctx.addIssue({ code: 'custom', path: ['variant', 'variantId'], message: 'variant and item ref disagree' });
  });

export const catalogItemContextResponseSchema = z.discriminatedUnion('status', [
  z.object({ schemaVersion: z.literal(CATALOG_SCHEMA_VERSION), status: z.literal('not_found'), itemKey: catalogKeySchema }),
  z.object({ schemaVersion: z.literal(CATALOG_SCHEMA_VERSION), status: z.literal('variant_required'), itemKey: catalogKeySchema, productKey: catalogKeySchema }),
  itemFound,
]);

/** The owner's typed failure body (non-2xx). Only a bounded code is kept; the message is never trusted as text for the model. */
export const catalogErrorBodySchema = z.object({ error: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), retryable: z.boolean().optional() }) });
