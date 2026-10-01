import { FixtureCatalog, type CallOptions, type CatalogFreshness, type CatalogItemContextRequest, type CatalogPort, type CatalogSearchRequest } from '@r4-adapters/domains';

/** catalog-service stand-in whose owner window (validUntil - asOf) the test sets; facts come from the fixture owner. */
export class OwnerWindowCatalog implements CatalogPort {
  readonly bindingKind = 'real';
  readonly calls: { readonly operation: string; readonly key: string | null; readonly at: number }[] = [];
  readonly #owner = new FixtureCatalog();
  constructor(public windowMs: number) {}

  #window(freshness: CatalogFreshness): CatalogFreshness {
    return { ...freshness, validUntil: new Date(Date.parse(freshness.asOf) + this.windowMs).toISOString() };
  }
  async search(request: CatalogSearchRequest, options?: CallOptions) {
    this.calls.push({ operation: 'search', key: null, at: Date.now() });
    const answer = await this.#owner.search(request, options);
    return { ...answer, freshness: this.#window(answer.freshness) };
  }
  async getProductContext(productKey: string, options?: CallOptions) {
    this.calls.push({ operation: 'product_context', key: productKey, at: Date.now() });
    const context = await this.#owner.getProductContext(productKey, options);
    return context.status === 'found' ? { ...context, freshness: this.#window(context.freshness) } : context;
  }
  getItemContext(request: CatalogItemContextRequest, options?: CallOptions) {
    return this.#owner.getItemContext(request, options);
  }
}
