import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DomainError } from '@r4-adapters/domains';
import {
  CustomerIdentityConfigError,
  CustomerIdentityHttpClient,
  describeCustomerIdentityHttpConfig,
  loadCustomerIdentityHttpConfig,
  type CustomerIdentityCallTelemetry,
  type CustomerIdentityFetch,
} from '@r4-adapters/identity-http';

// R4-J4-R3: the CIA adapter's configuration and transport. Synthetic data only, no network.

const CONTRACT = join(import.meta.dirname, '..', '..', '..', 'adapters', 'domains', 'identity', 'http', 'contract');
const VERIFIED = JSON.parse(readFileSync(join(CONTRACT, 'fixtures', 'resolve', 'response.verified.json'), 'utf8')) as Record<string, unknown> & {
  grant: { token: string; expiresAt: string; purposes: string[] };
};
const NOW = new Date('2026-10-19T18:00:30.000Z');
const TOKEN = 'synthetic-r4-sales-agent-token-0001';
const SUBJECT = { channel: 'whatsapp', accountRef: '100000000000001', subjectRef: '15555550101', sessionRef: 'bnd_synthetic_0001' };
const ENV = { R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BASE_URL: 'http://127.0.0.1:8787', R4_CUSTOMER_IDENTITY_BEARER_TOKEN: TOKEN, R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '1500' };

