import { describe, expect, it } from 'vitest';
import { DomainError } from '@r4-adapters/domains';
import { CheckoutConfigError, CheckoutHttpClient, loadCheckoutHttpConfig, type CheckoutCallTelemetry, type CheckoutFetch } from '@r4-adapters/checkout-http';

/** Contract R-1 / §11: the Checkout client against a stub transport (no real Checkout). */
const TOKEN = 't'.repeat(40);
const ENV = { R4_CHECKOUT_MODE: 'sandbox', R4_CHECKOUT_BASE_URL: 'http://127.0.0.1:4031', R4_CHECKOUT_BEARER_TOKEN: TOKEN, R4_CHECKOUT_TIMEOUT_MS: '5000' };
const SESSION = { contractVersion: '1.0.3-proposed', sessionId: 'cks_1', status: 'CREATED', statusReason: null, quote: { quoteId: '302641d9-2d39-4b73-b828-c1e3270e7325', quoteVersion: 2, expiresAt: '2026-11-06T20:00:00Z' }, purchaseAuthorizationId: 'pza_1', amount: { amountMinor: '2500', currency: 'CLP' }, orderSyncStatus: null, anomaly: null, createdAt: '2026-11-06T19:25:18Z', updatedAt: '2026-11-06T19:25:18Z' };
const ATTEMPT = { contractVersion: '1.0.3-proposed', paymentAttemptId: 'cpa_1', sessionId: 'cks_1', ordinal: 1, status: 'LINK_AVAILABLE', amount: { amountMinor: '2500', currency: 'CLP' }, quoteVersion: 2, expiresAt: '2026-11-06T19:41:32Z', linkExpired: false, checkoutUrl: 'https://www.mercadopago.cl/checkout/v1/redirect?pref_id=1', lateCapture: false, createdAt: '2026-11-06T19:26:32Z', updatedAt: '2026-11-06T19:26:33Z', resolutionReason: null };

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
function stub(answer: (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> } | Error) {
  const calls: Call[] = [];
  const fetch: CheckoutFetch = (url, init) => {
    const call = { url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) };
    calls.push(call);
    const a = answer(call);
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve({ status: a.status, headers: { get: (n: string) => a.headers?.[n.toLowerCase()] ?? null }, text: () => Promise.resolve(a.body === undefined ? '' : JSON.stringify(a.body)) });
  };
  return { fetch, calls };
}
const client = (fetch: CheckoutFetch, onCall?: (e: CheckoutCallTelemetry) => void) => new CheckoutHttpClient({ config: loadCheckoutHttpConfig(ENV, { allowNetwork: false }), fetch, ...(onCall ? { onCall } : {}) });
const KEY = 'r4.ck.session.0123456789abcdef0123456789abcdef01234567';
const error = (status: number, code: string, retryable = false) => ({ status, body: { contractVersion: '1.0.3-proposed', requestId: 'r', error: { code, message: 'm', retryable } } });

describe('configuration', () => {
  it('loads only the sandbox mode, an origin, a plausible token and a bounded timeout', () => {
    expect(loadCheckoutHttpConfig(ENV, { allowNetwork: false })).toEqual({ baseUrl: 'http://127.0.0.1:4031', bearerToken: TOKEN, timeoutMs: 5000 });
    expect(() => loadCheckoutHttpConfig({ ...ENV, R4_CHECKOUT_MODE: 'live' }, { allowNetwork: false })).toThrow(CheckoutConfigError);
    expect(() => loadCheckoutHttpConfig({ ...ENV, R4_CHECKOUT_MODE: '' }, { allowNetwork: false })).toThrow(/not "sandbox"/);
    expect(() => loadCheckoutHttpConfig({ ...ENV, R4_CHECKOUT_BASE_URL: 'http://127.0.0.1:4031/v1' }, { allowNetwork: false })).toThrow(/origin/);
    expect(() => loadCheckoutHttpConfig({ ...ENV, R4_CHECKOUT_BASE_URL: 'https://checkout.example.cl' }, { allowNetwork: false })).toThrow(/R4_PROD_ALLOW_NETWORK/);
    expect(() => loadCheckoutHttpConfig({ ...ENV, R4_CHECKOUT_BASE_URL: 'http://checkout.example.cl' }, { allowNetwork: true })).toThrow(/https/);
    expect(() => loadCheckoutHttpConfig({ ...ENV, R4_CHECKOUT_BEARER_TOKEN: 'short' }, { allowNetwork: false })).toThrow(/token/);
    expect(() => loadCheckoutHttpConfig({ ...ENV, R4_CHECKOUT_TIMEOUT_MS: '60000' }, { allowNetwork: false })).toThrow(/TIMEOUT/);
  });
});

