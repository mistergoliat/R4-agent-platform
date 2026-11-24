import type { CatalogPort, CatalogProductContext } from '@r4-adapters/domains';
import type { StructuredLogger } from '@r4/observability';

/**
 * ADR-058 Decision 10 / G5b: what a person answered once in R4 for a product (a sheet field the store does not declare
 * yet) reaches Pesín as part of the product sheet. The store sheet wins when it already declares the field.
 */
export interface ProductFact {
  readonly subject: string;
  readonly field: string;
  readonly value: string;
}
/** Reads the current facts (the deployment binds it to Core's artifact facts; see cli/production.ts). */
export type ProductFactsRead = () => Promise<readonly ProductFact[]>;
/** How often the worker re-reads the facts (a person answers in the console at any time). */
export const PRODUCT_FACTS_REFRESH_MS = 10 * 60_000;

/** The facts in memory, by product; refreshed in the background. A failed refresh keeps the facts in use. */
export class ProductFactsSource {
  #byProduct = new Map<string, ProductFact[]>();
  readonly #read: ProductFactsRead;
  readonly #logger: StructuredLogger;
  #timer: ReturnType<typeof setInterval> | null = null;

  private constructor(read: ProductFactsRead, logger: StructuredLogger) {
    this.#read = read;
    this.#logger = logger;
  }

  /** Loads the facts once; a failed first read starts empty (the sheets alone, as before) and logs it. */
  static async load(read: ProductFactsRead, logger: StructuredLogger): Promise<ProductFactsSource> {
    const source = new ProductFactsSource(read, logger);
    await source.refresh();
    return source;
  }

  of(productKey: string): readonly ProductFact[] {
    return this.#byProduct.get(productKey) ?? [];
  }

  get size(): number {
    let n = 0;
    for (const list of this.#byProduct.values()) n += list.length;
    return n;
  }

  async refresh(): Promise<boolean> {
    try {
      const byProduct = new Map<string, ProductFact[]>();
      for (const f of await this.#read()) (byProduct.get(f.subject) ?? byProduct.set(f.subject, []).get(f.subject)!).push(f);
      this.#byProduct = byProduct;
      this.#logger.info({ event: 'product_facts.loaded', facts: this.size }, 'product facts loaded');
      return true;
    } catch (error) {
      this.#logger.warn({ event: 'product_facts.refresh_failed', err: error instanceof Error ? error.message.slice(0, 200) : 'unexpected' }, 'product facts refresh failed; keeping the facts in use');
      return false;
    }
  }

  start(intervalMs: number = PRODUCT_FACTS_REFRESH_MS): this {
    this.#timer ??= setInterval(() => void this.refresh(), intervalMs);
    this.#timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A product sheet plus the facts the store does not declare yet (the store wins on a field it declares). */
export function withFacts(context: CatalogProductContext, facts: readonly ProductFact[]): CatalogProductContext {
  if (context.status !== 'found' || !facts.length) return context;
  const missing = facts.filter((f) => !context.facts.specifications.some((s) => same(s.name, f.field) && s.value.trim() !== ''));
  if (!missing.length) return context;
  return { ...context, facts: { ...context.facts, specifications: [...context.facts.specifications, ...missing.map((f) => ({ name: f.field, value: f.value }))] } };
}

/** The Catalog port Pesín reads, with the facts answered in R4 added to each product sheet. */
export function catalogWithFacts(catalog: CatalogPort, facts: Pick<ProductFactsSource, 'of'>): CatalogPort {
  return {
    ...('bindingKind' in catalog ? { bindingKind: (catalog as { bindingKind: unknown }).bindingKind } : {}),
    search: (request, options) => catalog.search(request, options),
    getItemContext: (request, options) => catalog.getItemContext(request, options),
    getProductContext: async (productKey, options) => withFacts(await catalog.getProductContext(productKey, options), facts.of(productKey)),
  };
}
