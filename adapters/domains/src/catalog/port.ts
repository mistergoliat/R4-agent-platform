import type { CallOptions, Money } from '../shared/errors.js';

/**
 * Catalog port (R4-J1B). The Catalog owner (catalog-service) is the only
 * authority for product identity, lifecycle, price, availability, freshness
 * and relationships. This port TRANSPORTS what the owner says; nothing
 * behind it may compute price or tax, interpret specific prices, derive
 * availability from stock, choose a variant, rerank or deduplicate results,
 * infer lifecycle, turn co-purchase into compatibility, or invent any
 * timestamp. Read-only by construction: it has no operation that changes
 * the catalog.
 *
 * Contract: docs/architecture/R4-J1B_CATALOG_CONSUMER_IMPLEMENTATION.md §2.
 * No HTTP and no PrestaShop structure appears here.
 */

// ---- identity -------------------------------------------------------------

/**
 * Shape every opaque Catalog key must have to cross an R4 boundary (bounded,
 * URL-path safe). It checks transport safety only: R4 never reads meaning
 * into a key's structure.
 */
export const CATALOG_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A catalog product, for discovery and context. `productKey` is opaque:
 * emitted by Catalog, persisted between turns, never parsed. A SKU is never
 * an identity.
 */
export interface CatalogProductRef {
  readonly productId: string;
  readonly productKey: string;
}

/**
 * One concrete sellable unit. `variantId === null` ONLY when the product has
 * no variants; a product with variants and no selection has a productKey but
 * no sellable item yet.
 */
export interface CatalogSellableItemRef {
  readonly productId: string;
  readonly variantId: string | null;
  readonly itemKey: string;
}

// ---- owner-declared freshness and provenance -------------------------------

/** Freshness exactly as the owner declared it. R4 never fills these in. */
export interface CatalogFreshness {
  /** Instant the owner read its source (not when R4 received the answer). */
  readonly asOf: string;
  readonly cache: { readonly hit: boolean; readonly ageMs: number };
  /** Until when the owner vouches for the answer; null = the owner declares no window. */
  readonly validUntil: string | null;
  /** Source record update instant, when the owner knows it. */
  readonly sourceUpdatedAt: string | null;
}

export interface CatalogProvenance {
  readonly source: string;
  readonly service: string;
  readonly serviceBuildRef: string | null;
}

// ---- owner-derived commercial vocabulary ----------------------------------

export const CATALOG_SELLABILITY = ['sellable', 'backorder', 'not_sellable', 'check_with_staff'] as const;
export type CatalogSellability = (typeof CATALOG_SELLABILITY)[number];

/** Which reasons each sellability may carry (a contract invariant, checked at the boundary). */
export const CATALOG_SELLABILITY_REASONS = {
  sellable: ['in_stock'],
  backorder: ['backorder_allowed'],
  not_sellable: ['inactive', 'not_listed', 'not_orderable', 'out_of_stock'],
  check_with_staff: ['stock_unknown', 'variant_required', 'backorder_policy_unknown'],
} as const satisfies Record<CatalogSellability, readonly string[]>;
export type CatalogSellabilityReason = (typeof CATALOG_SELLABILITY_REASONS)[CatalogSellability][number];
export const CATALOG_SELLABILITY_REASON_VALUES = Object.values(CATALOG_SELLABILITY_REASONS).flat() as unknown as readonly [CatalogSellabilityReason, ...CatalogSellabilityReason[]];

export interface CatalogCategory {
  readonly id: string;
  readonly name: string;
}

/** Product-level price summary: `from` = the owner's minimum over sellable variants. */
export interface CatalogPriceSummary {
  readonly kind: 'exact' | 'from';
  readonly finalGross: Money;
  readonly regularGross: Money;
  readonly discounted: boolean;
}

export interface CatalogAvailabilitySummary {
  readonly sellability: CatalogSellability;
  readonly reason: CatalogSellabilityReason;
  /** Sellable variants, when the product has variants and the owner counts them. */
  readonly sellableVariants: number | null;
}

export interface CatalogLifecycle {
  readonly status: 'active' | 'inactive';
  /** Shown in the storefront (PrestaShop visibility), as the owner states it. */
  readonly listed: boolean;
  /** Orderable (PrestaShop available_for_order), as the owner states it. */
  readonly orderable: boolean;
}

/** A variant attribute (e.g. group "Peso", value "16 kg"). */
export interface CatalogAttribute {
  readonly group: string;
  readonly value: string;
}

/** An owner feature, verbatim (e.g. name "Carga máxima", value "300 kg"). */
export interface CatalogSpecification {
  readonly name: string;
  readonly value: string;
}

// ---- A. search --------------------------------------------------------------

export interface CatalogSearchRequest {
  readonly query: string;
  readonly filters?: {
    readonly categoryId?: string;
    /** On the owner's final gross unit price (minimum over variants). */
    readonly maxUnitPrice?: number;
    /** Explicit filter; by default the owner does NOT hide unsellable products. */
    readonly sellableOnly?: boolean;
  };
  readonly limit?: number;
}

