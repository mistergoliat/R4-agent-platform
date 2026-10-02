import { AvailabilitySwitch } from '../shared/availability.js';
import { DomainError, normalizeText, type CallOptions, type Money } from '../shared/errors.js';
import { FIXTURE_CATALOG_UPDATED_AT, FIXTURE_CATALOG_VALIDITY_MS, FIXTURE_PRODUCTS, type FixtureProductRecord, type FixtureVariantRecord } from './fixture-data.js';
import type {
  CatalogAvailabilitySummary,
  CatalogFreshness,
  CatalogItemContext,
  CatalogItemContextRequest,
  CatalogPort,
  CatalogPriceSummary,
  CatalogProductContext,
  CatalogProvenance,
  CatalogSearchAnswer,
  CatalogSearchRequest,
  CatalogSearchResult,
  CatalogSellability,
  CatalogSellabilityReason,
} from './port.js';

/** What sibling fixture owners (Quote, Shipping) read about one sellable item. Fixture-only: not the port. */
export interface FixtureOwnerItem {
  readonly itemKey: string;
  readonly name: string;
  readonly unitPrice: Money;
  readonly availableQuantity: number | null;
  readonly sellability: CatalogSellability;
  readonly weightKg: number;
}

interface Stored {
  readonly product: FixtureProductRecord;
  readonly updatedAt: string;
}

const provenanceOf = (sourceUpdatedAt: string | null): CatalogProvenance => ({ source: 'fixture', service: 'fixture-catalog', serviceBuildRef: null, sourceUpdatedAt });
const SELLABILITY_RANK: Record<CatalogSellability, number> = { sellable: 0, backorder: 1, check_with_staff: 2, not_sellable: 3 };
const clp = (amount: number): Money => ({ amount, currency: 'CLP' });

/**
 * In-memory Catalog OWNER for tests and local harness runs (R4-J1B shape).
 * It stands in for catalog-service, so it — unlike any R4 consumer — derives
 * sellability, price summaries and freshness from its own records, exactly
 * as the owner is required to: price and stock can change between two reads
 * (`setPrice`, `setStock`), `asOf` is the instant it read its records, and
 * `validUntil` is its own declared window. Search ranks by the owner's own
 * match signals and never hides unsellable products unless asked. It follows
 * the real owner's rules (catalog-service v2): search is product-level and
 * leaves out inactive and unlisted products; `from` is the minimum over all
 * priced variants.
 */
export class FixtureCatalog implements CatalogPort {
  /** What this implementation is, for a shadow composition's binding check (R4-H): an in-memory, deterministic owner. */
  readonly bindingKind = 'fixture' as const;
  readonly availability = new AvailabilitySwitch('catalog');
  readonly #records = new Map<string, Stored>();
  readonly #now: () => Date;
  #reads = 0;

