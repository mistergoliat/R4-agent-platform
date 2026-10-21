import { describe, expect, it, vi } from 'vitest';
import { DomainError, type CustomerProfilePort, type CustomerPurchaseItem, type CustomerPurchasePage, type IdentityResolution } from '@r4-adapters/domains';
import {
  assertOutputBytes,
  boundedProductName,
  CONTEXT_OUTPUT_MAX_BYTES,
  customerContextV2Input,
  customerPurchaseHistoryV1Input,
  HISTORY_OUTPUT_MAX_BYTES,
  readCustomerContextV2,
  readCustomerPurchaseHistoryV1,
} from '../../../agents/sales/src/capabilities/customer-profile-outputs.js';
import { answer, clientWith, fixtureById, grantFor, NOW } from './support.js';

// R4-J4-R2: boundary C (what the model may observe). Synthetic, explicit identities only: no resolver.

const VERIFIED: IdentityResolution = { status: 'verified', customerRef: 'prestashop_customer:900000301', grant: grantFor(undefined, '2026-10-15T12:10:00.000Z'), resolvedAt: NOW.toISOString() };
const OPTIONS = { now: NOW };

/** A port whose operations fail unless given: proves which operation (and so which purpose) a reader uses. */
function strictPort(overrides: Partial<CustomerProfilePort>) {
  return {
    getSalesContext: vi.fn<CustomerProfilePort['getSalesContext']>(overrides.getSalesContext ?? (() => Promise.reject(new Error('getSalesContext must not be called')))),
    getPurchaseHistory: vi.fn<CustomerProfilePort['getPurchaseHistory']>(overrides.getPurchaseHistory ?? (() => Promise.reject(new Error('getPurchaseHistory must not be called')))),
  };
}

const item = (overrides: Partial<CustomerPurchaseItem> = {}): CustomerPurchaseItem => ({
  productName: 'Rack sintetico',
  catalogKey: null,
  lastPurchasedOn: '2026-09-28',
  totalQuantity: 1,
  orderCount: 1,
  lineKind: 'standard',
  ...overrides,
});
const page = (items: CustomerPurchaseItem[], extra: Partial<Extract<CustomerPurchasePage, { status: 'available' }>> = {}): CustomerPurchasePage => ({
  status: 'available',
  items,
  offset: 0,
  hasMore: false,
  nextOffset: null,
  datePrecision: 'day_timezone_unverified',
  validUntil: '2026-10-15T12:15:00.000Z',
  ...extra,
});

describe('inputs carry no identifier (I1)', () => {
  it.each(['customerRef', 'customerId', 'phone', 'email', 'waId', 'cursor', 'subject', 'purpose'])('rejects %s', (field) => {
    expect(customerContextV2Input.safeParse({ [field]: 'x' }).success).toBe(false);
    expect(customerPurchaseHistoryV1Input.safeParse({ [field]: 'x' }).success).toBe(false);
  });

  it('pages are bounded: offset 0–40, limit 1–10 (default 5)', () => {
    expect(customerPurchaseHistoryV1Input.parse({})).toEqual({ offset: 0, limit: 5 });
    for (const bad of [{ offset: 41 }, { limit: 11 }, { limit: 0 }, { offset: -1 }]) expect(customerPurchaseHistoryV1Input.safeParse(bad).success).toBe(false);
  });
});

describe('identity gate: without a verified resolution there is no Customer Profile call (§7 rows 1–4)', () => {
  it.each([
    [null, 'anonymous'],
    [{ status: 'not_linked', resolvedAt: NOW.toISOString() }, 'not_linked'],
    [{ status: 'not_verified', resolvedAt: NOW.toISOString() }, 'not_verified'],
    [{ status: 'ambiguous', resolvedAt: NOW.toISOString() }, 'not_verified'],
    [{ status: 'conflicted', resolvedAt: NOW.toISOString() }, 'not_verified'],
    [{ status: 'not_authorized', resolvedAt: NOW.toISOString() }, 'not_authorized'],
  ] as const)('%j → %s', async (resolution, reason) => {
    const port = strictPort({});
    expect(await readCustomerContextV2(resolution as IdentityResolution | null, port, OPTIONS)).toEqual({ identity: 'unavailable', reason });
    expect(await readCustomerPurchaseHistoryV1(resolution as IdentityResolution | null, {}, port, OPTIONS)).toEqual({ identity: 'unavailable', reason });
    expect(port.getSalesContext).not.toHaveBeenCalled();
    expect(port.getPurchaseHistory).not.toHaveBeenCalled();
  });

  it('a verified resolution with an expired grant, or one that does not cover the purpose, is incoherent_grant (I3)', async () => {
    const port = strictPort({});
    for (const grant of [grantFor(['sales_context', 'purchase_history'], '2026-10-15T12:00:00.000Z'), grantFor(['sales_context'])]) {
      const resolution: IdentityResolution = { ...VERIFIED, grant };
      await expect(readCustomerPurchaseHistoryV1(resolution, {}, port, OPTIONS)).rejects.toMatchObject({ category: 'contract_violation', code: 'incoherent_grant' });
    }
    expect(port.getPurchaseHistory).not.toHaveBeenCalled();
  });
});

