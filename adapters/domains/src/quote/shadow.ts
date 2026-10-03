import { createHash } from 'node:crypto';
import type { FixtureOwnerItem } from '../catalog/fixture.js';
import { AvailabilitySwitch } from '../shared/availability.js';
import { DomainError, type CallOptions } from '../shared/errors.js';
import type { AfterIssue, FixtureQuoteFaults } from './fixture.js';
import type { Quote, QuoteCreateOutcome, QuoteCreateRequest, QuoteService } from './port.js';

const VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

/** The catalog owner's item lookup the shadow Quote owner prices from (the fixture catalog provides it). */
export interface ShadowCatalogLookup {
  current(itemKey: string): FixtureOwnerItem | null;
}

/**
 * The shipping owner's cost lookup the shadow Quote owner prices shipping
 * from (the fixture shipping owner provides it). Owner-side, like the catalog
 * lookup: how Quote obtains shipping is J3's decision, so the shadow owner
 * does not pick among Shipping port offers (R4-J2B: no selected carrier).
 */
export interface ShadowShippingLookup {
  standardCost(commune: string, totalWeightKg: number): number | null;
}

/** One quote the shadow owner recorded (what WOULD have been issued). */
export interface ShadowQuoteRecord {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly quote: Quote;
  readonly recordedAt: string;
}

/**
 * Shadow Quote owner (R4-H). No sandbox, preview or draft-only mode of the
 * real Quote Service is documented, so shadow runs use this record-only
 * owner behind the same `QuoteService` port:
 *
 * - it prices every line from the catalog owner's own item lookup and
 *   shipping from the shipping owner's cost lookup (both lookups are
 *   owner-side, not the R4 Catalog/Shipping ports — how Quote reads Catalog
 *   and Shipping is J3's decision, not made here),
 * - it keeps the Quote port's semantics exactly — one quote per idempotency
 *   key, replay returns the same quote, a different request under a used key
 *   is rejected, lookup by key for reconciliation, classified failures —
 * - and it RECORDS the quote instead of issuing a commercial document:
 *   numbers come from a reserved shadow range (`COT-9xxxxx`), the id is
 *   `shadow-qt-…`, the document reference is `shadow-record:…` (no document
 *   exists), and nothing leaves this object.
 *
 * Fault hooks mirror the fixture owner's, so shadow workloads can put the
 * caller into the unknown-outcome windows (reconciliation).
 */
export class ShadowQuoteService implements QuoteService {
  readonly bindingKind = 'shadow' as const;
  readonly availability = new AvailabilitySwitch('quote');
  readonly faults: FixtureQuoteFaults = {};
  readonly #catalog: ShadowCatalogLookup;
  readonly #shipping: ShadowShippingLookup;
  readonly #now: () => Date;
  readonly #byKey = new Map<string, ShadowQuoteRecord>();
  #sequence = 0;

  constructor(options: { catalog: ShadowCatalogLookup; shipping: ShadowShippingLookup; now?: () => Date }) {
    this.#catalog = options.catalog;
    this.#shipping = options.shipping;
    this.#now = options.now ?? (() => new Date());
  }

  /** Every quote recorded (the would-have-been-issued ledger). */
  get records(): readonly ShadowQuoteRecord[] {
    return [...this.#byKey.values()];
  }

  async create(request: QuoteCreateRequest, idempotencyKey: string, options?: CallOptions): Promise<QuoteCreateOutcome> {
    await this.availability.enter(options);
    const requestHash = hashOf(request);
    const existing = this.#byKey.get(idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) return { status: 'rejected', code: 'idempotency_key_reused', message: 'this idempotency key already recorded a quote for a different request', details: { quoteNumber: existing.quote.quoteNumber } };
      return this.#after({ status: 'created', quote: existing.quote, replayed: true });
    }
    const priced = this.#price(request);
    if (priced.status === 'rejected') return priced;
    this.#byKey.set(idempotencyKey, { idempotencyKey, requestHash, quote: priced.quote, recordedAt: this.#now().toISOString() });
    return this.#after({ status: 'created', quote: priced.quote, replayed: false });
  }

  async findByIdempotencyKey(idempotencyKey: string, options?: CallOptions): Promise<Quote | null> {
    await this.availability.enter(options);
    if (this.faults.lookup?.() === 'timeout') throw new DomainError('timeout', 'lookup_timeout', 'the quote owner did not answer the lookup in time');
    return this.#byKey.get(idempotencyKey)?.quote ?? null;
  }

  #after(outcome: QuoteCreateOutcome): Promise<QuoteCreateOutcome> {
    const mode: AfterIssue = this.faults.afterIssue?.() ?? 'answer';
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
      const item = this.#catalog.current(line.productId);
      if (!item) return reject('unknown_product', `the catalog has no sellable item ${line.productId}`, { productId: line.productId });
      if (item.sellability !== 'sellable') return reject('product_unavailable', `${item.name} is ${item.sellability}`, { productId: line.productId, stockStatus: item.sellability });
      if (item.availableQuantity !== null && item.availableQuantity < line.quantity) return reject('insufficient_stock', `only ${item.availableQuantity} units of ${item.name} are available`, { productId: line.productId, available: item.availableQuantity });
      weight += item.weightKg * line.quantity;
      lines.push({ productId: item.itemKey, name: item.name, quantity: line.quantity, unitPrice: item.unitPrice, lineTotal: { amount: item.unitPrice.amount * line.quantity, currency: 'CLP' as const } });
    }
    const shippingAmount = this.#shipping.standardCost(request.delivery.commune, Math.round(weight * 10) / 10);
    if (shippingAmount === null) return reject('destination_not_serviceable', `no delivery to ${request.delivery.commune}`, { commune: request.delivery.commune });
    this.#sequence += 1;
    const issuedAt = this.#now();
    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal.amount, 0);
    const quoteNumber = `COT-${String(900_000 + this.#sequence)}`;
    return {
      status: 'priced',
      quote: {
        quoteId: `shadow-qt-${String(this.#sequence).padStart(6, '0')}`,
        quoteNumber,
        status: 'issued',
        customer: request.customer,
        lines,
        shipping: { serviceLevel: 'standard', commune: request.delivery.commune, amount: { amount: shippingAmount, currency: 'CLP' } },
        subtotal: { amount: subtotal, currency: 'CLP' },
        total: { amount: subtotal + shippingAmount, currency: 'CLP' },
        issuedAt: issuedAt.toISOString(),
        validUntil: new Date(issuedAt.getTime() + VALIDITY_MS).toISOString(),
        documentRef: `shadow-record:${quoteNumber}`,
      },
    };
  }
}

function hashOf(request: QuoteCreateRequest): string {
  const canonical = { customer: request.customer, lines: request.lines.map((l) => [l.productId, l.quantity]), delivery: [request.delivery.commune, request.delivery.region ?? null] };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