describe('the six routes', () => {
  it('create session: exact body allowlist, auth, key and correlation headers; replay flag', async () => {
    const t = stub(() => ({ status: 201, body: SESSION, headers: { 'idempotent-replay': 'true' } }));
    const r = await client(t.fetch).createSession({ quoteId: SESSION.quote.quoteId, quoteVersion: 2, consent: { format: 'checkout-sbx-test-consent.v1', token: 'x'.repeat(40) } }, KEY, { correlationId: 'task-1' });
    expect(r).toMatchObject({ httpStatus: 201, replayed: true, view: { sessionId: 'cks_1', status: 'CREATED' } });
    expect(t.calls[0]).toMatchObject({ url: 'http://127.0.0.1:4031/v1/checkout/sessions', method: 'POST' });
    expect(t.calls[0]!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'idempotency-key': KEY, 'x-correlation-id': 'task-1', 'content-type': 'application/json' });
    expect(JSON.parse(t.calls[0]!.body!)).toEqual({ quoteId: SESSION.quote.quoteId, quoteVersion: 2, consent: { format: 'checkout-sbx-test-consent.v1', token: 'x'.repeat(40) } });
  });

  it('prepare and payment attempt are 202 commands without a body; reads are GETs without query strings', async () => {
    const t = stub((c) => (c.method === 'POST' ? { status: 202, body: c.url.endsWith('/prepare') ? { ...SESSION, status: 'PREPARING' } : { ...ATTEMPT, status: 'CREATED', checkoutUrl: undefined } } : c.url.endsWith('/payment-attempts') ? { status: 200, body: [ATTEMPT] } : c.url.endsWith('/orders') ? { status: 200, body: { contractVersion: 'v', sessionId: 'cks_1', orderSyncStatus: 'SYNCED', orders: [{ psOrderId: 106, reference: 'DICHJYQED', totalPaid: { amountMinor: '2500', currency: 'CLP' } }] } } : { status: 200, body: SESSION }));
    const c = client(t.fetch);
    expect((await c.prepareSession('cks_1', KEY)).view.status).toBe('PREPARING');
    const created = await c.createPaymentAttempt('cks_1', KEY);
    expect(created.view).toMatchObject({ status: 'CREATED', checkoutUrl: null });
    const list = await c.listPaymentAttempts('cks_1');
    expect(list).toHaveLength(1);
    expect(list[0]!.checkoutUrl).toBe(ATTEMPT.checkoutUrl);
    expect((await c.getOrders('cks_1')).orders[0]!.reference).toBe('DICHJYQED');
    expect((await c.getSession('cks_1')).sessionId).toBe('cks_1');
    expect(t.calls.map((x) => `${x.method} ${x.url.replace('http://127.0.0.1:4031', '')}`)).toEqual([
      'POST /v1/checkout/sessions/cks_1/prepare',
      'POST /v1/checkout/sessions/cks_1/payment-attempts',
      'GET /v1/checkout/sessions/cks_1/payment-attempts',
      'GET /v1/checkout/sessions/cks_1/orders',
      'GET /v1/checkout/sessions/cks_1',
    ]);
    expect(t.calls.filter((x) => x.method === 'POST').every((x) => x.body === undefined && x.headers['idempotency-key'] === KEY)).toBe(true);
    expect(t.calls.filter((x) => x.method === 'GET').every((x) => x.headers['idempotency-key'] === undefined && !x.url.includes('?'))).toBe(true);
  });

  it('refuses ids and keys outside the contract grammar before any call', async () => {
    const t = stub(() => ({ status: 200, body: SESSION }));
    await expect(client(t.fetch).getSession('../x')).rejects.toMatchObject({ category: 'validation' });
    await expect(client(t.fetch).prepareSession('cks_1', 'short')).rejects.toMatchObject({ category: 'validation' });
    expect(t.calls).toHaveLength(0);
  });
});

