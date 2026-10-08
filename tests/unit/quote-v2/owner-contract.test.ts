import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DomainError, FixtureQuoteV2Service, canonicalTaxRate, fingerprintOf, quoteV2ChargeAmounts, quoteV2Totals, type QuoteV2CreateRequest } from '@r4-adapters/domains';

/** The owner's published examples (copied verbatim from MS-pesaschile-quote-service docs/v2/examples, see SOURCE.json). */
const example = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../../adapters/domains/quote/http/fixtures/${name}`, import.meta.url), 'utf8')) as T;
const OWNER_REQUEST = example<QuoteV2CreateRequest>('create-and-issue.request.json');
const OWNER_201 = example<{ quote: { lines: { amounts: unknown }[]; shipping: { amounts: unknown }; totals: unknown } }>('create-and-issue.response-201.json');

describe('Quote V2 owner arithmetic (QUOTE_V2_DOMAIN_CONTRACT §6.3)', () => {
  it('reproduces the owner worked example exactly, per charge and in total', () => {
    expect(quoteV2Totals(OWNER_REQUEST)).toEqual({ net: 123_612, tax: 23_486, gross: 147_098, exemptNet: 0 });
    expect(OWNER_REQUEST.lines.map((l) => quoteV2ChargeAmounts(l.unitPrice, l.quantity.value))).toEqual(OWNER_201.quote.lines.map((l) => l.amounts));
    expect(quoteV2ChargeAmounts(OWNER_REQUEST.shipping!.amount, '1')).toEqual(OWNER_201.quote.shipping.amounts);
    expect(quoteV2Totals(OWNER_REQUEST)).toMatchObject(OWNER_201.quote.totals as object);
  });

  it('tax included: net = halfUp(gross / (1 + rate)), tax = gross − net', () => {
    expect(quoteV2ChargeAmounts({ amount: 24_990, taxBasis: 'included', taxRate: '0.19' }, '2')).toEqual({ net: 42_000, tax: 7_980, gross: 49_980 });
    expect(quoteV2ChargeAmounts({ amount: 89_990, taxBasis: 'included', taxRate: '0.19' }, '1')).toEqual({ net: 75_622, tax: 14_368, gross: 89_990 });
  });

  it('tax excluded and exempt (where a caller uses them): exact integer rounding, exempt carries no rate', () => {
    expect(quoteV2ChargeAmounts({ amount: 5_990, taxBasis: 'excluded', taxRate: '0.19' }, '1')).toEqual({ net: 5_990, tax: 1_138, gross: 7_128 });
    expect(quoteV2ChargeAmounts({ amount: 1_000, taxBasis: 'exempt' }, '3')).toEqual({ net: 3_000, tax: 0, gross: 3_000 });
    expect(() => quoteV2ChargeAmounts({ amount: 1_000, taxBasis: 'exempt', taxRate: '0.19' }, '1')).toThrow(RangeError);
    expect(() => quoteV2ChargeAmounts({ amount: 1_000, taxBasis: 'included' }, '1')).toThrow(RangeError);
    const mixed = quoteV2Totals({ lines: [{ kind: 'service', item: { sourceSystem: 's', description: 'x' }, quantity: { value: '1', unit: 'unit' }, unitPrice: { amount: 500, taxBasis: 'exempt' } }, { kind: 'product', item: { sourceSystem: 's', description: 'y' }, quantity: { value: '1', unit: 'unit' }, unitPrice: { amount: 119, taxBasis: 'included', taxRate: '0.19' } }] });
    expect(mixed).toEqual({ net: 600, tax: 19, gross: 619, exemptNet: 500 });
  });

  it('CLP rounding is half-up at the charge boundary only (fractional quantities and .5 cases)', () => {
    // 0.25 × 10 = 2.5 → 3 (half up); then included 19 %: net = halfUp(3 / 1.19) = 3 (2.52…), tax 0.
    expect(quoteV2ChargeAmounts({ amount: 10, taxBasis: 'included', taxRate: '0.19' }, '0.25')).toEqual({ net: 3, tax: 0, gross: 3 });
    // excluded: 50 × 0.19 = 9.5 → 10.
    expect(quoteV2ChargeAmounts({ amount: 50, taxBasis: 'excluded', taxRate: '0.19' }, '1')).toEqual({ net: 50, tax: 10, gross: 60 });
    // totals are sums of rounded charges, never a rounding of the sum.
    const line = { kind: 'product' as const, item: { sourceSystem: 's', description: 'd' }, quantity: { value: '1', unit: 'unit' }, unitPrice: { amount: 1, taxBasis: 'included' as const, taxRate: '0.19' } };
    expect(quoteV2Totals({ lines: [line, line, line] })).toEqual({ net: 3, tax: 0, gross: 3, exemptNet: 0 });
    expect(() => quoteV2ChargeAmounts({ amount: 1, taxBasis: 'exempt' }, '1.50')).toThrow(RangeError);
  });

  it('canonical tax-rate strings from Catalog numbers', () => {
    expect(canonicalTaxRate(0.19)).toBe('0.19');
    expect(canonicalTaxRate(1)).toBe('1');
    expect(canonicalTaxRate(0.105)).toBe('0.105');
    expect(canonicalTaxRate(0)).toBeNull();
    expect(canonicalTaxRate(0.1234567)).toBeNull();
  });
});

describe('FixtureQuoteV2Service parity with the owner contract', () => {
  const at = new Date('2026-10-04T18:00:00Z');

  it('issues with owner identity, Chile 5-calendar-day validity and a hashed immutable document', async () => {
    const owner = new FixtureQuoteV2Service({ now: () => at });
    const result = await owner.createAndIssue(OWNER_REQUEST, 'r4x_00000000000000000000000000000001');
    expect(result).toMatchObject({ httpStatus: 201, replayed: false, quote: { status: 'issued', quoteNumber: 'PC-000001', currency: 'CLP', totals: { net: 123_612, tax: 23_486, gross: 147_098 }, document: { available: true } }, operation: { status: 'succeeded' } });
    // Same instants as the owner example: issued 2026-10-04, valid through 2026-10-08, expires 2026-10-09T03:00:00Z.
    expect(result.quote.validity).toEqual({ source: 'policy', policyId: 'cl-retail-5-calendar-days-v1', issueLocalDate: '2026-10-04', validThroughLocalDate: '2026-10-08', validUntilExclusive: '2026-10-09T03:00:00Z' });
    expect(result.quote.document.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('replays the same key + body, refuses the same key with a changed body, and binds nothing on a refusal', async () => {
    const owner = new FixtureQuoteV2Service({ now: () => at });
    const key = 'r4x_00000000000000000000000000000002';
    const first = await owner.createAndIssue(OWNER_REQUEST, key);
    const replay = await owner.createAndIssue(JSON.parse(JSON.stringify(OWNER_REQUEST)) as QuoteV2CreateRequest, key);
    expect(replay).toMatchObject({ replayed: true, quote: { quoteId: first.quote.quoteId } });
    const { expectedTotals: _dropped, ...changed } = OWNER_REQUEST;
    await expect(owner.createAndIssue(changed, key)).rejects.toMatchObject({ category: 'conflict', code: 'idempotency_key_conflict' });
    const mismatch = { ...OWNER_REQUEST, expectedTotals: { net: 123_612, tax: 23_486, gross: 147_099 } };
    await expect(owner.createAndIssue(mismatch, 'r4x_00000000000000000000000000000003')).rejects.toMatchObject({ category: 'validation', code: 'arithmetic_mismatch' });
    expect(await owner.lookupIdempotency('r4x_00000000000000000000000000000003')).toBeNull();
    expect(owner.quotes).toHaveLength(1);
  });

  it('async issuance: 202 issuing until the worker completes; a failed operation leaves the quote issuing without a document', async () => {
    const owner = new FixtureQuoteV2Service({ now: () => at });
    owner.faults.issuance = () => 'async';
    const pending = await owner.createAndIssue(OWNER_REQUEST, 'r4x_00000000000000000000000000000004');
    expect(pending).toMatchObject({ httpStatus: 202, quote: { status: 'issuing', document: { available: false } }, operation: { status: 'pending' } });
    owner.completeIssuance(pending.quote.quoteId, 'fail');
    expect(await owner.getQuote(pending.quote.quoteId)).toMatchObject({ status: 'issuing', document: { available: false } });
    expect(await owner.getOperation(pending.operation.operationId)).toMatchObject({ status: 'failed', attempts: { lastErrorCode: 'document_generation_failed' } });
    await expect(owner.getDocument(pending.quote.quoteId)).rejects.toMatchObject({ code: 'document_not_available' });
  });

  it('the fingerprint is canonical: key order does not change it, content does', () => {
    const reverse = (v: unknown): unknown => (Array.isArray(v) ? v.map(reverse) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : v);
    expect(fingerprintOf(reverse(OWNER_REQUEST) as QuoteV2CreateRequest)).toBe(fingerprintOf(OWNER_REQUEST));
    // Byte-exact parity with the owner: its published binding of this very request carries this fingerprint.
    const bound = example<{ binding: { requestFingerprint: string } }>('idempotency-lookup.bound.json');
    expect(fingerprintOf(OWNER_REQUEST)).toBe(bound.binding.requestFingerprint);
    expect(fingerprintOf({ ...OWNER_REQUEST, customer: { kind: 'guest' } })).not.toBe(fingerprintOf(OWNER_REQUEST));
  });

  it('never prices: it has no Catalog or Shipping dependency and sends no email', () => {
    const owner = new FixtureQuoteV2Service() as unknown as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(owner)).sort()).toEqual(['completeIssuance', 'constructor', 'createAndIssue', 'createCalls', 'getDocument', 'getOperation', 'getQuote', 'lookupIdempotency', 'quotes'].sort());
    expect(new DomainError('validation', 'x', 'y').retryable).toBe(false);
  });
});
