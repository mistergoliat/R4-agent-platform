import { AvailabilitySwitch } from '../shared/availability.js';
import { DomainError, normalizeText, type CallOptions } from '../shared/errors.js';
import { FIXTURE_CATALOG_UPDATED_AT, FIXTURE_PRODUCTS, type FixtureProduct } from './fixture-data.js';
import type { CatalogSearchQuery, CatalogSearchResult, CatalogService, ProductDetail, ProductSummary, StockStatus } from './port.js';

interface Record_ {
  readonly product: FixtureProduct;
  readonly recordVersion: number;
  readonly updatedAt: string;
}

/**
 * In-memory Catalog owner for tests and local harness runs. It is the
 * authority for its data exactly like a real service would be: price and
 * stock can change between two reads (`setPrice`, `setStock`), every change
 * bumps the record version, and search applies no commercial rule — it only
 * filters by text, category, price and availability.
 */
export class FixtureCatalog implements CatalogService {
  readonly availability = new AvailabilitySwitch('catalog');
  readonly #records = new Map<string, Record_>();
  readonly #now: () => Date;
  #reads = 0;

  constructor(options: { products?: readonly FixtureProduct[]; now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
    for (const product of options.products ?? FIXTURE_PRODUCTS) {
      this.#records.set(product.productId, { product, recordVersion: 1, updatedAt: FIXTURE_CATALOG_UPDATED_AT });
    }
  }

  /** Number of calls answered (for "did the agent re-read?" assertions). */
  get reads(): number {
    return this.#reads;
  }

  async search(query: CatalogSearchQuery, options?: CallOptions): Promise<CatalogSearchResult> {
    await this.availability.enter(options);
    this.#reads += 1;
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) throw new DomainError('validation', 'invalid_limit', 'limit must be between 1 and 50');
    const terms = query.text ? normalizeText(query.text).split(/\s+/).filter((t) => t.length > 1) : [];
    const category = query.category ? normalizeText(query.category) : null;
    const matches = [...this.#records.values()].filter(({ product }) => {
      if (category !== null && normalizeText(product.category) !== category) return false;
      if (query.maxUnitPrice !== undefined && product.unitPrice.amount > query.maxUnitPrice) return false;
      if (query.inStockOnly && !isAvailable(product.stock.status)) return false;
      if (terms.length === 0) return true;
      const haystack = normalizeText([product.name, product.category, product.brand, product.description, ...product.tags].join(' '));
      return terms.some((term) => haystack.includes(term));
    });
    return {
      results: matches.slice(0, query.limit).map((record) => summaryOf(record)),
      totalMatches: matches.length,
      categories: [...new Set([...this.#records.values()].map((r) => r.product.category))].sort(),
    };
  }

  async getProduct(productId: string, options?: CallOptions): Promise<ProductDetail | null> {
    await this.availability.enter(options);
    this.#reads += 1;
    const record = this.#records.get(productId);
    return record ? detailOf(record) : null;
  }

  // --- owner-side changes (scenario control; not reachable from any capability) ---

  setPrice(productId: string, amount: number): void {
    this.#update(productId, (p) => ({ ...p, unitPrice: { amount, currency: 'CLP' } }));
  }

  setStock(productId: string, units: number, status?: StockStatus): void {
    this.#update(productId, (p) => ({ ...p, stock: { units, status: status ?? (units === 0 ? 'out_of_stock' : units <= 3 ? 'low_stock' : 'in_stock') } }));
  }

  /** Synchronous owner-side lookup used by other fixture owners (shipping weights, quote pricing). */
  current(productId: string): ProductDetail | null {
    const record = this.#records.get(productId);
    return record ? detailOf(record) : null;
  }

  #update(productId: string, change: (product: FixtureProduct) => FixtureProduct): void {
    const record = this.#records.get(productId);
    if (!record) throw new Error(`fixture catalog has no product ${productId}`);
    this.#records.set(productId, { product: change(record.product), recordVersion: record.recordVersion + 1, updatedAt: this.#now().toISOString() });
  }
}

export function isAvailable(status: StockStatus): boolean {
  return status === 'in_stock' || status === 'low_stock';
}

function summaryOf({ product, recordVersion, updatedAt }: Record_): ProductSummary {
  return { productId: product.productId, name: product.name, category: product.category, brand: product.brand, unitPrice: product.unitPrice, stock: product.stock, recordVersion, updatedAt };
}

function detailOf(record: Record_): ProductDetail {
  const { product } = record;
  return {
    ...summaryOf(record),
    description: product.description,
    weightKg: product.weightKg,
    footprintCm: product.footprintCm,
    specs: product.specs,
    compatibleWith: product.compatibleWith,
    alternatives: product.alternatives,
  };
}