describe('error classification (§7, §11.2)', () => {
  const cases: [string, ReturnType<typeof error> | Error, 'command' | 'read', string, string][] = [
    ['400', error(400, 'VALIDATION_ERROR'), 'command', 'validation', 'VALIDATION_ERROR'],
    ['401', error(401, 'UNAUTHENTICATED'), 'command', 'unauthorized', 'UNAUTHENTICATED'],
    ['403 buyer', error(403, 'BUYER_NOT_AUTHORIZED'), 'command', 'unauthorized', 'BUYER_NOT_AUTHORIZED'],
    ['404', error(404, 'NOT_FOUND'), 'read', 'not_found', 'NOT_FOUND'],
    ['409 key reused', error(409, 'IDEMPOTENCY_KEY_REUSED'), 'command', 'conflict', 'IDEMPOTENCY_KEY_REUSED'],
    ['409 unresolved', error(409, 'ATTEMPT_UNRESOLVED'), 'command', 'conflict', 'ATTEMPT_UNRESOLVED'],
    ['422 expired quote', error(422, 'QUOTE_EXPIRED'), 'command', 'conflict', 'QUOTE_EXPIRED'],
    ['409 in progress, command', error(409, 'REQUEST_IN_PROGRESS', true), 'command', 'unknown_outcome', 'REQUEST_IN_PROGRESS'],
    ['409 in progress, read', error(409, 'REQUEST_IN_PROGRESS', true), 'read', 'temporarily_unavailable', 'REQUEST_IN_PROGRESS'],
    ['503 gate (not retryable)', error(503, 'OPERATIONAL_GATE_BLOCKED'), 'command', 'conflict', 'OPERATIONAL_GATE_BLOCKED'],
    ['503 provider, command', error(503, 'PAYMENT_PROVIDER_UNAVAILABLE', true), 'command', 'unknown_outcome', 'PAYMENT_PROVIDER_UNAVAILABLE'],
    ['500 unreadable, read', { status: 500 } as never, 'read', 'temporarily_unavailable', 'http_500'],
    ['connection refused', Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }), 'command', 'temporarily_unavailable', 'checkout_unavailable'],
    ['connection reset after send', Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }), 'command', 'unknown_outcome', 'checkout_connection_lost'],
    ['unexpected 302', { status: 302 } as never, 'command', 'contract_violation', 'checkout_invalid_response'],
  ];
  it.each(cases)('%s', async (_name, answer, kind, category, code) => {
    const t = stub(() => answer);
    const c = client(t.fetch);
    const call = kind === 'command' ? c.prepareSession('cks_1', KEY) : c.getSession('cks_1');
    const failure = await call.then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure).toMatchObject({ category, code });
  });

  it('a deadline is a timeout (the command may have been applied: replay the same key)', async () => {
    const fetch: CheckoutFetch = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const c = new CheckoutHttpClient({ config: { ...loadCheckoutHttpConfig(ENV, { allowNetwork: false }), timeoutMs: 20 }, fetch });
    await expect(c.createPaymentAttempt('cks_1', KEY)).rejects.toMatchObject({ category: 'timeout', outcomeUnknown: true });
  });

  it('a schema violation is never repaired; telemetry never carries the token, key or URL', async () => {
    const events: CheckoutCallTelemetry[] = [];
    const t = stub(() => ({ status: 200, body: [{ ...ATTEMPT, ordinal: 0 }] }));
    await expect(client(t.fetch, (e) => events.push(e)).listPaymentAttempts('cks_1')).rejects.toMatchObject({ category: 'contract_violation' });
    const ok = stub(() => ({ status: 200, body: [ATTEMPT] }));
    await client(ok.fetch, (e) => events.push(e)).listPaymentAttempts('cks_1');
    const text = JSON.stringify(events);
    for (const secret of [TOKEN, KEY, 'mercadopago']) expect(text).not.toContain(secret);
  });
});