  constructor(options: { products?: readonly FixtureProductRecord[]; now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
    for (const product of options.products ?? FIXTURE_PRODUCTS) this.#records.set(product.productKey, { product, updatedAt: FIXTURE_CATALOG_UPDATED_AT });
  }

  /** Number of calls answered (for "did the agent re-read?" assertions). */
  get reads(): number {
    return this.#reads;
  }

  async search(request: CatalogSearchRequest, options?: CallOptions): Promise<CatalogSearchAnswer> {
    await this.availability.enter(options);
    this.#reads += 1;
    const query = request.query.trim();
    if (query.length < 2 || query.length > 120) throw new DomainError('validation', 'invalid_request', 'query must have 2 to 120 characters');
    const limit = request.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new DomainError('validation', 'invalid_request', 'limit must be between 1 and 10');
    const freshness = this.#freshness(this.#now());
    const normalized = normalizeText(query);
    const tokens = normalized.split(/\s+/).filter((t) => t.length > 1);
    const matches: { result: CatalogSearchResult; rank: number; order: number }[] = [];
    let order = 0;
    for (const { product } of this.#records.values()) {
      order += 1;
      // Owner policy: inactive products and products hidden from the storefront are never offered by search.
      if (!product.status.active || !product.status.listed) continue;
      const exactSku = [product.sku, ...product.variants.map((v) => v.sku)].some((sku) => normalizeText(sku) === normalized);
      const exactName = normalizeText(product.name) === normalized;
      const haystack = normalizeText([product.name, product.sku, product.category.name, ...product.searchTerms].join(' '));
      const matched = tokens.filter((t) => haystack.includes(t)).length;
      if (!exactSku && !exactName && matched === 0) continue;
      const priceSummary = priceSummaryOf(product);
      const filters = request.filters ?? {};
      if (filters.categoryId !== undefined && product.category.id !== filters.categoryId) continue;
      if (filters.maxUnitPrice !== undefined && (priceSummary === null || priceSummary.finalGross.amount > filters.maxUnitPrice)) continue;
      if (filters.sellableOnly && availabilityOf(product).sellability !== 'sellable') continue;
      const match = { type: exactSku ? 'exact_reference' : exactName ? 'exact_name' : 'name', matchedTokens: exactSku || exactName ? Math.max(tokens.length, 1) : matched, totalTokens: Math.max(tokens.length, 1) };
      matches.push({ rank: exactSku ? 1_000 : exactName ? 500 : matched, order, result: resultOf(product, match) });
    }
    matches.sort((a, b) => b.rank - a.rank || a.order - b.order);
    return {
      results: matches.slice(0, limit).map((m) => m.result),
      completeness: { totalMatches: matches.length, truncated: matches.length > limit },
      searchMode: 'lexical',
      freshness,
    };
  }

  async getProductContext(productKey: string, options?: CallOptions): Promise<CatalogProductContext> {
    await this.availability.enter(options);
    this.#reads += 1;
    return this.productContextAt(productKey, this.#now());
  }

  /** Owner-side, synchronous: the product context this owner answers when read at `asOf` (evaluation fixtures). */
  productContextAt(productKey: string, asOf: Date): CatalogProductContext {
    const stored = this.#records.get(productKey);
    if (!stored) return { status: 'not_found', productKey };
    const { product } = stored;
    const fbt = product.frequentlyBoughtTogether.flatMap((f) => {
      const other = this.#records.get(f.productKey)?.product;
      return other ? [{ productKey: other.productKey, name: other.name, confidence: f.confidence, jointCount: f.jointCount }] : [];
    });
    return {
      status: 'found',
      productKey: product.productKey,
      ref: { productId: product.productId },
      facts: {
        name: product.name,
        sku: product.sku,
        category: { ...product.category },
        brand: product.brand,
        shortDescription: product.shortDescription,
        specifications: product.specifications.map((s) => ({ ...s })),
        status: { ...product.status },
        weightKg: product.weightKg,
        sellableItem: product.variants.length === 0 ? { itemKey: product.productKey, ref: { productId: product.productId, variantId: null } } : null,
        variantOptions: product.variants.map((v) => ({ itemKey: v.itemKey, ref: { productId: product.productId, variantId: v.variantId }, sku: v.sku, attributes: v.attributes.map((a) => ({ ...a })) })),
      },
      derived: { priceSummary: priceSummaryOf(product), availability: availabilityOf(product), publicUrl: `https://fixture.invalid/p/${product.productId}` },
      inferred: {
        frequentlyBoughtTogether: fbt.length > 0 ? { status: 'available', snapshotId: 'fixture-same-order-1', builtAt: FIXTURE_CATALOG_UPDATED_AT, items: fbt } : { status: 'unavailable', reason: 'no_relationships' },
      },
      provenance: provenanceOf(stored.updatedAt),
      freshness: this.#freshness(asOf),
    };
  }

  /**
   * Owner-side, synchronous: a complete, untruncated search answer listing
   * exactly `productKeys` in that order, read at `asOf`. Evaluation fixtures
   * use it to reproduce a recorded result set without re-running a query.
   */
  searchAnswerOf(productKeys: readonly string[], asOf: Date): CatalogSearchAnswer {
    const results = productKeys.map((key) => {
      const product = this.#records.get(key)?.product;
      if (!product) throw new Error(`fixture catalog has no product ${key}`);
      return resultOf(product, { type: 'name', matchedTokens: 1, totalTokens: 1 });
    });
    return { results, completeness: { totalMatches: results.length, truncated: false }, searchMode: 'lexical', freshness: this.#freshness(asOf) };
  }

  async getItemContext(request: CatalogItemContextRequest, options?: CallOptions): Promise<CatalogItemContext> {
    await this.availability.enter(options);
    this.#reads += 1;
    if (!Number.isInteger(request.quantity) || request.quantity < 1 || request.quantity > 99) throw new DomainError('validation', 'invalid_request', 'quantity must be between 1 and 99');
    const found = this.#item(request.itemKey);
    if (found === null) return { status: 'not_found', itemKey: request.itemKey };
    const { stored, variant } = found;
    const { product } = stored;
    if (variant === undefined) return { status: 'variant_required', itemKey: request.itemKey, productKey: product.productKey };
    const unit = unitOf(product, variant);
    const availability = sellabilityOf(product, unit.availableQuantity);
    return {
      status: 'found',
      itemKey: request.itemKey,
      ref: { productId: product.productId, variantId: variant?.variantId ?? null },
      parentProduct: { productKey: product.productKey, name: product.name, sku: product.sku },
      variant: { variantId: variant?.variantId ?? null, sku: variant ? variant.sku : product.sku, attributes: variant ? variant.attributes.map((a) => ({ ...a })) : [] },
      pricing: {
        status: 'available',
        quantity: request.quantity,
        regularGross: clp(unit.regularGross),
        finalGross: clp(unit.finalGross),
        promotion: variant ? null : product.promotion,
        tax: { included: true, rate: 0.19, basis: 'fixture_gross_prices' },
        engineVersion: 'fixture-1',
      },
      availability: { ...availability, availableQuantity: unit.availableQuantity, leadTime: null },
      provenance: provenanceOf(stored.updatedAt),
      freshness: this.#freshness(this.#now()),
    };
  }

  // --- owner-side changes (scenario control; not reachable from any capability) ---

  /** Sets the gross price of a sellable item (a product without variants, or one variant). */
  setPrice(itemKey: string, amount: number): void {
    this.#updateItem(itemKey, (unit) => ({ ...unit, regularGross: amount, finalGross: amount }));
  }

  setStock(itemKey: string, units: number | null): void {
    this.#updateItem(itemKey, (unit) => ({ ...unit, availableQuantity: units }));
  }

  /** Synchronous owner-side lookup of a sellable item, used by the other fixture owners (shipping weights, quote pricing). */
  current(itemKey: string): FixtureOwnerItem | null {
    const found = this.#item(itemKey);
    if (found === null || found.variant === undefined) return null;
    const { product } = found.stored;
    const unit = unitOf(product, found.variant);
    const label = found.variant ? `${product.name} (${found.variant.attributes.map((a) => a.value).join(', ')})` : product.name;
    return { itemKey, name: label, unitPrice: clp(unit.finalGross), availableQuantity: unit.availableQuantity, sellability: sellabilityOf(product, unit.availableQuantity).sellability, weightKg: unit.weightKg };
  }

  /** `variant`: null = product without variants; undefined = the key names a product that has variants. */
  #item(itemKey: string): { stored: Stored; variant: FixtureVariantRecord | null | undefined } | null {
    const direct = this.#records.get(itemKey);
    if (direct) return { stored: direct, variant: direct.product.variants.length === 0 ? null : undefined };
    for (const stored of this.#records.values()) {
      const variant = stored.product.variants.find((v) => v.itemKey === itemKey);
      if (variant) return { stored, variant };
    }
    return null;
  }

  #updateItem(itemKey: string, change: (unit: Unit) => Unit): void {
    const found = this.#item(itemKey);
    if (found === null || found.variant === undefined) throw new Error(`fixture catalog has no sellable item ${itemKey}`);
    const { product } = found.stored;
    const variant = found.variant;
    const next = change(unitOf(product, variant));
    const updated: FixtureProductRecord = variant
      ? { ...product, variants: product.variants.map((v) => (v.variantId === variant.variantId ? { ...v, ...next } : v)) }
      : { ...product, regularGross: next.regularGross, finalGross: next.finalGross, availableQuantity: next.availableQuantity };
    this.#records.set(product.productKey, { product: updated, updatedAt: this.#now().toISOString() });
  }

  #freshness(asOf: Date): CatalogFreshness {
    return { asOf: asOf.toISOString(), cache: { hit: false, ageMs: 0 }, validUntil: new Date(asOf.getTime() + FIXTURE_CATALOG_VALIDITY_MS).toISOString() };
  }
}

