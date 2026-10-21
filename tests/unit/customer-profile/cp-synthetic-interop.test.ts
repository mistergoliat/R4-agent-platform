import { describe, expect, it } from 'vitest';
import { DomainError } from '@r4-adapters/domains';
import { CustomerProfileHttpClient, type CustomerProfileFetch } from '@r4-adapters/customer-http';
import { grantFor } from './support.js';

// R4-J4-R2 (F), revised by R4-J4-R3: OPTIONAL HTTP check against a LOCAL Customer Profile running the
// synthetic producer with CUSTOMER_PROFILE_CUSTOMER_GRANT_MODE=disabled (the R2 set-up: every answer
// is service_scope_only). Since R4-J4-R3, R4 sends the CIA grant and accepts only a grant-verified
// answer, so such a Customer Profile must be REFUSED. The positive end-to-end flow (a real CIA grant
// verified by CP-S5) is the R4 → CIA → CP campaign: tests/interop/cia-cp-campaign.test.ts.
// Skipped unless the operator sets:
//   R4_CP_SYNTHETIC_BASE_URL   e.g. http://127.0.0.1:4310 (loopback only)
//   R4_CP_SYNTHETIC_TOKEN      the r4-sales token of the local synthetic registry
// Synthetic customers only (ids 900000201–900000313). Never point this at a real deployment.

const BASE_URL = process.env.R4_CP_SYNTHETIC_BASE_URL;
const TOKEN = process.env.R4_CP_SYNTHETIC_TOKEN;
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

describe.skipIf(!enabled)('a local CP with grant mode disabled is refused (R4-J4-R3)', () => {
  it('every answer authorized by the bearer alone is a contract_violation, for both purposes', async () => {
    expect(await fails(client().getSalesContext(ref(900000201), grant()))).toMatchObject({ category: 'contract_violation', code: 'authorization_basis_insufficient' });
    expect(await fails(client().getPurchaseHistory(ref(900000301), grant(), { offset: 0, limit: 10 }))).toMatchObject({ category: 'contract_violation', code: 'authorization_basis_insufficient' });
  });

  it('auth: an unknown token is 401 unauthorized', async () => {
    expect(await fails(client('unknown-token-0123456789abcdefghijklmnopqrstuvwxyz').getSalesContext(ref(900000201), grant()))).toMatchObject({ category: 'unauthorized', details: { httpStatus: 401 } });
  });

  it('a customer outside the synthetic range never leaves R4', async () => {
    expect(await fails(client().getSalesContext(ref(1), grant()))).toMatchObject({ category: 'validation', code: 'customer_ref_outside_synthetic_range' });
  });
});
