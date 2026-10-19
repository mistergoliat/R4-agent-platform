import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@r4-adapters/domains';
import { CUSTOMER_PROFILE_MAX_RESPONSE_BYTES, CustomerProfileHttpClient, readBounded } from '@r4-adapters/customer-http';
import { answer, clientWith, clone, CONFIG, fixtureById, get, grantFor, NOW, set, streamOf, TOKEN, type Json, type JsonObject } from './support.js';

// R4-J4-R2: Customer Profile HTTP client, unit level (injected fetch, synthetic bodies only).

const REF = 'prestashop_customer:900000201';
const HISTORY_REF = 'prestashop_customer:900000301';
const SC01 = () => fixtureById('SC01');
const PH01 = () => fixtureById('PH01');

async function failureOf(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('request serialization', () => {
  it('POSTs the sales_context body to the single route with bearer auth, JSON headers and no query', async () => {
    const { client, calls } = clientWith(() => answer(200, SC01()));
    await client.getSalesContext(REF, grantFor(), { correlationId: 'r4:run.1' });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [(typeof calls)[number]];
    expect(url).toBe('http://127.0.0.1:4310/v1/capabilities/customer/sales-context');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"customerRef":"prestashop_customer:900000201","purpose":"sales_context"}');
    expect(init.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-correlation-id': 'r4:run.1' });
  });

  it('purchase_history carries its page; the purpose comes from the operation, never from an argument', async () => {
    const { client, calls } = clientWith(() => answer(200, PH01()));
    await client.getPurchaseHistory(HISTORY_REF, grantFor(), { offset: 0, limit: 10 });
    expect(calls[0]!.init.body).toBe('{"customerRef":"prestashop_customer:900000301","purpose":"purchase_history","page":{"limit":10,"offset":0}}');
  });

  it('never sends the grant (D2 does not exist) and drops an invalid correlation id', async () => {
    const { client, calls } = clientWith(() => answer(200, SC01()));
    await client.getSalesContext(REF, grantFor(), { correlationId: 'has space' });
    const sent = JSON.stringify(calls[0]);
    expect(sent).not.toContain('synthetic-grant-not-sent');
    expect(calls[0]!.init.headers['x-correlation-id']).toBeUndefined();
    expect(Object.keys(calls[0]!.init.headers).some((name) => /grant/i.test(name))).toBe(false);
  });
});

describe('refusals before any network call', () => {
  it.each([
    ['a foreign namespace', () => ['crm_master_customer:1', grantFor()] as const, 'validation', 'foreign_customer_ref'],
    ['a bare integer', () => ['900000201', grantFor()] as const, 'validation', 'foreign_customer_ref'],
    ['a grant without the purpose', () => [REF, grantFor(['purchase_history'])] as const, 'validation', 'grant_purpose_not_covered'],
    ['an expired grant', () => [REF, grantFor(undefined, '2026-10-15T12:04:59.000Z')] as const, 'validation', 'grant_expired'],
  ])('%s', async (_name, args, category, code) => {
    const { client, calls } = clientWith(() => answer(200, SC01()));
    const [ref, grant] = args();
    const error = await failureOf(client.getSalesContext(ref, grant));
    expect({ category: error.category, code: error.code }).toEqual({ category, code });
    expect(calls).toHaveLength(0);
  });

  it('an out-of-range page and an already aborted caller', async () => {
    const { client, calls } = clientWith(() => answer(200, PH01()));
    for (const page of [{ offset: 41, limit: 10 }, { offset: 0, limit: 11 }, { offset: 0, limit: 0 }, { offset: 1.5, limit: 1 }]) {
      expect((await failureOf(client.getPurchaseHistory(HISTORY_REF, grantFor(), page))).code).toBe('invalid_page');
    }
    const aborted = new AbortController();
    aborted.abort();
    expect((await failureOf(client.getSalesContext(REF, grantFor(), { signal: aborted.signal }))).category).toBe('timeout');
    expect(calls).toHaveLength(0);
  });
});

describe('HTTP status → DomainError (no retries: exactly one call each)', () => {
  it.each([
    [400, { error: 'invalid_customer_ref' }, 'validation', 'invalid_customer_ref'],
    [401, { error: 'unauthorized' }, 'unauthorized', 'profile_unauthorized'],
    [403, { error: 'forbidden', requiredScope: 'customer.sales_context.read' }, 'unauthorized', 'profile_unauthorized'],
    [404, '<html>Cannot POST</html>', 'contract_violation', 'unexpected_status'],
    [405, { error: 'method_not_allowed' }, 'contract_violation', 'unexpected_status'],
    [413, { error: 'request_too_large' }, 'validation', 'request_too_large'],
    [415, { error: 'unsupported_media_type' }, 'validation', 'unsupported_media_type'],
    [429, { error: 'rate_limited' }, 'temporarily_unavailable', 'rate_limited'],
    [500, { error: 'contract_output_invalid' }, 'temporarily_unavailable', 'contract_output_invalid'],
    [502, 'bad gateway', 'temporarily_unavailable', 'profile_unavailable'],
    [503, 'not json', 'temporarily_unavailable', 'profile_unavailable'],
    [504, { error: 'request_budget_exceeded' }, 'temporarily_unavailable', 'request_budget_exceeded'],
    [201, SC01(), 'contract_violation', 'unexpected_status'],
    [302, '', 'contract_violation', 'unexpected_status'],
  ] as const)('HTTP %i', async (status, body, category, code) => {
    const { client, calls } = clientWith(() => answer(status, body));
    const error = await failureOf(client.getSalesContext(REF, grantFor()));
    expect({ category: error.category, code: error.code }).toEqual({ category, code });
    expect(error.retryable).toBe(category === 'temporarily_unavailable');
    expect(calls).toHaveLength(1);
  });

  it('429 is a temporary unavailability compatible with the v1-rc1 error schema, never retried', async () => {
    const { client, calls, telemetry } = clientWith(() => answer(429, { error: 'rate_limited' }));
    const error = await failureOf(client.getSalesContext(REF, grantFor()));
    expect(error.category).toBe('temporarily_unavailable');
    expect(calls).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({ outcome: 'failed', httpStatus: 429, ownerCode: 'rate_limited' });
  });

  it('an owner error code that does not look like a code is never echoed', async () => {
    const { client, telemetry } = clientWith(() => answer(400, { error: 'Prestashop_customer:900000201 <script>' }));
    const error = await failureOf(client.getSalesContext(REF, grantFor()));
    expect(error.code).toBe('invalid_request');
    expect(JSON.stringify([error.message, error.details, telemetry])).not.toContain('900000201');
  });

  it('a 503 envelope that leaks PII is a contract violation, not an unavailability', async () => {
    const degraded = { ...fixtureById('SC09'), email: null };
    const { client } = clientWith(() => answer(503, degraded));
    expect((await failureOf(client.getSalesContext('prestashop_customer:900000209', grantFor()))).code).toBe('sensitive_field_present');
  });
});

describe('transport, deadline and size', () => {
  it('a network failure is temporarily_unavailable (profile_unreachable)', async () => {
    const { client } = clientWith(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })));
    const error = await failureOf(client.getSalesContext(REF, grantFor()));
    expect({ category: error.category, code: error.code }).toEqual({ category: 'temporarily_unavailable', code: 'profile_unreachable' });
  });

  it('the adapter deadline aborts a silent owner: timeout', async () => {
    const { client } = clientWith(({ init }) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))), { timeoutMs: 40 });
    const error = await failureOf(client.getSalesContext(REF, grantFor()));
    expect({ category: error.category, code: error.code }).toEqual({ category: 'timeout', code: 'deadline_exceeded' });
  });

  it('the deadline also covers a body that never finishes', async () => {
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    const { client } = clientWith(() => ({ status: 200, headers: { get: () => 'application/json' }, body: stalled }), { timeoutMs: 40 });
    expect((await failureOf(client.getSalesContext(REF, grantFor()))).category).toBe('timeout');
  });

  it('the caller signal aborts in flight: timeout', async () => {
    const controller = new AbortController();
    const { client } = clientWith(({ init }) => {
      setTimeout(() => controller.abort(), 5);
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    expect((await failureOf(client.getSalesContext(REF, grantFor(), { signal: controller.signal }))).category).toBe('timeout');
  });

  it('64 KiB of UTF-8 passes; one byte more is response_too_large, cut on the stream', async () => {
    const base = JSON.stringify(SC01());
    const padTo = (bytes: number) => `${base.slice(0, -1)}${' '.repeat(bytes - Buffer.byteLength(base))}}`;
    const ok = clientWith(() => answer(200, padTo(CUSTOMER_PROFILE_MAX_RESPONSE_BYTES)));
    await expect(ok.client.getSalesContext(REF, grantFor())).resolves.toMatchObject({ status: 'available' });
    const over = clientWith(() => answer(200, padTo(CUSTOMER_PROFILE_MAX_RESPONSE_BYTES + 1)));
    expect((await failureOf(over.client.getSalesContext(REF, grantFor()))).code).toBe('response_too_large');
  });

  it('an endless body is cut after the bound without buffering it all', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull: (controller) => void ((pulled += 1), controller.enqueue(new Uint8Array(8192).fill(32))) });
    await expect(readBounded(endless, CUSTOMER_PROFILE_MAX_RESPONSE_BYTES, new AbortController().signal)).rejects.toMatchObject({ code: 'response_too_large' });
    expect(pulled).toBeLessThanOrEqual(10);
  });

  it('a 200 that is not JSON, or not UTF-8, is a contract violation', async () => {
    const html = clientWith(() => answer(200, JSON.stringify(SC01()), { 'content-type': 'text/html' }));
    expect((await failureOf(html.client.getSalesContext(REF, grantFor()))).code).toBe('invalid_response');
    const bytes = clientWith(() => ({ status: 200, headers: { get: () => 'application/json' }, body: streamOf(new Uint8Array([0x7b, 0xff, 0x7d])) }));
    expect((await failureOf(bytes.client.getSalesContext(REF, grantFor()))).code).toBe('invalid_response');
  });
});

