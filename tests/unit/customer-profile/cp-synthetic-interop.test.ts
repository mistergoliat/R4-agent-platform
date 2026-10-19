import { describe, expect, it } from 'vitest';
import { DomainError } from '@r4-adapters/domains';
import { CustomerProfileHttpClient, type CustomerProfileFetch } from '@r4-adapters/customer-http';
import { readCustomerPurchaseHistoryV1 } from '../../../agents/sales/src/capabilities/customer-profile-outputs.js';
import { grantFor } from './support.js';

// R4-J4-R2 (F): OPTIONAL HTTP integration against a LOCAL Customer Profile running the provisional
// synthetic producer (CP branch feat/cp-j4-context-02c-synthetic, CUSTOMER_PROFILE_SALES_CONTEXT_SOURCE=
// synthetic, API auth enforce). Skipped unless the operator sets:
//   R4_CP_SYNTHETIC_BASE_URL     e.g. http://127.0.0.1:4310 (loopback only)
//   R4_CP_SYNTHETIC_TOKEN        the r4-sales token of the local synthetic registry
//   R4_CP_SYNTHETIC_OTHER_TOKEN  optional: a principal WITHOUT customer.sales_context.read
// Synthetic customers only (ids 900000201–900000313). Never point this at a real deployment.

const BASE_URL = process.env.R4_CP_SYNTHETIC_BASE_URL;
const TOKEN = process.env.R4_CP_SYNTHETIC_TOKEN;
const OTHER = process.env.R4_CP_SYNTHETIC_OTHER_TOKEN;
const enabled = BASE_URL !== undefined && TOKEN !== undefined && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE_URL);

const realFetch: CustomerProfileFetch = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, headers: response.headers, body: response.body };
};
const client = (token = TOKEN!) => new CustomerProfileHttpClient({ config: { baseUrl: BASE_URL!, bearerToken: token, timeoutMs: 3_000, lifecycle: 'synthetic' }, fetch: realFetch });
const grant = () => grantFor(['sales_context', 'purchase_history'], new Date(Date.now() + 5 * 60_000).toISOString());
const ref = (id: number) => `prestashop_customer:${id}`;
const fails = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
};

describe.skipIf(!enabled)('interop with the local CP synthetic producer (HTTP, enforce)', () => {
  it('sales_context: present, none, unknown, not_found, withheld (operational, deleted, guest, inactive) and degraded', async () => {
    const c = client();
    const read = (id: number) => c.getSalesContext(ref(id), grant());
    expect(await read(900000201)).toMatchObject({ status: 'available', purchaseHistory: 'present' });
    expect(await read(900000202)).toMatchObject({ status: 'available', purchaseHistory: 'none' });
    expect(await read(900000203)).toMatchObject({ status: 'available', purchaseHistory: 'unknown' });
    expect(await read(900000204)).toMatchObject({ status: 'not_found' });
    for (const id of [900000205, 900000206, 900000207, 900000208]) expect(await read(id), String(id)).toMatchObject({ status: 'withheld' });
    expect(await fails(read(900000209))).toMatchObject({ category: 'temporarily_unavailable', code: 'profile_unavailable', details: { ownerCode: 'prestashop_unavailable' } });
  });

  it('purchase_history: items with gross units, null names, zero-price and administrative lines, paging, partial and degraded', async () => {
    const c = client();
    const read = (id: number, limit = 10, offset = 0) => c.getPurchaseHistory(ref(id), grant(), { limit, offset });
    const normal = await read(900000301);
    expect(normal).toMatchObject({ status: 'available', hasMore: false, nextOffset: null, datePrecision: 'day_timezone_unverified' });
    expect(normal.status === 'available' && normal.items.map((item) => [item.productName, item.totalQuantity, item.orderCount, item.lastPurchasedOn])).toEqual([
      ['Rack sintetico', 1, 1, '2026-09-28'],
      ['Disco sintetico 10 kg - Color : Rojo', 4, 2, '2026-03-14'],
      ['Barra olimpica sintetica 20 kg', 1, 1, '2025-11-03'],
    ]);
    expect(await read(900000302)).toMatchObject({ status: 'available', items: [] });
    expect(await read(900000303)).toMatchObject({ items: [{ productName: null, catalogKey: null }] });
    expect(await read(900000304)).toMatchObject({ items: [{ lineKind: 'zero_price_line', totalQuantity: 1 }, { lineKind: 'standard', totalQuantity: 0 }] });
    expect(await read(900000305)).toMatchObject({ items: [{ lineKind: 'standard' }, { lineKind: 'administrative_service' }] });
    expect(await read(900000306)).toMatchObject({ items: [{ lastPurchasedOn: '2026-01-01' }] });
    expect(await read(900000308, 2)).toMatchObject({ hasMore: true, nextOffset: 2 });
    expect(await fails(read(900000309))).toMatchObject({ category: 'temporarily_unavailable', code: 'history_unavailable' });
    expect(await read(900000310)).toMatchObject({ status: 'not_found' });
    expect(await read(900000311)).toMatchObject({ status: 'withheld' });
    expect(await read(900000312)).toMatchObject({ status: 'withheld' });
    expect(await fails(read(900000313))).toMatchObject({ code: 'profile_unavailable', details: { ownerCode: 'prestashop_timeout' } });
  });

  it('boundary C over the live producer: the seller service line never reaches the model', async () => {
    const output = await readCustomerPurchaseHistoryV1({ status: 'verified', customerRef: ref(900000305), grant: grant(), resolvedAt: new Date().toISOString() }, { limit: 10 }, client(), { now: new Date() });
    expect(output.identity === 'verified' && output.items.map((item) => item.productName)).toEqual(['Disco sintetico 10 kg - Color : Negro']);
  });

  it('auth: an unknown token is 401 and a principal without the scope is 403, both unauthorized', async () => {
    expect(await fails(client('unknown-token-0123456789abcdefghijklmnopqrstuvwxyz').getSalesContext(ref(900000201), grant()))).toMatchObject({ category: 'unauthorized', details: { httpStatus: 401 } });
    if (OTHER) {
      expect(await fails(client(OTHER).getSalesContext(ref(900000201), grant()))).toMatchObject({ category: 'unauthorized', details: { httpStatus: 403, requiredScope: 'customer.sales_context.read' } });
    }
  });

  it('a customer outside the synthetic dataset is not_found (nothing reaches real data)', async () => {
    expect(await client().getSalesContext(ref(1), grant())).toMatchObject({ status: 'not_found' });
  });
});
