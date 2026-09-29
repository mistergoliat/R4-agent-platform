import { z } from 'zod';
import { CATALOG_KEY_PATTERN, CATALOG_SELLABILITY, CATALOG_SELLABILITY_REASONS, CATALOG_SELLABILITY_REASON_VALUES } from '@r4-adapters/domains';

/**
 * Wire schemas of the Catalog read contract, schemaVersion 1
 * (docs/architecture/R4-J1B_CATALOG_CONSUMER_IMPLEMENTATION.md §2).
 *
 * Compatibility policy:
 * - `schemaVersion` changes only on a breaking change; any other version is
 *   rejected before parsing (contract_violation).
 * - Objects are NOT strict: an unknown additional field is tolerated and
 *   dropped (additive evolution by the owner never breaks R4).
 * - Every field R4 uses is typed, and the contract's invariants are checked
 *   (identity shape, sellability/reason pairing, completeness, price
 *   ordering, freshness ordering). A payload that violates them is rejected,
 *   never repaired.
 *
 * Nothing here computes: a refinement only compares values the owner sent.
 */
export const CATALOG_SCHEMA_VERSION = 1;

/** Opaque owner key: bounded and path-safe. Its structure is never interpreted. */
export const catalogKeySchema = z.string().regex(CATALOG_KEY_PATTERN, 'an opaque catalog key');
const idSchema = z.string().min(1).max(32);
const timestamp = z.iso.datetime({ offset: true });
const shortText = (max: number) => z.string().min(1).max(max);

const money = z.object({ amount: z.int().nonnegative(), currency: z.literal('CLP') });
const category = z.object({ id: idSchema, name: shortText(120) });
const productRef = z.object({ productId: idSchema, productKey: catalogKeySchema });
const itemRef = z.object({ productId: idSchema, variantId: idSchema.nullable(), itemKey: catalogKeySchema });
const attribute = z.object({ group: shortText(120), value: shortText(120) });
const specification = z.object({ name: shortText(120), value: shortText(300) });
const lifecycle = z.object({ status: z.enum(['active', 'inactive']), listed: z.boolean(), orderable: z.boolean() });
const provenance = z.object({ source: shortText(64), service: shortText(64), serviceBuildRef: shortText(128).nullable() });

const freshness = z
  .object({
    asOf: timestamp,
    cache: z.object({ hit: z.boolean(), ageMs: z.int().nonnegative() }),
    validUntil: timestamp.nullable(),
    sourceUpdatedAt: timestamp.nullable().default(null),
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
  .object({ kind: z.enum(['exact', 'from']), finalGross: money, regularGross: money, discounted: z.boolean() })
  .superRefine((p, ctx) => {
    if (p.finalGross.amount > p.regularGross.amount) ctx.addIssue({ code: 'custom', path: ['finalGross'], message: 'final price above regular price' });
    if (p.discounted !== p.finalGross.amount < p.regularGross.amount) ctx.addIssue({ code: 'custom', path: ['discounted'], message: 'discounted disagrees with the prices' });
  });

const availabilitySummary = z
  .object({ sellability, reason, sellableVariants: z.int().nonnegative().nullable() })
  .superRefine(checkReason);

// ---- A. search ------------------------------------------------------------------

const searchResult = z
  .object({
    product: productRef,
    name: shortText(200),
    sku: shortText(64).nullable(),
    category: category.nullable(),
    variants: z.object({ count: z.int().nonnegative(), requiresSelection: z.boolean() }),
    priceSummary: priceSummary.nullable(),
    availabilitySummary,
    match: z.object({ type: shortText(40), matchedTokens: z.int().nonnegative(), totalTokens: z.int().positive() }),
  })
  .superRefine((r, ctx) => {
    if (r.variants.count === 0 && r.variants.requiresSelection) ctx.addIssue({ code: 'custom', path: ['variants'], message: 'a product without variants cannot require a selection' });
    if (r.priceSummary?.kind === 'from' && r.variants.count === 0) ctx.addIssue({ code: 'custom', path: ['priceSummary', 'kind'], message: 'a "from" price needs variants' });
  });

export const catalogSearchResponseSchema = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    results: z.array(searchResult).max(10),
    completeness: z.object({ totalMatches: z.int().nonnegative(), truncated: z.boolean() }),
    searchMode: shortText(40),
    freshness,
  })
  .superRefine((r, ctx) => {
    const { totalMatches, truncated } = r.completeness;
    if (totalMatches < r.results.length) ctx.addIssue({ code: 'custom', path: ['completeness', 'totalMatches'], message: 'fewer total matches than results' });
    if (truncated !== totalMatches > r.results.length) ctx.addIssue({ code: 'custom', path: ['completeness', 'truncated'], message: 'truncated disagrees with totalMatches' });
    // Deduplication is the owner's job; a duplicated identity is a contract violation, not something R4 merges.
    if (new Set(r.results.map((x) => x.product.productKey)).size !== r.results.length) ctx.addIssue({ code: 'custom', path: ['results'], message: 'duplicated productKey in results' });
  });

