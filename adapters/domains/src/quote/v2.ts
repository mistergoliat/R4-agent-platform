import type { CallOptions } from '../shared/errors.js';

/**
 * Quote V2 port (R4-J3B). Model B: the Quote owner (MS-pesaschile-quote-service,
 * OpenAPI 2.0.0, docs/v2/openapi.yaml) never discovers products, prices
 * lines, rates freight or reads customers. The caller sends one frozen
 * commercial snapshot; the owner verifies its arithmetic, assigns identity
 * and number, resolves validity and renders the immutable document.
 *
 * Shapes mirror the owner's wire contract (field names verbatim), restricted
 * to what R4 sends and reads. Response objects keep only the members R4
 * uses; the owner may add members (2.x is additive) and R4 ignores them.
 *
 * Every method throws `DomainError` for an owner refusal or a transport
 * problem. Categories (adapter mapping):
 *   validation         400 invalid_request, 413, 422 validation_error / arithmetic_mismatch — nothing bound
 *   unauthorized       401 / 403 — nothing bound, never retried
 *   conflict           409 (code = owner code: idempotency_key_conflict, operation_in_progress, …)
 *   not_found          404
 *   temporarily_unavailable  the owner could not be reached, or a READ answered 5xx
 *   timeout / unknown_outcome  a MUTATION may have committed: only the idempotency
 *                      lookup (or a same-key replay of the frozen body) can tell
 *   contract_violation the owner answered outside its published contract
 */

/** The owner's idempotent operation name for create-and-issue. */
export const QUOTE_V2_CREATE_OPERATION = 'quote.create_and_issue';

/** Owner contract constant (QUOTE_V2_IDEMPOTENCY_AND_RECOVERY §3.3): `not_found` is final 30 s after the attempt's connection ended. */
export const QUOTE_V2_NOT_FOUND_FINAL_AFTER_MS = 30_000;

export type QuoteV2TaxBasis = 'included' | 'excluded' | 'exempt';

/** `taxRate` is required for included/excluded and absent for exempt; a canonical decimal string (e.g. "0.19"). */
export interface QuoteV2Charge {
  readonly amount: number;
  readonly taxBasis: QuoteV2TaxBasis;
  readonly taxRate?: string;
}

export interface QuoteV2Amounts {
  readonly net: number;
  readonly tax: number;
  readonly gross: number;
}

export interface QuoteV2ExternalCorrelation {
  readonly sourceSystem: string;
  readonly externalReferenceType?: string;
  readonly externalReference?: string;
}

interface QuoteV2Contact {
  readonly email?: string;
  readonly phone?: string;
}

export type QuoteV2Customer =
  | ({ readonly kind: 'guest'; readonly displayName?: string } & QuoteV2Contact)
  | ({ readonly kind: 'person'; readonly displayName: string; readonly rut?: string } & QuoteV2Contact)
  | ({ readonly kind: 'company'; readonly legalName: string; readonly tradeName?: string; readonly rut?: string; readonly contactName?: string } & QuoteV2Contact);

export interface QuoteV2LineInput {
  readonly kind: 'product' | 'service';
  readonly item: {
    readonly sourceSystem: string;
    readonly productRef?: string;
    readonly variantRef?: string;
    readonly sku?: string;
    readonly description: string;
    readonly attributes?: readonly { readonly name: string; readonly value: string }[];
  };
  /** `value` is a canonical decimal string ("2", "12.5"). */
  readonly quantity: { readonly value: string; readonly unit: string };
  readonly unitPrice: QuoteV2Charge;
  readonly pricingProvenance?: { readonly sourceSystem: string; readonly reference?: string; readonly asOf: string };
}

export interface QuoteV2ShippingInput {
  readonly carrier: { readonly code?: string; readonly name: string };
  readonly serviceType?: { readonly code?: string; readonly name?: string };
  readonly destination: { readonly commune: string; readonly region?: string; readonly country: 'CL' };
  readonly amount: QuoteV2Charge;
  readonly sourceQuote?: { readonly sourceSystem: string; readonly reference?: string; readonly asOf: string };
}