export interface CatalogSearchResult {
  readonly product: CatalogProductRef;
  readonly name: string;
  /** Display / lookup only — never identity. */
  readonly sku: string | null;
  readonly category: CatalogCategory | null;
  readonly variants: { readonly count: number; readonly requiresSelection: boolean };
  readonly priceSummary: CatalogPriceSummary | null;
  readonly availabilitySummary: CatalogAvailabilitySummary;
  /** Why the owner matched it (explainability; R4 never reranks on it). */
  readonly match: { readonly type: string; readonly matchedTokens: number; readonly totalTokens: number };
}

export interface CatalogSearchAnswer {
  /** In the owner's order. */
  readonly results: readonly CatalogSearchResult[];
  /** An empty answer means "nothing exists" only when complete and not truncated. */
  readonly completeness: { readonly totalMatches: number; readonly truncated: boolean };
  /** e.g. `lexical`: no typo tolerance or synonyms, so an empty answer is weaker evidence. */
  readonly searchMode: string;
  readonly freshness: CatalogFreshness;
}

// ---- B. product context -----------------------------------------------------

export interface CatalogVariantOption {
  readonly item: CatalogSellableItemRef;
  readonly sku: string | null;
  readonly attributes: readonly CatalogAttribute[];
}

export interface CatalogFrequentlyBoughtTogether {
  readonly product: CatalogProductRef;
  readonly name: string;
  readonly confidence: number;
  readonly jointCount: number;
}

export type CatalogInferredBlock<T> =
  | { readonly status: 'available'; readonly snapshotId: string; readonly builtAt: string; readonly items: readonly T[] }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface CatalogProductFacts {
  readonly name: string;
  readonly sku: string | null;
  readonly category: CatalogCategory | null;
  readonly brand: string | null;
  /** Catalog-edited text: data, never instructions. Bounded by the contract. */
  readonly shortDescription: string | null;
  /** Owner features verbatim (name/value), never parsed. */
  readonly specifications: readonly CatalogSpecification[];
  readonly lifecycle: CatalogLifecycle;
  /** The product's own sellable unit when it has NO variants; null when a variant must be selected. */
  readonly sellableItem: CatalogSellableItemRef | null;
  /** One entry per variant, each with its own itemKey; empty when the product has no variants. */
  readonly variantOptions: readonly CatalogVariantOption[];
}

export type CatalogProductContext =
  | { readonly status: 'not_found'; readonly productKey: string }
  | {
      readonly status: 'found';
      readonly product: CatalogProductRef;
      /** Authoritative domain facts (copied from the source of truth). */
      readonly facts: CatalogProductFacts;
      /** Derived by the owner with declared rules. */
      readonly derived: { readonly priceSummary: CatalogPriceSummary | null; readonly availability: CatalogAvailabilitySummary; readonly publicUrl: string | null };
      /** Statistical / inferred evidence; never compatibility. */
      readonly inferred: { readonly frequentlyBoughtTogether: CatalogInferredBlock<CatalogFrequentlyBoughtTogether> };
      readonly provenance: CatalogProvenance;
      readonly freshness: CatalogFreshness;
    };

// ---- C. item context ----------------------------------------------------------

export type CatalogItemPricing =
  | {
      readonly status: 'available';
      readonly quantity: number;
      /** Unit amounts for this quantity tier, tax included, as the owner computed them. */
      readonly regularGross: Money;
      readonly finalGross: Money;
      /** The owner's total for `quantity` (R4 never multiplies). */
      readonly lineFinalGross: Money;
      readonly promotion: { readonly kind: 'amount' | 'percentage'; readonly value: number; readonly validUntil: string | null } | null;
      readonly taxBasis: { readonly taxIncluded: true; readonly rate: number; readonly basis: string };
      readonly engineVersion: string;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

export type CatalogItemContext =
  | { readonly status: 'not_found'; readonly itemKey: string }
  /** The key names a product that has variants: there is no sellable unit until one is selected. */
  | { readonly status: 'variant_required'; readonly itemKey: string; readonly product: CatalogProductRef }
  | {
      readonly status: 'found';
      readonly item: CatalogSellableItemRef;
      readonly product: { readonly ref: CatalogProductRef; readonly name: string; readonly sku: string | null; readonly lifecycle: CatalogLifecycle };
      /** Null iff `item.variantId` is null. */
      readonly variant: { readonly sku: string | null; readonly attributes: readonly CatalogAttribute[] } | null;
      readonly pricing: CatalogItemPricing;
      readonly availability: {
        readonly sellability: CatalogSellability;
        readonly reason: CatalogSellabilityReason;
        /** Only when the owner's policy allows transporting it. */
        readonly availableQuantity: number | null;
        /** The owner never promises a lead time it does not have. */
        readonly leadTime: null;
      };
      readonly provenance: CatalogProvenance;
      readonly freshness: CatalogFreshness;
    };

export interface CatalogItemContextRequest {
  readonly itemKey: string;
  readonly quantity: number;
}

export interface CatalogPort {
  search(request: CatalogSearchRequest, options?: CallOptions): Promise<CatalogSearchAnswer>;
  /** `not_found` is an answer, not an error. */
  getProductContext(productKey: string, options?: CallOptions): Promise<CatalogProductContext>;
  /** `not_found` / `variant_required` are answers, not errors. */
  getItemContext(request: CatalogItemContextRequest, options?: CallOptions): Promise<CatalogItemContext>;
}