// ---- B. product context --------------------------------------------------------

const frequentlyBoughtTogether = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    snapshotId: shortText(128),
    builtAt: timestamp,
    items: z.array(z.object({ product: productRef, name: shortText(200), confidence: z.number().min(0).max(1), jointCount: z.int().nonnegative() })).max(10),
  }),
  z.object({ status: z.literal('unavailable'), reason: shortText(64) }),
]);

const productFound = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    status: z.literal('found'),
    product: productRef,
    facts: z.object({
      name: shortText(200),
      sku: shortText(64).nullable(),
      category: category.nullable(),
      brand: shortText(120).nullable(),
      shortDescription: z.string().max(600).nullable(),
      specifications: z.array(specification).max(40),
      lifecycle,
      sellableItem: itemRef.nullable(),
      variantOptions: z.array(z.object({ item: itemRef, sku: shortText(64).nullable(), attributes: z.array(attribute).max(10) })).max(50),
    }),
    derived: z.object({ priceSummary: priceSummary.nullable(), availability: availabilitySummary, publicUrl: z.url().max(500).nullable() }),
    inferred: z.object({ frequentlyBoughtTogether }),
    provenance,
    freshness,
  })
  .superRefine((p, ctx) => {
    const { facts, product } = p;
    const options = facts.variantOptions;
    if ((facts.sellableItem === null) === (options.length === 0)) ctx.addIssue({ code: 'custom', path: ['facts', 'sellableItem'], message: 'sellableItem must be present exactly when the product has no variants' });
    if (facts.sellableItem && (facts.sellableItem.variantId !== null || facts.sellableItem.productId !== product.productId)) ctx.addIssue({ code: 'custom', path: ['facts', 'sellableItem'], message: 'the product-level sellable item must be this product with variantId null' });
    options.forEach((o, i) => {
      if (o.item.variantId === null || o.item.productId !== product.productId) ctx.addIssue({ code: 'custom', path: ['facts', 'variantOptions', i, 'item'], message: 'a variant option must name a variant of this product' });
    });
    if (new Set(options.map((o) => o.item.itemKey)).size !== options.length) ctx.addIssue({ code: 'custom', path: ['facts', 'variantOptions'], message: 'duplicated itemKey' });
    if (p.derived.priceSummary?.kind === 'from' && options.length === 0) ctx.addIssue({ code: 'custom', path: ['derived', 'priceSummary', 'kind'], message: 'a "from" price needs variants' });
    if (facts.lifecycle.status === 'inactive' && p.derived.availability.sellability !== 'not_sellable') ctx.addIssue({ code: 'custom', path: ['derived', 'availability'], message: 'an inactive product cannot be sellable' });
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
      lineFinalGross: money,
      promotion: z.object({ kind: z.enum(['amount', 'percentage']), value: z.number().nonnegative(), validUntil: timestamp.nullable() }).nullable(),
      taxBasis: z.object({ taxIncluded: z.literal(true), rate: z.number().min(0).max(1), basis: shortText(64) }),
      engineVersion: shortText(64),
    })
    .superRefine((p, ctx) => {
      if (p.finalGross.amount > p.regularGross.amount) ctx.addIssue({ code: 'custom', path: ['finalGross'], message: 'final price above regular price' });
    }),
  z.object({ status: z.literal('unavailable'), reason: shortText(64) }),
]);

const itemFound = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    status: z.literal('found'),
    item: itemRef,
    product: z.object({ ref: productRef, name: shortText(200), sku: shortText(64).nullable(), lifecycle }),
    variant: z.object({ sku: shortText(64).nullable(), attributes: z.array(attribute).max(10) }).nullable(),
    pricing,
    availability: z.object({ sellability, reason, availableQuantity: z.int().nullable(), leadTime: z.null() }).superRefine(checkReason),
    provenance,
    freshness,
  })
  .superRefine((i, ctx) => {
    if (i.item.productId !== i.product.ref.productId) ctx.addIssue({ code: 'custom', path: ['item', 'productId'], message: 'item and product disagree' });
    if ((i.variant === null) !== (i.item.variantId === null)) ctx.addIssue({ code: 'custom', path: ['variant'], message: 'variant must be present exactly when the item names a variant' });
    if (i.product.lifecycle.status === 'inactive' && i.availability.sellability !== 'not_sellable') ctx.addIssue({ code: 'custom', path: ['availability'], message: 'an inactive product cannot be sellable' });
  });

export const catalogItemContextResponseSchema = z.discriminatedUnion('status', [
  z.object({ schemaVersion: z.literal(CATALOG_SCHEMA_VERSION), status: z.literal('not_found'), itemKey: catalogKeySchema }),
  z.object({ schemaVersion: z.literal(CATALOG_SCHEMA_VERSION), status: z.literal('variant_required'), itemKey: catalogKeySchema, product: productRef }),
  itemFound,
]);

/** The owner's typed failure body (non-2xx). Only a bounded code is kept; the message is never trusted as text for the model. */
export const catalogErrorBodySchema = z.object({ error: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), retryable: z.boolean().optional() }) });
