import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CIA_CONFIRM_ROUTE,
  CiaVerificationConfirmClient,
  CustomerIdentityConfigError,
  loadCiaVerificationConfirmConfig,
  type CiaConfirmCallTelemetry,
  type CiaConfirmRequest,
  type CustomerIdentityFetch,
} from '@r4-adapters/identity-http';

// SEC-S4: the CIA confirm client (contract v1-d2 §5.2, pinned at 7525395) — configuration, the request
// it sends, and the classification the dispatcher relies on (plan §4.5). Synthetic data, no network.

const CONTRACT = join(import.meta.dirname, '..', '..', '..', 'adapters', 'domains', 'identity', 'http', 'contract');
const fixture = (name: string) => JSON.parse(readFileSync(join(CONTRACT, 'fixtures', 'verification-confirm', name), 'utf8')) as Record<string, unknown>;
const TOKEN = 'synthetic-r4-sales-channel-token-0001';
const CODE = '482913';
const ENV = { R4_CUSTOMER_MODE: 'synthetic', R4_CUSTOMER_IDENTITY_BASE_URL: 'http://127.0.0.1:8787', R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: TOKEN };
const REQUEST: CiaConfirmRequest = {
  context: { channel: 'whatsapp', channelAccountRef: '100000000000001', subjectRef: '15555550101', sessionRef: '0190b0b0-0000-7000-8000-000000000001' },
  verificationId: 'Vf0SyntheticChallenge1',
  code: CODE,
  idempotencyKey: `vr.${'a'.repeat(64)}`,
  correlationId: 'verification-0190b0b0-0000-7000-8000-0000000000aa',
};

type Init = Parameters<CustomerIdentityFetch>[1];
const recorded: { url: string; init: Init }[] = [];
const respond = (status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): CustomerIdentityFetch => (url, init) => {
  recorded.push({ url, init });
  return Promise.resolve({ status, headers: new Headers(headers), body: new Response(typeof body === 'string' ? body : JSON.stringify(body)).body });
};
function client(fetch: CustomerIdentityFetch, events: CiaConfirmCallTelemetry[] = []) {
  recorded.length = 0;
  return new CiaVerificationConfirmClient({ config: { baseUrl: 'http://127.0.0.1:8787', bearerToken: TOKEN, timeoutMs: 3_000, lifecycle: 'synthetic' }, fetch, onCall: (e) => events.push(e) });
}
const error = (code: string, retryable = false) => ({ error: { code, retryable } });

describe('configuration: the channel-integration credential, synthetic and loopback only', () => {
  it('loads with a fixed 3 s deadline', () => {
    expect(loadCiaVerificationConfirmConfig(ENV)).toEqual({ baseUrl: 'http://127.0.0.1:8787', bearerToken: TOKEN, timeoutMs: 3_000, lifecycle: 'synthetic' });
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    ['real mode (CUSTOMER_REAL_DATA_ACCESS_BLOCKED)', { ...ENV, R4_CUSTOMER_MODE: 'real' }, 'customer_real_data_blocked'],
    ['unset mode', { ...ENV, R4_CUSTOMER_MODE: undefined }, 'customer_identity_config_incomplete'],
    ['missing credential', { ...ENV, R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: '' }, 'customer_identity_config_incomplete'],
    ['non-synthetic credential', { ...ENV, R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN: 'prod-channel-token-000000000000001' }, 'invalid_customer_identity_config'],
    ['non-loopback CIA', { ...ENV, R4_CUSTOMER_IDENTITY_BASE_URL: 'https://cia.pesaschile.cl' }, 'network_not_allowed'],
  ])('refuses %s', (_name, env, code) => {
    expect(() => loadCiaVerificationConfirmConfig(env)).toThrow(CustomerIdentityConfigError);
    expect(() => loadCiaVerificationConfirmConfig(env)).toThrow(expect.objectContaining({ code }) as Error);
  });
});

describe('the request', () => {
  it('posts the pinned body with the channel credential, the idempotency key and no redirect following', async () => {
    await client(respond(200, fixture('response.linked.json'))).confirm(REQUEST);
    const [{ url, init }] = recorded as [{ url: string; init: Init }];
    expect(url).toBe(`http://127.0.0.1:8787${CIA_CONFIRM_ROUTE}`);
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'idempotency-key': REQUEST.idempotencyKey, 'x-correlation-id': REQUEST.correlationId });
    expect(JSON.parse(init.body)).toEqual({ schemaVersion: 1, context: { ...REQUEST.context, subjectAssurance: 'provider_signed' }, verificationId: REQUEST.verificationId, code: CODE });
  });

  it('the same request yields the same body byte for byte (the CIA fingerprint of a retry)', async () => {
    const c = client(respond(503, error('dependency_unavailable', true)));
    await c.confirm(REQUEST);
    const first = recorded[0]!.init.body;
    await c.confirm(REQUEST);
    expect(recorded[0]!.init.body).toBe(first);
  });

  it('refuses a request outside the pinned schema before the network (e.g. a non-normalized code)', async () => {
    expect(await client(respond(200, fixture('response.linked.json'))).confirm({ ...REQUEST, code: '482 913' })).toEqual({ kind: 'refused', code: 'invalid_request', credentialRejected: false });
    expect(recorded).toHaveLength(0);
  });
});