function resultOf(product: FixtureProductRecord, match: CatalogSearchResult['match']): CatalogSearchResult {
  return {
    productKey: product.productKey,
    ref: { productId: product.productId },
    name: product.name,
    sku: product.sku,
    category: { ...product.category },
    variants: { count: product.variants.length, requiresSelection: product.variants.length > 0 },
    priceSummary: priceSummaryOf(product),
    availabilitySummary: availabilityOf(product),
    match,
  };
}

interface Unit {
  readonly regularGross: number;
  readonly finalGross: number;
  readonly availableQuantity: number | null;
  readonly weightKg: number;
}

function unitOf(product: FixtureProductRecord, variant: FixtureVariantRecord | null): Unit {
  if (variant) return { regularGross: variant.regularGross, finalGross: variant.finalGross, availableQuantity: variant.availableQuantity, weightKg: variant.weightKg };
  return { regularGross: product.regularGross ?? 0, finalGross: product.finalGross ?? product.regularGross ?? 0, availableQuantity: product.availableQuantity, weightKg: product.weightKg ?? 0 };
}

/** The owner's sellability rule (the fixture stands in for catalog-service; R4 never evaluates this). */
function sellabilityOf(product: FixtureProductRecord, availableQuantity: number | null): { sellability: CatalogSellability; reason: CatalogSellabilityReason } {
  if (!product.status.active) return { sellability: 'not_sellable', reason: 'inactive' };
  if (!product.status.listed) return { sellability: 'not_sellable', reason: 'not_listed' };
  if (!product.status.orderable) return { sellability: 'not_sellable', reason: 'not_orderable' };
  if (availableQuantity === null) return { sellability: 'check_with_staff', reason: 'stock_unknown' };
  if (availableQuantity > 0) return { sellability: 'sellable', reason: 'in_stock' };
  if (product.backorderAllowed === null) return { sellability: 'check_with_staff', reason: 'backorder_policy_unknown' };
  return product.backorderAllowed ? { sellability: 'backorder', reason: 'backorder_allowed' } : { sellability: 'not_sellable', reason: 'out_of_stock' };
}

