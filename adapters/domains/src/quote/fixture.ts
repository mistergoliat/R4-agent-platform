import { createHash } from 'node:crypto';
import { AvailabilitySwitch } from '../shared/availability.js';
import { DomainError, type CallOptions } from '../shared/errors.js';
import { isAvailable, type FixtureCatalog } from '../catalog/fixture.js';
import type { FixtureShipping } from '../shipping/fixture.js';
import type { Quote, QuoteCreateOutcome, QuoteCreateRequest, QuoteService } from './port.js';

/** What the fixture does after it has issued a quote (crash windows for recovery tests). */
export type AfterIssue = 'answer' | 'timeout' | 'hang' | 'connection_lost';

export interface FixtureQuoteFaults {
  /** Consulted once per create call, after the quote was issued (default `answer`). */
  afterIssue?: () => AfterIssue;
  /** Consulted once per lookup (default: answers). */
  lookup?: () => 'answer' | 'timeout';
}

const VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * In-memory Quote owner. It survives the "death" of any caller (it is a
 * separate system), issues at most one quote per idempotency key, prices
 * lines from the fixture catalog's current data and shipping from the
 * fixture shipping owner. Fault hooks put the caller into every window:
 * issued-then-timeout, issued-then-hang, connection lost after send.
 */
export class FixtureQuoteService implements QuoteService {
  readonly availability = new AvailabilitySwitch('quote');
  readonly faults: FixtureQuoteFaults = {};
  readonly #catalog: FixtureCatalog;
  readonly #shipping: FixtureShipping;
  readonly #now: () => Date;
  readonly #byKey = new Map<string, { requestHash: string; quote: Quote }>();
  #sequence = 0;
  #createCalls = 0;

  constructor(options: { catalog: FixtureCatalog; shipping: FixtureShipping; now?: () => Date }) {
    this.#catalog = options.catalog;
    this.#shipping = options.shipping;
    this.#now = options.now ?? (() => new Date());
  }

  /** Quotes actually issued (the duplicate detector). */
  get issued(): readonly Quote[] {
    return [...this.#byKey.values()].map((entry) => entry.quote);
  }

  get createCalls(): number {
    return this.#createCalls;
  }

  async create(request: QuoteCreateRequest, idempotencyKey: string, options?: CallOptions): Promise<QuoteCreateOutcome> {
    await this.availability.enter(options);
    this.#createCalls += 1;
    const requestHash = hashOf(request);
    const existing = this.#byKey.get(idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return { status: 'rejected', code: 'idempotency_key_reused', message: 'this idempotency key already issued a quote for a different request', details: { quoteNumber: existing.quote.quoteNumber } };
      }
      return this.#after({ status: 'created', quote: existing.quote, replayed: true });
    }
    const priced = this.#price(request);
    if (priced.status === 'rejected') return priced;
    this.#byKey.set(idempotencyKey, { requestHash, quote: priced.quote });
    return this.#after({ status: 'created', quote: priced.quote, replayed: false });
  }

  async findByIdempotencyKey(idempotencyKey: string, options?: CallOptions): Promise<Quote | null> {
    await this.availability.enter(options);
    if (this.faults.lookup?.() === 'timeout') throw new DomainError('timeout', 'lookup_timeout', 'the quote owner did not answer the lookup in time');
    return this.#byKey.get(idempotencyKey)?.quote ?? null;
  }

  #after(outcome: QuoteCreateOutcome): Promise<QuoteCreateOutcome> {
    const mode = this.faults.afterIssue?.() ?? 'answer';
    if (mode === 'timeout') return Promise.reject(new DomainError('timeout', 'response_timeout', 'the quote owner did not answer in time; the quote may exist'));
    if (mode === 'connection_lost') return Promise.reject(new DomainError('unknown_outcome', 'connection_lost', 'connection lost after the request was sent'));
    if (mode === 'hang') return new Promise<never>(() => undefined);
    return Promise.resolve(outcome);
  }

  #price(request: QuoteCreateRequest): { status: 'priced'; quote: Quote } | Extract<QuoteCreateOutcome, { status: 'rejected' }> {
    const reject = (code: string, message: string, details: Record<string, string | number | boolean | null> = {}) => ({ status: 'rejected' as const, code, message, details });
    if (request.customer.name.trim().length < 2) return reject('missing_customer_name', 'the customer name is required');
    if (!request.customer.email && !request.customer.phone) return reject('missing_contact', 'an email or a phone is required to issue a quote');
    if (request.lines.length === 0) return reject('no_lines', 'a quote needs at least one line');
    let weight = 0;
    const lines = [];
    for (const line of request.lines) {
      const product = this.#catalog.current(line.productId);
      if (!product) return reject('unknown_product', `the catalog has no product ${line.productId}`, { productId: line.productId });
      if (!isAvailable(product.stock.status)) return reject('product_unavailable', `${product.name} is ${product.stock.status}`, { productId: line.productId, stockStatus: product.stock.status });
      if (product.stock.units < line.quantity) return reject('insufficient_stock', `only ${product.stock.units} units of ${product.name} are available`, { productId: line.productId, available: product.stock.units });
      weight += product.weightKg * line.quantity;
      lines.push({ productId: product.productId, name: product.name, quantity: line.quantity, unitPrice: product.unitPrice, lineTotal: { amount: product.unitPrice.amount * line.quantity, currency: 'CLP' as const } });
    }
    const shippingAmount = this.#shipping.standardCost(request.delivery.commune, Math.round(weight * 10) / 10);
    if (shippingAmount === null) return reject('destination_not_serviceable', `no delivery to ${request.delivery.commune}`, { commune: request.delivery.commune });
    this.#sequence += 1;
    const issuedAt = this.#now();
    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal.amount, 0);
    const quoteNumber = `COT-${String(100_000 + this.#sequence)}`;
    return {
      status: 'priced',
      quote: {
        quoteId: `qt-${String(this.#sequence).padStart(6, '0')}`,
        quoteNumber,
        status: 'issued',
        customer: request.customer,
        lines,
        shipping: { serviceLevel: 'standard', commune: request.delivery.commune, amount: { amount: shippingAmount, currency: 'CLP' } },
        subtotal: { amount: subtotal, currency: 'CLP' },
        total: { amount: subtotal + shippingAmount, currency: 'CLP' },
        issuedAt: issuedAt.toISOString(),
        validUntil: new Date(issuedAt.getTime() + VALIDITY_MS).toISOString(),
        documentRef: `fixture-quote-document:${quoteNumber}`,
      },
    };
  }
}

function hashOf(request: QuoteCreateRequest): string {
  const canonical = { customer: request.customer, lines: request.lines.map((l) => [l.productId, l.quantity]), delivery: [request.delivery.commune, request.delivery.region ?? null] };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