/** CreateQuoteRequest (closed schema). R4 never sends `validityOverride`. */
export interface QuoteV2CreateRequest {
  readonly externalCorrelation: QuoteV2ExternalCorrelation;
  readonly customer: QuoteV2Customer;
  readonly lines: readonly QuoteV2LineInput[];
  readonly shipping?: QuoteV2ShippingInput;
  readonly expectedTotals?: QuoteV2Amounts;
}

export type QuoteV2Status = 'draft' | 'issuing' | 'issued' | 'expired' | 'cancelled';

export interface QuoteV2Document {
  readonly available: boolean;
  readonly pdfSha256: string | null;
  readonly byteLength: number | null;
  readonly artifactRef: string | null;
  readonly generatedAt: string | null;
}

export interface QuoteV2Validity {
  readonly source: string;
  readonly policyId: string | null;
  readonly issueLocalDate: string;
  readonly validThroughLocalDate: string;
  readonly validUntilExclusive: string;
}

export interface QuoteV2Quote {
  readonly quoteId: string;
  readonly status: QuoteV2Status;
  readonly version: number;
  readonly quoteNumber: string | null;
  readonly currency: 'CLP';
  readonly externalCorrelation: QuoteV2ExternalCorrelation;
  readonly lines: readonly { readonly position: number; readonly amounts: QuoteV2Amounts }[];
  readonly shipping: { readonly amounts: QuoteV2Amounts } | null;
  readonly totals: QuoteV2Amounts & { readonly exemptNet: number };
  readonly validity: QuoteV2Validity | null;
  readonly issuance: { readonly issuedAt: string; readonly operationId: string; readonly issuerProfileId: string } | null;
  readonly document: QuoteV2Document;
}

export type QuoteV2OperationStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface QuoteV2Operation {
  readonly operationId: string;
  readonly status: QuoteV2OperationStatus;
  readonly quoteId: string;
  readonly deadlineAt: string;
  readonly completedAt: string | null;
  readonly attempts: { readonly count: number; readonly lastErrorCode: string | null; readonly nextAttemptAt: string | null };
}

/** 201 = the bound quote is no longer `issuing`; 202 = it is `issuing` (poll the operation). Never success by status alone. */
export interface QuoteV2CreateResult {
  readonly httpStatus: 201 | 202;
  readonly replayed: boolean;
  readonly quote: QuoteV2Quote;
  readonly operation: QuoteV2Operation;
}

export interface QuoteV2Binding {
  readonly boundAt: string;
  readonly requestFingerprint: string;
  readonly quoteId: string;
  readonly operationId: string | null;
  readonly quoteStatus: QuoteV2Status;
}

export interface QuoteV2DocumentBytes {
  readonly bytes: Uint8Array;
  /** `X-Document-Sha256` as the owner sent it (null when absent). */
  readonly declaredSha256: string | null;
}

export interface QuoteV2Service {
  /** POST /v2/quotes with `Idempotency-Key`: the same key and body always denote one logical quote. */
  createAndIssue(request: QuoteV2CreateRequest, idempotencyKey: string, options?: CallOptions): Promise<QuoteV2CreateResult>;
  /** GET /v2/quotes/{quoteId}. */
  getQuote(quoteId: string, options?: CallOptions): Promise<QuoteV2Quote>;
  /** GET /v2/operations/{operationId}. */
  getOperation(operationId: string, options?: CallOptions): Promise<QuoteV2Operation>;
  /** GET /v2/idempotency/current for `quote.create_and_issue`: what the caller's own key is bound to, or null. */
  lookupIdempotency(idempotencyKey: string, options?: CallOptions): Promise<QuoteV2Binding | null>;
  /** GET /v2/quotes/{quoteId}/document: the exact stored PDF bytes (never re-rendered). */
  getDocument(quoteId: string, options?: CallOptions): Promise<QuoteV2DocumentBytes>;
}