describe('tolerant reader: unknown additive fields are dropped, known fields stay strict', () => {
  it('accepts unknown fields at every level and never lets them reach the port', async () => {
    const body = PH01();
    set(body, 'newTopLevel', { anything: [1, 2, 3] });
    set(body, 'provenance.newProvenanceField', 'x');
    set(body, 'freshness.cache.extra', true);
    set(body, 'facts.newFactsField', null);
    set(body, 'facts.purchasedProducts.items.0.futureAttribute', 'additive');
    set(body, 'facts.purchasedProducts.page.cursorHint', 'opaque');
    const tolerant = clientWith(() => answer(200, body));
    const plain = clientWith(() => answer(200, PH01()));
    const withExtras = await tolerant.client.getPurchaseHistory(HISTORY_REF, grantFor(), { offset: 0, limit: 10 });
    expect(withExtras).toEqual(await plain.client.getPurchaseHistory(HISTORY_REF, grantFor(), { offset: 0, limit: 10 }));
    const everything = JSON.stringify([withExtras, tolerant.telemetry]);
    for (const extra of ['newTopLevel', 'newProvenanceField', 'futureAttribute', 'cursorHint', 'additive', 'opaque']) expect(everything).not.toContain(extra);
  });

  it.each([
    ['a missing required field', (b: JsonObject) => set(b, 'provenance.timezoneStatus', undefined)],
    ['a wrong enum', (b: JsonObject) => set(b, 'status', 'archived')],
    ['an unknown lineKind', (b: JsonObject) => set(b, 'facts.purchasedProducts.items.0.lineKind', 'bundle')],
    ['a non-null catalogKey (D6 deferred)', (b: JsonObject) => set(b, 'facts.purchasedProducts.items.0.catalogKey', 'P1-V0')],
    ['a zoned source date', (b: JsonObject) => set(b, 'facts.purchasedProducts.items.0.lastPurchasedSourceDate', '2026-09-28T00:00:00Z')],
    ['a negative gross quantity', (b: JsonObject) => set(b, 'facts.purchasedProducts.items.0.quantityPurchasedGross', -1)],
    ['a wrong type in a known field', (b: JsonObject) => set(b, 'account', 'active')],
    ['eleven items', (b: JsonObject) => set(b, 'facts.purchasedProducts.items', Array<Json>(11).fill(get(b, 'facts.purchasedProducts.items.0')!))],
    ['a blank historical name', (b: JsonObject) => set(b, 'facts.purchasedProducts.items.0.nameAtLastPurchase', '   ')],
  ])('rejects %s (schema on the projection)', async (_name, mutate) => {
    const body = PH01();
    mutate(body);
    const { client } = clientWith(() => answer(200, body));
    const error = await failureOf(client.getPurchaseHistory(HISTORY_REF, grantFor(), { offset: 0, limit: 10 }));
    expect(error.category).toBe('contract_violation');
  });
});