describe('purpose comes from the reader, never from the model', () => {
  it('get_context@2 uses only getSalesContext; get_purchase_history@1 only getPurchaseHistory', async () => {
    const context = strictPort({ getSalesContext: () => Promise.resolve({ status: 'available', purchaseHistory: 'present', validUntil: null }) });
    await readCustomerContextV2(VERIFIED, context, OPTIONS);
    expect(context.getSalesContext).toHaveBeenCalledOnce();
    const history = strictPort({ getPurchaseHistory: () => Promise.resolve(page([])) });
    await readCustomerPurchaseHistoryV1(VERIFIED, { offset: 5, limit: 3 }, history, OPTIONS);
    expect(history.getPurchaseHistory).toHaveBeenCalledWith('prestashop_customer:900000301', VERIFIED.status === 'verified' ? VERIFIED.grant : null, { offset: 5, limit: 3 }, OPTIONS);
  });
});

describe('get_context@2 output', () => {
  it('maps the port and exposes min(CP validUntil, grant expiry), never null', async () => {
    const port = strictPort({ getSalesContext: () => Promise.resolve({ status: 'available', purchaseHistory: 'none', validUntil: '2026-10-15T12:15:00.000Z' }) });
    expect(await readCustomerContextV2(VERIFIED, port, OPTIONS)).toEqual({ identity: 'verified', purchaseHistory: 'none', validUntil: '2026-10-15T12:10:00.000Z' });
    const noCp = strictPort({ getSalesContext: () => Promise.resolve({ status: 'available', purchaseHistory: 'unknown', validUntil: null }) });
    expect(await readCustomerContextV2(VERIFIED, noCp, OPTIONS)).toMatchObject({ validUntil: '2026-10-15T12:10:00.000Z' });
  });

  it('not_found → not_on_file; withheld → withheld (never not_on_file for an existing account)', async () => {
    expect(await readCustomerContextV2(VERIFIED, strictPort({ getSalesContext: () => Promise.resolve({ status: 'not_found', validUntil: null }) }), OPTIONS)).toEqual({ identity: 'unavailable', reason: 'not_on_file' });
    expect(await readCustomerContextV2(VERIFIED, strictPort({ getSalesContext: () => Promise.resolve({ status: 'withheld', validUntil: null }) }), OPTIONS)).toEqual({ identity: 'unavailable', reason: 'withheld' });
  });

  it('failures stay failures: 401/403 is unauthorized, never unavailable (I5)', async () => {
    const { client } = clientWith(() => answer(403, { error: 'forbidden', requiredScope: 'customer.sales_context.read' }));
    await expect(readCustomerContextV2(VERIFIED, client, OPTIONS)).rejects.toMatchObject({ category: 'unauthorized' });
  });

  it('the largest output stays under 300 bytes', async () => {
    const output = await readCustomerContextV2(VERIFIED, strictPort({ getSalesContext: () => Promise.resolve({ status: 'available', purchaseHistory: 'unknown', validUntil: null }) }), OPTIONS);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(CONTEXT_OUTPUT_MAX_BYTES);
  });
});