function availabilityOf(product: FixtureProductRecord): CatalogAvailabilitySummary {
  if (product.variants.length === 0) return { ...sellabilityOf(product, product.availableQuantity), sellableVariants: null };
  const each = product.variants.map((v) => sellabilityOf(product, v.availableQuantity));
  const best = [...each].sort((a, b) => SELLABILITY_RANK[a.sellability] - SELLABILITY_RANK[b.sellability])[0]!;
  return { ...best, sellableVariants: each.filter((s) => s.sellability === 'sellable').length };
}

const OFFERABLE: ReadonlySet<CatalogSellability> = new Set(['sellable', 'backorder']);

function priceSummaryOf(product: FixtureProductRecord): CatalogPriceSummary | null {
  if (product.variants.length === 0) {
    if (product.regularGross === null) return null;
    const final = product.finalGross ?? product.regularGross;
    const basis = OFFERABLE.has(sellabilityOf(product, product.availableQuantity).sellability) ? 'offerable' : 'not_offerable';
    return { kind: 'exact', basis, finalGross: clp(final), regularGross: clp(product.regularGross), discounted: final < product.regularGross };
  }
  // The real owner's rule (OD-1): the minimum over OFFERABLE variants (sellable or
  // backorder); only when none is offerable, the minimum over all, marked not_offerable.
  const offerable = product.variants.filter((v) => OFFERABLE.has(sellabilityOf(product, v.availableQuantity).sellability));
  const basis = offerable.length > 0 ? 'offerable' : 'not_offerable';
  const cheapest = [...(offerable.length > 0 ? offerable : product.variants)].sort((a, b) => a.finalGross - b.finalGross || a.regularGross - b.regularGross)[0];
  return cheapest ? { kind: 'from', basis, finalGross: clp(cheapest.finalGross), regularGross: clp(cheapest.regularGross), discounted: cheapest.finalGross < cheapest.regularGross } : null;
}