describe('forbidden fields are rejected on the ORIGINAL answer, even with a null value', () => {
  it.each([
    ['spend', (b: JsonObject) => set(b, 'spend', null), 'purpose_minimization_violated'],
    ['facts.derived', (b: JsonObject) => set(b, 'facts.derived', null), 'purpose_minimization_violated'],
    ['items[0].productId', (b: JsonObject) => set(b, 'facts.purchasedProducts.items.0.productId', null), 'purpose_minimization_violated'],
    ['items[0].product_attribute_id (any casing)', (b: JsonObject) => set(b, 'facts.purchasedProducts.items.0.Id_Product_Attribute', 7), 'purpose_minimization_violated'],
    ['items[0].sku', (b: JsonObject) => set(b, 'facts.purchasedProducts.items.0.sku', null), 'purpose_minimization_violated'],
    ['items[0].totalSpent', (b: JsonObject) => set(b, 'facts.purchasedProducts.items.0.totalSpent', 1000), 'purpose_minimization_violated'],
    ['account.state', (b: JsonObject) => set(b, 'account.state', null), 'purpose_minimization_violated'],
    ['customerSince', (b: JsonObject) => set(b, 'account.customerSince', null), 'purpose_minimization_violated'],
    ['provenance.customerId', (b: JsonObject) => set(b, 'provenance.customerId', 1), 'sensitive_field_present'],
    ['email inside an unknown object', (b: JsonObject) => set(b, 'extra', { contact: { email: null } }), 'sensitive_field_present'],
    ['firstname', (b: JsonObject) => set(b, 'firstname', 'Ana'), 'sensitive_field_present'],
    ['rfm', (b: JsonObject) => set(b, 'facts.rfm', null), 'sensitive_field_present'],
    ['clv', (b: JsonObject) => set(b, 'clv', { value: null }), 'sensitive_field_present'],
    ['the other purpose component', (b: JsonObject) => set(b, 'facts.purchaseSummary', null), 'purpose_minimization_violated'],
  ])('%s', async (_name, mutate, code) => {
    const body = PH01();
    mutate(body);
    const { client } = clientWith(() => answer(200, body));
    const error = await failureOf(client.getPurchaseHistory(HISTORY_REF, grantFor(), { offset: 0, limit: 10 }));
    expect({ category: error.category, code: error.code }).toEqual({ category: 'contract_violation', code });
    expect(JSON.stringify(error.details)).not.toMatch(/Ana|1000/);
  });

  it('a sales_context answer with the purchase_history component is rejected', async () => {
    const body = SC01();
    set(body, 'facts.purchasedProducts', null);
    const { client } = clientWith(() => answer(200, body));
    expect((await failureOf(client.getSalesContext(REF, grantFor()))).code).toBe('purpose_minimization_violated');
  });

  it('a legitimate quantity field is not mistaken for an amount (no prefix lists)', async () => {
    const { client } = clientWith(() => answer(200, PH01()));
    const page = await client.getPurchaseHistory(HISTORY_REF, grantFor(), { offset: 0, limit: 10 });
    expect(page.status === 'available' && page.items[1]!.totalQuantity).toBe(4);
  });
});