type Init = Parameters<CustomerIdentityFetch>[1];
const recorded: { url: string; init: Init }[] = [];
const respond = (status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): CustomerIdentityFetch => (url, init) => {
  recorded.push({ url, init });
  return Promise.resolve({ status, headers: new Headers(headers), body: new Response(typeof body === 'string' ? body : JSON.stringify(body)).body });
};
function client(fetch: CustomerIdentityFetch, events: CustomerIdentityCallTelemetry[] = [], timeoutMs = 1_500) {
  recorded.length = 0;
  return new CustomerIdentityHttpClient({ config: { baseUrl: 'http://127.0.0.1:8787', bearerToken: TOKEN, timeoutMs, lifecycle: 'synthetic' }, fetch, onCall: (e) => events.push(e), now: () => NOW });
}
const verified = (patch: (body: typeof VERIFIED) => void = () => undefined) => {
  const body = structuredClone(VERIFIED);
  patch(body);
  return body;
};
async function fails(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('configuration (fail-closed, synthetic, loopback only)', () => {
  it('loads a complete synthetic configuration and describes it without the secret', () => {
    const config = loadCustomerIdentityHttpConfig(ENV);
    expect(config).toEqual({ baseUrl: 'http://127.0.0.1:8787', bearerToken: TOKEN, timeoutMs: 1500, lifecycle: 'synthetic' });
    expect(JSON.stringify(describeCustomerIdentityHttpConfig(config))).not.toContain(TOKEN);
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    ['unset mode', { ...ENV, R4_CUSTOMER_MODE: undefined }, 'customer_identity_config_incomplete'],
    ['real mode', { ...ENV, R4_CUSTOMER_MODE: 'real' }, 'customer_real_data_blocked'],
    ['unknown mode', { ...ENV, R4_CUSTOMER_MODE: 'live' }, 'invalid_customer_identity_config'],
    ['missing token', { ...ENV, R4_CUSTOMER_IDENTITY_BEARER_TOKEN: '' }, 'customer_identity_config_incomplete'],
    ['non-synthetic token', { ...ENV, R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'prod-r4-sales-agent-token-000000001' }, 'invalid_customer_identity_config'],
    ['short token', { ...ENV, R4_CUSTOMER_IDENTITY_BEARER_TOKEN: 'synthetic-x' }, 'invalid_customer_identity_config'],
    ['non-loopback host', { ...ENV, R4_CUSTOMER_IDENTITY_BASE_URL: 'https://cia.pesaschile.cl' }, 'network_not_allowed'],
    ['credentials in the URL', { ...ENV, R4_CUSTOMER_IDENTITY_BASE_URL: 'http://user:pw@127.0.0.1:8787' }, 'invalid_customer_identity_config'],
    ['a path', { ...ENV, R4_CUSTOMER_IDENTITY_BASE_URL: 'http://127.0.0.1:8787/v1' }, 'invalid_customer_identity_config'],
    ['a query', { ...ENV, R4_CUSTOMER_IDENTITY_BASE_URL: 'http://127.0.0.1:8787/?x=1' }, 'invalid_customer_identity_config'],
    ['another scheme', { ...ENV, R4_CUSTOMER_IDENTITY_BASE_URL: 'ftp://127.0.0.1:8787' }, 'invalid_customer_identity_config'],
    ['timeout 99', { ...ENV, R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '99' }, 'invalid_customer_identity_config'],
    ['timeout 3001', { ...ENV, R4_CUSTOMER_IDENTITY_TIMEOUT_MS: '3001' }, 'invalid_customer_identity_config'],
  ])('refuses %s', (_name, env, code) => {
    expect(() => loadCustomerIdentityHttpConfig(env)).toThrow(expect.objectContaining({ code }) as Error);
    expect(() => loadCustomerIdentityHttpConfig(env)).toThrow(CustomerIdentityConfigError);
  });
});

describe('request', () => {
  it('POSTs the subject in the body only, with the agent bearer, correlation id, no grant header and no redirect following', async () => {
    await client(respond(200, verified())).resolve(SUBJECT, ['purchase_history'], { correlationId: 'corr-r3-1' });
    const { url, init } = recorded[0]!;
    expect(url).toBe('http://127.0.0.1:8787/v1/identity/resolve');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(init.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-correlation-id': 'corr-r3-1' });
    expect(JSON.parse(init.body)).toEqual({
      schemaVersion: 1,
      context: { channel: 'whatsapp', channelAccountRef: '100000000000001', subjectRef: '15555550101', sessionRef: 'bnd_synthetic_0001', subjectAssurance: 'provider_signed' },
      purposes: ['purchase_history'],
    });
    expect(url).not.toContain('15555550101');
  });

  it.each<[string, Parameters<CustomerIdentityHttpClient['resolve']>]>([
    ['no purpose', [SUBJECT, []]],
    ['a duplicated purpose', [SUBJECT, ['sales_context', 'sales_context']]],
    ['an unknown purpose', [SUBJECT, ['marketing' as never]]],
    ['a free-text subject', [{ ...SUBJECT, subjectRef: 'hola soy juan' }, ['sales_context']]],
    ['an empty session', [{ ...SUBJECT, sessionRef: '' }, ['sales_context']]],
    ['a malformed channel', [{ ...SUBJECT, channel: 'WhatsApp!' }, ['sales_context']]],
  ])('refuses %s before any network call', async (_name, args) => {
    const c = client(respond(200, verified()));
    expect(await fails(c.resolve(...args))).toMatchObject({ category: 'validation' });
    expect(recorded).toHaveLength(0);
  });

  it('an already aborted caller is a timeout and nothing is sent', async () => {
    const c = client(respond(200, verified()));
    expect(await fails(c.resolve(SUBJECT, ['purchase_history'], { signal: AbortSignal.abort() }))).toMatchObject({ category: 'timeout', code: 'deadline_exceeded' });
    expect(recorded).toHaveLength(0);
  });
});

describe('answers', () => {
  it.each<[string, (body: typeof VERIFIED) => void, string]>([
    ['another namespace', (b) => void (b.customerRef = 'synthetic_customer:900000201'), 'foreign_customer_ref'],
    ['a customer outside the synthetic range', (b) => void (b.customerRef = 'prestashop_customer:12345'), 'customer_ref_outside_synthetic_range'],
    ['a grant for another purpose', (b) => void (b.grant.purposes = ['sales_context']), 'incoherent_grant'],
    ['a grant for more purposes than asked', (b) => void (b.grant.purposes = ['purchase_history', 'sales_context']), 'incoherent_grant'],
    ['an expired grant', (b) => void (b.grant.expiresAt = '2026-10-19T18:00:30Z'), 'incoherent_grant'],
    ['a grant outliving the contract TTL', (b) => void (b.grant.expiresAt = '2026-10-19T18:06:31Z'), 'incoherent_grant'],
    ['a grant above 2048 characters', (b) => void (b.grant.token = `${b.grant.token}${'A'.repeat(2049)}`), 'invalid_response'],
    ['a grant that is not three segments', (b) => void (b.grant.token = 'not-a-jws'), 'invalid_response'],
    ['an additional field (masterCustomerId)', (b) => void ((b as Record<string, unknown>).masterCustomerId = 'crm_master_customer:1'), 'invalid_response'],
    ['an e-mail', (b) => void ((b as Record<string, unknown>).email = 'valid@synthetic.test'), 'invalid_response'],
    ['another schema version', (b) => void (b.schemaVersion = 2), 'invalid_response'],
    ['a resolvedAt in the future', (b) => void (b.resolvedAt = '2026-10-19T18:10:00Z'), 'freshness_incoherent'],
  ])('%s is a contract_violation (%s): no identity, no grant', async (_name, patch, code) => {
    expect(await fails(client(respond(200, verified(patch))).resolve(SUBJECT, ['purchase_history']))).toMatchObject({ category: 'contract_violation', code });
  });

  it('a non-JSON content type, a non-JSON body or a non-UTF-8 body is a contract_violation', async () => {
    expect(await fails(client(respond(200, verified(), { 'content-type': 'text/plain' })).resolve(SUBJECT, ['purchase_history']))).toMatchObject({ code: 'invalid_response' });
    expect(await fails(client(respond(200, '{not json')).resolve(SUBJECT, ['purchase_history']))).toMatchObject({ code: 'invalid_response' });
    const latin1: CustomerIdentityFetch = () => Promise.resolve({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: new Response(new Uint8Array([0x7b, 0xff, 0x7d])).body });
    expect(await fails(client(latin1).resolve(SUBJECT, ['purchase_history']))).toMatchObject({ code: 'invalid_response' });
  });

  it('an answer above 16 KiB is cut on the stream (response_too_large)', async () => {
    expect(await fails(client(respond(200, ' '.repeat(16 * 1024 + 1))).resolve(SUBJECT, ['purchase_history']))).toMatchObject({ category: 'contract_violation', code: 'response_too_large' });
  });

  it.each<[number, string, string]>([
    [302, 'contract_violation', 'unexpected_status'],
    [307, 'contract_violation', 'unexpected_status'],
    [404, 'contract_violation', 'unexpected_status'],
    [409, 'contract_violation', 'unexpected_status'],
    [500, 'temporarily_unavailable', 'identity_unavailable'],
    [502, 'temporarily_unavailable', 'identity_unavailable'],
  ])('HTTP %s → %s (%s), never a resolution', async (status, category, code) => {
    expect(await fails(client(respond(status, '', { location: 'https://evil.example/' })).resolve(SUBJECT, ['purchase_history']))).toMatchObject({ category, code });
  });

  it('a network failure is temporarily_unavailable; a stalled body ends at the deadline as a timeout', async () => {
    const down: CustomerIdentityFetch = () => Promise.reject(new TypeError('fetch failed'));
    expect(await fails(client(down).resolve(SUBJECT, ['purchase_history']))).toMatchObject({ category: 'temporarily_unavailable', code: 'identity_unreachable' });
    const stalled: CustomerIdentityFetch = () => Promise.resolve({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"sche')) }) });
    expect(await fails(client(stalled, [], 100).resolve(SUBJECT, ['purchase_history']))).toMatchObject({ category: 'timeout', code: 'deadline_exceeded' });
  });

  it('the caller aborting while the body streams is a timeout', async () => {
    const controller = new AbortController();
    const stalled: CustomerIdentityFetch = () => {
      setTimeout(() => controller.abort(), 20);
      return Promise.resolve({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{')) }) });
    };
    expect(await fails(client(stalled).resolve(SUBJECT, ['purchase_history'], { signal: controller.signal }))).toMatchObject({ category: 'timeout' });
  });
});

describe('telemetry', () => {
  it('records operation, purposes, resolution status, HTTP status and codes; never the token, subject, customerRef or grant', async () => {
    const events: CustomerIdentityCallTelemetry[] = [];
    await client(respond(200, verified()), events).resolve(SUBJECT, ['purchase_history'], { correlationId: 'corr-r3-2' });
    await fails(client(respond(200, verified((b) => void (b.grant.purposes = ['sales_context']))), events).resolve(SUBJECT, ['purchase_history']));
    expect(events.map((e) => [e.outcome, e.resolutionStatus, e.httpStatus, e.errorCode])).toEqual([
      ['ok', 'verified', 200, null],
      ['failed', null, 200, 'incoherent_grant'],
    ]);
    const all = JSON.stringify(events);
    for (const secret of [TOKEN, VERIFIED.grant.token, ...VERIFIED.grant.token.split('.'), 'prestashop_customer', '15555550101', '100000000000001', 'bnd_synthetic_0001']) expect(all).not.toContain(secret);
  });

  it('a throwing telemetry sink never changes the outcome', async () => {
    const c = new CustomerIdentityHttpClient({ config: loadCustomerIdentityHttpConfig(ENV), fetch: respond(200, verified()), onCall: () => { throw new Error('sink down'); }, now: () => NOW });
    expect((await c.resolve(SUBJECT, ['purchase_history'])).status).toBe('verified');
  });
});