describe('get_purchase_history@1 output', () => {
  it('declares historical, gross, day-precision facts and hides lineKind, the reference and the grant', async () => {
    const output = await readCustomerPurchaseHistoryV1(VERIFIED, { limit: 10 }, strictPort({ getPurchaseHistory: () => Promise.resolve(page([item(), item({ productName: null, totalQuantity: 0 })])) }), OPTIONS);
    expect(output).toEqual({
      identity: 'verified',
      meaning: 'purchased_historically_not_ownership',
      quantityBasis: 'gross_units_not_net_of_returns',
      datePrecision: 'day_timezone_unverified',
      items: [
        { productName: 'Rack sintetico', catalogKey: null, lastPurchasedOn: '2026-09-28', totalQuantity: 1, orderCount: 1 },
        { productName: null, catalogKey: null, lastPurchasedOn: '2026-09-28', totalQuantity: 0, orderCount: 1 },
      ],
      page: { offset: 0, returned: 2, hasMore: false, nextOffset: null },
      validUntil: '2026-10-15T12:10:00.000Z',
    });
    expect(JSON.stringify(output)).not.toMatch(/lineKind|prestashop_customer|synthetic-grant|withheld/);
  });

  it('AP-10: administrative services are excluded; a free physical item (zero_price_line) stays', async () => {
    const output = await readCustomerPurchaseHistoryV1(VERIFIED, {}, strictPort({ getPurchaseHistory: () => Promise.resolve(page([item({ productName: 'Regalo', lineKind: 'zero_price_line' }), item({ productName: 'Servicio vendedor', lineKind: 'administrative_service' })])) }), OPTIONS);
    expect(output.identity === 'verified' && output.items.map((entry) => entry.productName)).toEqual(['Regalo']);
    expect(output.identity === 'verified' && output.page.returned).toBe(1);
  });

  it('nextOffset beyond the 50-item window is null', async () => {
    const run = (nextOffset: number) => readCustomerPurchaseHistoryV1(VERIFIED, { offset: 40, limit: 10 }, strictPort({ getPurchaseHistory: () => Promise.resolve(page([item()], { offset: 40, hasMore: true, nextOffset })) }), OPTIONS);
    expect(await run(50)).toMatchObject({ page: { nextOffset: null } });
    const inWindow = await readCustomerPurchaseHistoryV1(VERIFIED, { offset: 30, limit: 10 }, strictPort({ getPurchaseHistory: () => Promise.resolve(page([item()], { offset: 30, hasMore: true, nextOffset: 40 })) }), OPTIONS);
    expect(inWindow).toMatchObject({ page: { nextOffset: 40 } });
  });

  it('names: 120 code points pass; longer ones become 119 + … without splitting a surrogate pair', () => {
    expect(boundedProductName(null)).toBeNull();
    expect(boundedProductName('😀'.repeat(120))).toBe('😀'.repeat(120));
    const cut = boundedProductName('😀'.repeat(121))!;
    expect([...cut]).toHaveLength(120);
    expect(cut).toBe(`${'😀'.repeat(119)}…`);
    // No lone surrogate: every high surrogate is followed by a low one and vice versa.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(false);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test('😀'.slice(0, 1))).toBe(true);
  });

  it('the largest page (10 items of 255 four-byte code points from CP) stays under 8 KiB', async () => {
    const items = Array.from({ length: 10 }, () => item({ productName: '😀'.repeat(255), totalQuantity: Number.MAX_SAFE_INTEGER, orderCount: Number.MAX_SAFE_INTEGER }));
    const output = await readCustomerPurchaseHistoryV1(VERIFIED, { limit: 10 }, strictPort({ getPurchaseHistory: () => Promise.resolve(page(items, { hasMore: true, nextOffset: 10 })) }), OPTIONS);
    const bytes = Buffer.byteLength(JSON.stringify(output));
    expect(bytes).toBeGreaterThan(4_800);
    expect(bytes).toBeLessThan(HISTORY_OUTPUT_MAX_BYTES);
  });

  it('the byte guard: exactly 8 192 B passes, 8 193 B fails without any partial payload', () => {
    const sized = (bytes: number) => ({ pad: 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify({ pad: '' }))) });
    expect(Buffer.byteLength(JSON.stringify(sized(8192)))).toBe(8192);
    expect(() => assertOutputBytes(sized(8192), HISTORY_OUTPUT_MAX_BYTES)).not.toThrow();
    let error: unknown;
    try {
      assertOutputBytes(sized(8193), HISTORY_OUTPUT_MAX_BYTES);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('output_too_large');
    expect(JSON.stringify((error as DomainError).details)).toBe('{"bytes":8193,"maxBytes":8192}');
  });

  it('an incomplete history is a failure through the real adapter, never a partial list', async () => {
    const { client } = clientWith(() => answer(200, fixtureById('PH09')));
    const resolution: IdentityResolution = { ...VERIFIED, customerRef: 'prestashop_customer:900000309', grant: grantFor() };
    await expect(readCustomerPurchaseHistoryV1(resolution, { limit: 10 }, client, OPTIONS)).rejects.toMatchObject({ category: 'temporarily_unavailable', code: 'history_unavailable' });
  });

  it('end to end over the adapter with the PH05 fixture: the seller service line never reaches the model', async () => {
    const { client } = clientWith(() => answer(200, fixtureById('PH05')));
    const resolution: IdentityResolution = { ...VERIFIED, customerRef: 'prestashop_customer:900000305', grant: grantFor() };
    const output = await readCustomerPurchaseHistoryV1(resolution, { limit: 10 }, client, OPTIONS);
    expect(output.identity === 'verified' && output.items.map((entry) => entry.productName)).toEqual(['Disco sintetico 10 kg - Color : Negro']);
  });
});