describe('identity, version and purpose echo', () => {
  it.each([
    ['a different customerRef', (b: JsonObject) => set(b, 'customerRef', 'prestashop_customer:900000999'), 'customer_ref_mismatch'],
    ['a CRM master reference', (b: JsonObject) => set(b, 'customerRef', 'crm_master_customer:1'), 'foreign_customer_ref'],
    ['a bare integer reference', (b: JsonObject) => set(b, 'customerRef', '900000201'), 'foreign_customer_ref'],
    ['schemaVersion 2', (b: JsonObject) => set(b, 'schemaVersion', 2), 'unsupported_schema_version'],
    ['another contract', (b: JsonObject) => set(b, 'contract', 'customer-profile.commercial-profile'), 'unsupported_contract'],
    ['another purpose', (b: JsonObject) => set(b, 'purpose', 'purchase_history'), 'purpose_mismatch'],
  ])('%s', async (_name, mutate, code) => {
    const body = SC01();
    mutate(body);
    const { client } = clientWith(() => answer(200, body));
    expect((await failureOf(client.getSalesContext(REF, grantFor()))).code).toBe(code);
  });
});

describe('lifecycle and authorization basis (AP-05)', () => {
  it('synthetic accepts candidate + service_scope_only and approved', async () => {
    const approved = SC01();
    set(approved, 'provenance.contractStatus', 'approved');
    for (const body of [SC01(), approved]) await expect(clientWith(() => answer(200, body)).client.getSalesContext(REF, grantFor())).resolves.toMatchObject({ status: 'available' });
  });

  it('a verified customer grant that R4 never sent is incoherent', async () => {
    const body = SC01();
    set(body, 'provenance.authorizationBasis', 'customer_grant_verified');
    expect((await failureOf(clientWith(() => answer(200, body)).client.getSalesContext(REF, grantFor()))).code).toBe('authorization_basis_incoherent');
  });

  it('deprecated is refused in every mode', async () => {
    const body = SC01();
    set(body, 'provenance.contractStatus', 'deprecated');
    expect((await failureOf(clientWith(() => answer(200, body)).client.getSalesContext(REF, grantFor()))).code).toBe('contract_not_approved');
  });

  it('a real lifecycle requires approved and a verified grant: today it can never pass', async () => {
    const candidate = clientWith(() => answer(200, SC01()), { lifecycle: 'real' });
    expect((await failureOf(candidate.client.getSalesContext(REF, grantFor()))).code).toBe('contract_not_approved');
    const approved = SC01();
    set(approved, 'provenance.contractStatus', 'approved');
    const scopeOnly = clientWith(() => answer(200, approved), { lifecycle: 'real' });
    expect((await failureOf(scopeOnly.client.getSalesContext(REF, grantFor()))).code).toBe('authorization_basis_insufficient');
  });
});