describe('classification (plan §4.5)', () => {
  it.each([
    ['response.linked.json', { kind: 'outcome', outcome: 'linked' }],
    ['response.no-eligible-account.json', { kind: 'outcome', outcome: 'no_eligible_account' }],
    ['response.ineligible-account.json', { kind: 'outcome', outcome: 'ineligible_account' }],
    ['response.ambiguous.json', { kind: 'outcome', outcome: 'ambiguous' }],
    ['response.conflicted.json', { kind: 'outcome', outcome: 'conflicted' }],
    ['response.invalid-code.json', { kind: 'outcome', outcome: 'invalid_code', attemptsRemaining: 4 }],
    ['response.expired.json', { kind: 'outcome', outcome: 'expired' }],
    ['response.locked.json', { kind: 'outcome', outcome: 'locked' }],
  ])('200 %s', async (file, expected) => {
    expect(await client(respond(200, fixture(file))).confirm(REQUEST)).toEqual(expected);
  });

  it.each([
    ['response.invalid.linked-with-customer-ref.json'],
    ['response.invalid.invalid-code-without-attempts.json'],
  ])('an off-contract 200 (%s) is refused, never repaired', async (file) => {
    expect(await client(respond(200, fixture(file))).confirm(REQUEST)).toEqual({ kind: 'refused', code: 'invalid_response', credentialRejected: false });
  });

  it('retryable answers keep the same key: 409 in progress (Retry-After capped at 30 s), 429, 503, network, deadline', async () => {
    expect(await client(respond(409, error('operation_in_progress', true), { 'content-type': 'application/json', 'retry-after': '2' })).confirm(REQUEST)).toEqual({ kind: 'retry', code: 'operation_in_progress', retryAfterMs: 2_000 });
    expect(await client(respond(409, error('operation_in_progress', true), { 'content-type': 'application/json', 'retry-after': '120' })).confirm(REQUEST)).toMatchObject({ retryAfterMs: 30_000 });
    expect(await client(respond(429, error('rate_limited', true))).confirm(REQUEST)).toMatchObject({ kind: 'retry', code: 'rate_limited' });
    expect(await client(respond(503, error('dependency_unavailable', true))).confirm(REQUEST)).toEqual({ kind: 'retry', code: 'dependency_unavailable', retryAfterMs: null });
    expect(await client(() => Promise.reject(new TypeError('fetch failed'))).confirm(REQUEST)).toEqual({ kind: 'retry', code: 'identity_unreachable', retryAfterMs: null });
  });

  it('definitive refusals: 400, 401, 403 (credential), 409 idempotency_conflict, a redirect', async () => {
    expect(await client(respond(400, error('invalid_request'))).confirm(REQUEST)).toEqual({ kind: 'refused', code: 'invalid_request', credentialRejected: false });
    expect(await client(respond(401, error('unauthenticated'))).confirm(REQUEST)).toEqual({ kind: 'refused', code: 'identity_unauthorized', credentialRejected: true });
    expect(await client(respond(403, error('consumer_not_allowed'))).confirm(REQUEST)).toEqual({ kind: 'refused', code: 'identity_unauthorized', credentialRejected: true });
    expect(await client(respond(409, error('idempotency_conflict'))).confirm(REQUEST)).toEqual({ kind: 'refused', code: 'idempotency_conflict', credentialRejected: false });
    expect(await client(respond(302, '', { location: 'https://elsewhere.example/' })).confirm(REQUEST)).toEqual({ kind: 'refused', code: 'unexpected_status', credentialRejected: false });
  });
});

describe('no secret leaves the client', () => {
  it('telemetry carries the answer and status only: never the code, verificationId, subject, token or body', async () => {
    const events: CiaConfirmCallTelemetry[] = [];
    await client(respond(200, fixture('response.invalid-code.json')), events).confirm(REQUEST);
    await client(respond(401, error('unauthenticated')), events).confirm(REQUEST);
    expect(events.map((e) => [e.answer, e.outcome, e.code, e.httpStatus])).toEqual([['outcome', 'invalid_code', null, 200], ['refused', null, 'identity_unauthorized', 401]]);
    const text = JSON.stringify(events);
    for (const secret of [CODE, REQUEST.verificationId, REQUEST.context.subjectRef, REQUEST.context.sessionRef, TOKEN, REQUEST.idempotencyKey]) expect(text).not.toContain(secret);
  });
});