// ---- owner arithmetic (QUOTE_V2_DOMAIN_CONTRACT §6.3), exact integers only -------------------

const MICRO = 1_000_000n;
/** Owner `Quantity`: canonical positive decimal below 10000, ≤ 6 fractional digits, no trailing fractional zeros. */
export const QUOTE_V2_QUANTITY_PATTERN = /^(?:[1-9][0-9]{0,3}(?:\.[0-9]{0,5}[1-9])?|0\.[0-9]{0,5}[1-9])$/;
/** Owner `TaxRate`: canonical decimal fraction in (0, 1], ≤ 6 fractional digits. */
export const QUOTE_V2_TAX_RATE_PATTERN = /^(?:0\.[0-9]{0,5}[1-9]|1)$/;

/** An exact canonical decimal string as an integer number of millionths. */
function micros(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0'));
}

/** halfUp(n, d) = floor((2n + d) / (2d)) for n ≥ 0, d > 0. */
function halfUp(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

/** The owner's amounts of one charge (a line, or shipping with quantity "1"). */
export function quoteV2ChargeAmounts(charge: QuoteV2Charge, quantity: string): QuoteV2Amounts {
  if (!QUOTE_V2_QUANTITY_PATTERN.test(quantity)) throw new RangeError(`not a canonical quantity: ${quantity}`);
  if (!Number.isSafeInteger(charge.amount) || charge.amount < 0) throw new RangeError('a charge amount is a whole, non-negative CLP integer');
  const extension = halfUp(BigInt(charge.amount) * micros(quantity), MICRO);
  if (charge.taxBasis === 'exempt') {
    if (charge.taxRate !== undefined) throw new RangeError('an exempt charge carries no tax rate');
    return amounts(extension, 0n);
  }
  if (charge.taxRate === undefined || !QUOTE_V2_TAX_RATE_PATTERN.test(charge.taxRate)) throw new RangeError(`not a canonical tax rate: ${String(charge.taxRate)}`);
  const rate = micros(charge.taxRate);
  if (charge.taxBasis === 'included') {
    const net = halfUp(extension * MICRO, MICRO + rate);
    return amounts(net, extension - net);
  }
  return amounts(extension, halfUp(extension * rate, MICRO));
}

/** Totals = sums of the rounded charge amounts over every line and shipping. */
export function quoteV2Totals(request: Pick<QuoteV2CreateRequest, 'lines' | 'shipping'>): QuoteV2Amounts & { readonly exemptNet: number } {
  const charges = [...request.lines.map((l) => ({ charge: l.unitPrice, amounts: quoteV2ChargeAmounts(l.unitPrice, l.quantity.value) })), ...(request.shipping ? [{ charge: request.shipping.amount, amounts: quoteV2ChargeAmounts(request.shipping.amount, '1') }] : [])];
  const sum = (pick: (a: QuoteV2Amounts) => number, only?: QuoteV2TaxBasis) => charges.filter((c) => !only || c.charge.taxBasis === only).reduce((total, c) => total + pick(c.amounts), 0);
  return { net: sum((a) => a.net), tax: sum((a) => a.tax), gross: sum((a) => a.gross), exemptNet: sum((a) => a.net, 'exempt') };
}

/** A tax rate the Catalog states as a number (e.g. 0.19) as the owner's canonical decimal string, or null when it is not representable. */
export function canonicalTaxRate(rate: number): string | null {
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) return null;
  const scaled = Math.round(rate * 1_000_000);
  if (Math.abs(scaled - rate * 1_000_000) > 1e-6) return null;
  if (scaled === 1_000_000) return '1';
  return `0.${String(scaled).padStart(6, '0').replace(/0+$/, '')}`;
}

function amounts(net: bigint, tax: bigint): QuoteV2Amounts {
  const gross = net + tax;
  if (gross > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('amount overflow');
  return { net: Number(net), tax: Number(tax), gross: Number(gross) };
}