describe('freshness and page coherence', () => {
  it.each([
    ['facts expired on arrival', (b: JsonObject) => set(set(b, 'freshness.asOf', '2026-10-15T11:40:00.000Z'), 'freshness.validUntil', '2026-10-15T11:55:00.000Z'), 'freshness_expired'],
    ['a ttl above 15 minutes', (b: JsonObject) => set(b, 'freshness.validUntil', '2026-10-15T12:15:00.001Z'), 'freshness_incoherent'],
    ['validUntil before asOf', (b: JsonObject) => set(b, 'freshness.validUntil', '2026-10-15T11:59:00.000Z'), 'freshness_incoherent'],
    ['an answer dated in the future', (b: JsonObject) => set(set(b, 'freshness.asOf', '2026-10-15T12:11:00.000Z'), 'freshness.validUntil', '2026-10-15T12:20:00.000Z'), 'freshness_incoherent'],
    ['a policy version mismatch (SR-01)', (b: JsonObject) => set(b, 'facts.policy.policyVersion', 'cp-sales-facts-v2'), 'invalid_response'],
    ['a partial answer without partial_context (SR-09)', (b: JsonObject) => set(set(b, 'facts.purchaseSummary', { status: 'unavailable', reason: 'dependency_timeout', hasValidOrders: null }), 'completeness', 'partial'), 'invalid_response'],
    ['a degraded status on HTTP 200', (b: JsonObject) => Object.assign(b, clone(fixtureById('SC09')), { customerRef: REF }), 'invalid_response'],
  ])('%s', async (_name, mutate, code) => {
    const body = SC01();
    mutate(body);
    expect((await failureOf(clientWith(() => answer(200, body)).client.getSalesContext(REF, grantFor()))).code).toBe(code);
  });

  it.each([
    ['another page than requested', (b: JsonObject) => set(b, 'facts.purchasedProducts.page.limit', 9), 'page_incoherent'],
    ['returned ≠ items', (b: JsonObject) => set(b, 'facts.purchasedProducts.page.returned', 2), 'page_incoherent'],
    ['a short page that claims more', (b: JsonObject) => set(b, 'facts.purchasedProducts.page.hasMore', true), 'page_incoherent'],
    ['growing dates', (b: JsonObject) => set(b, 'facts.purchasedProducts.items', [...(get(b, 'facts.purchasedProducts.items') as Json[])].reverse()), 'order_violation'],
  ])('%s', async (_name, mutate, code) => {
    const body = PH01();
    mutate(body);
    expect((await failureOf(clientWith(() => answer(200, body)).client.getPurchaseHistory(HISTORY_REF, grantFor(), { offset: 0, limit: 10 }))).code).toBe(code);
  });

  it('a history with unavailable items is a failure, never a partial list (history_unavailable)', async () => {
    const error = await failureOf(clientWith(() => answer(200, fixtureById('PH09'))).client.getPurchaseHistory('prestashop_customer:900000309', grantFor(), { offset: 0, limit: 10 }));
    expect({ category: error.category, code: error.code, ownerReason: error.details.ownerReason }).toEqual({ category: 'temporarily_unavailable', code: 'history_unavailable', ownerReason: 'dependency_unavailable' });
  });
});

