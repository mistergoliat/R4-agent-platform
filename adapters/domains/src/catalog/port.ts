import type { CallOptions, Money } from '../shared/errors.js';

/**
 * Catalog port (R4-J1B, converged with catalog-service in R4-J1C). The
 * Catalog owner (catalog-service) is the only authority for product
 * identity, lifecycle, price, availability, freshness and relationships.
 * This port TRANSPORTS what the owner says; nothing behind it may compute
 * price or tax, interpret specific prices, derive availability from stock,
 * choose a variant, rerank or deduplicate results, infer lifecycle, turn
 * co-purchase into compatibility, or invent any timestamp. Read-only by
 * construction: it has no operation that changes the catalog.
 *
 * Shape = the owner's wire contract (catalog-service
 * `src/domain/catalog/v2/contracts.ts`, schemaVersion 1) minus
 * `schemaVersion`, restricted to the fields R4 uses. Owner field names are
 * kept verbatim so the adapter never renames or reinterprets data.
 * Contract: docs/architecture/R4-J1C_CATALOG_CONTRACT_CONVERGENCE.md §3.
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
 * Identity invariant (frozen with the owner, R4-J1C):
 *   productKey = PRODUCT identity (search results, product context, FBT items).
 *   itemKey    = SELLABLE ITEM identity, emitted ONLY by `facts.sellableItem`,
 *                `facts.variantOptions[]` and the item context.
 * R4 never derives one from the other: a productKey is never used as an
 * itemKey unless the owner named it as the product's `sellableItem`.
 */
export interface CatalogProductIds {
  readonly productId: string;
}

/** `variantId === null` ONLY when the product has no variants. */
export interface CatalogItemIds {
  readonly productId: string;
  readonly variantId: string | null;
}

/** One concrete sellable unit, as the owner names it. */
export interface CatalogSellableItem {
  readonly itemKey: string;
  readonly ref: CatalogItemIds;
}

// ---- owner-declared freshness and provenance -------------------------------

/** Freshness exactly as the owner declared it. R4 never fills these in. */
export interface CatalogFreshness {
  /** Instant the owner read its source (not when R4 received the answer). */
  readonly asOf: string;
  readonly cache: { readonly hit: boolean; readonly ageMs: number };
  /** Until when the owner vouches for the answer; null = the owner declares no window. */
  readonly validUntil: string | null;
}

export interface CatalogProvenance {
  readonly source: string;
  readonly service: string;
  readonly serviceBuildRef: string | null;
  /** Source record update instant, when the owner knows it. */
  readonly sourceUpdatedAt: string | null;
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

/**
 * Product-level price summary, as the owner computes it: `exact` for a
 * product without variants; `from` = the owner's minimum final price over
 * the product's priced variants (the owner's rule, not R4's).
 */
export interface CatalogPriceSummary {
  readonly kind: 'exact' | 'from';
  readonly finalGross: Money;
  readonly regularGross: Money;
  readonly discounted: boolean;
}

export interface CatalogAvailabilitySummary {
  readonly sellability: CatalogSellability;
  readonly reason: CatalogSellabilityReason;
  /** Sellable variants, when the product has variants (owner count); null without variants. */
  readonly sellableVariants: number | null;
}

/** Product status flags, as the owner states them. */
export interface CatalogProductStatus {
  readonly active: boolean;
  /** Shown in the storefront (PrestaShop visibility). */
  readonly listed: boolean;
  /** Orderable (PrestaShop available_for_order). */
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
    /** On the owner's final gross unit price (its product-level summary). */
    readonly maxUnitPrice?: number;
    /** Explicit filter (owner: only `sellable`); by default the owner does NOT hide unsellable products. */
    readonly sellableOnly?: boolean;
  };
  readonly limit?: number;
}

/** A search result is PRODUCT-level: it carries a productKey, never an itemKey. */
export interface CatalogSearchResult {
  readonly productKey: string;
  readonly ref: CatalogProductIds;
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
  readonly itemKey: string;
  readonly ref: CatalogItemIds;
  readonly sku: string | null;
  readonly attributes: readonly CatalogAttribute[];
}

export interface CatalogFrequentlyBoughtTogether {
  readonly productKey: string;
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
  readonly status: CatalogProductStatus;
  /** The product's own sellable unit when it has NO variants; null when a variant must be selected. */
  readonly sellableItem: CatalogSellableItem | null;
  /** One entry per variant, each with its own itemKey; empty when the product has no variants. */
  readonly variantOptions: readonly CatalogVariantOption[];
}

export type CatalogProductContext =
  | { readonly status: 'not_found'; readonly productKey: string }
  | {
      readonly status: 'found';
      readonly productKey: string;
      readonly ref: CatalogProductIds;
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
      /** The quantity tier the owner priced. */
      readonly quantity: number;
      /** UNIT amounts for this quantity tier, tax included, as the owner computed them. R4 never multiplies. */
      readonly regularGross: Money;
      readonly finalGross: Money;
      /** The owner's applied promotion, display-only (percentage value is a fraction). Never recomputed. */
      readonly promotion: { readonly discountType: 'amount' | 'percentage'; readonly discountValue: number; readonly validUntil: string | null } | null;
      readonly tax: { readonly included: true; readonly rate: number; readonly basis: string };
      readonly engineVersion: string;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

export type CatalogItemContext =
  | { readonly status: 'not_found'; readonly itemKey: string }
  /** The key names a product that has variants: there is no sellable unit until one is selected. */
  | { readonly status: 'variant_required'; readonly itemKey: string; readonly productKey: string }
  | {
      readonly status: 'found';
      readonly itemKey: string;
      readonly ref: CatalogItemIds;
      readonly parentProduct: { readonly productKey: string; readonly name: string; readonly sku: string | null };
      /** `variantId` equals `ref.variantId` (null for a product without variants). */
      readonly variant: { readonly variantId: string | null; readonly sku: string | null; readonly attributes: readonly CatalogAttribute[] };
      readonly pricing: CatalogItemPricing;
      readonly availability: {
        readonly sellability: CatalogSellability;
        readonly reason: CatalogSellabilityReason;
        /** Net of reservations, as the owner reports it; null when unknown. */
        readonly availableQuantity: number | null;
        /** The owner never promises a lead time it does not have. */
        readonly leadTime: null;
      };
      readonly provenance: CatalogProvenance;
      readonly freshness: CatalogFreshness;
    };

export interface CatalogItemContextRequest {
  readonly itemKey: string;
  /** 1–99 (owner contract). */
  readonly quantity: number;
}

export interface CatalogPort {
  search(request: CatalogSearchRequest, options?: CallOptions): Promise<CatalogSearchAnswer>;
  /** `not_found` is an answer, not an error. */
  getProductContext(productKey: string, options?: CallOptions): Promise<CatalogProductContext>;
  /** `not_found` / `variant_required` are answers, not errors. */
  getItemContext(request: CatalogItemContextRequest, options?: CallOptions): Promise<CatalogItemContext>;
}
