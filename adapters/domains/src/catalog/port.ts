import type { CallOptions, Money } from '../shared/errors.js';

/**
 * Catalog port. The Catalog owner is the authority for product identity,
 * specifications, current price and current stock. This port is read-only
 * by construction: it has no operation that changes the catalog.
 *
 * The live adapter (Catalog Service public API) is pending: no contract for
 * it is documented in this repository, so none is invented here.
 */
export const STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock', 'discontinued'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export interface ProductSummary {
  readonly productId: string;
  readonly name: string;
  readonly category: string;
  readonly brand: string;
  readonly unitPrice: Money;
  readonly stock: { readonly status: StockStatus; readonly units: number };
  /** The owner's record version: changes whenever price, stock or specs change. */
  readonly recordVersion: number;
  readonly updatedAt: string;
}

export interface ProductDetail extends ProductSummary {
  readonly description: string;
  readonly weightKg: number;
  /** Floor footprint when assembled (cm), when it matters for the product. */
  readonly footprintCm: { readonly width: number; readonly depth: number; readonly height: number } | null;
  readonly specs: Readonly<Record<string, string | number | boolean>>;
  /** Products the owner declares as compatible accessories (e.g. plates for a bar). */
  readonly compatibleWith: readonly string[];
  /** Products the owner declares as substitutes. */
  readonly alternatives: readonly string[];
}

export interface CatalogSearchQuery {
  readonly text?: string;
  readonly category?: string;
  readonly maxUnitPrice?: number;
  readonly inStockOnly?: boolean;
  readonly limit: number;
}

export interface CatalogSearchResult {
  readonly results: readonly ProductSummary[];
  readonly totalMatches: number;
  readonly categories: readonly string[];
}

export interface CatalogService {
  search(query: CatalogSearchQuery, options?: CallOptions): Promise<CatalogSearchResult>;
  /** Null when the owner has no such product. */
  getProduct(productId: string, options?: CallOptions): Promise<ProductDetail | null>;
}