describe('telemetry and logs carry no identifier, token, grant or fact', () => {
  it('across successes and failures', async () => {
    const lines: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args));
    const events: unknown[] = [];
    for (const [status, body] of [[200, PH01()], [403, { error: 'forbidden', requiredScope: 'customer.sales_context.read' }], [503, fixtureById('PH13')], [200, { ...PH01(), email: 'ana@example.com' }]] as const) {
      const { client, telemetry } = clientWith(() => answer(status, body));
      await client.getPurchaseHistory(HISTORY_REF, grantFor(), { offset: 0, limit: 10 }).catch(() => undefined);
      events.push(...telemetry);
    }
    const everything = JSON.stringify([events, lines]);
    expect(events.length).toBe(4);
    for (const secret of ['900000301', 'prestashop_customer', TOKEN, 'synthetic-grant-not-sent', 'Rack sintetico', 'ana@example.com']) expect(everything, secret).not.toContain(secret);
    expect(events[0]).toMatchObject({ purpose: 'purchase_history', outcome: 'ok', httpStatus: 200, cacheControlNoStore: true, diagnostics: { contractStatus: 'candidate', authorizationBasis: 'service_scope_only', timezoneStatus: 'unverified' } });
    vi.restoreAllMocks();
  });
});

describe('client construction is the only place the token lives', () => {
  it('the config object is not exposed by the client', () => {
    const client = new CustomerProfileHttpClient({ config: CONFIG, fetch: vi.fn(), now: () => NOW });
    expect(JSON.stringify(client)).not.toContain(TOKEN);
    expect(Object.keys(client)).toEqual(['bindingKind']);
  });
});
