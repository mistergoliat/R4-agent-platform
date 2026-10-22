import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DomainError } from '@r4-adapters/domains';
import { CIA_START_ROUTE, CiaVerificationStartClient, type CiaStartCallTelemetry, type CiaStartRequest, type CustomerIdentityFetch } from '@r4-adapters/identity-http';

// SEC-S5: the CIA start client (contract v1-d2 §5.1, pinned at 7525395) with the agent credential:
// the request it sends, the classification of its answers, and no secret in its telemetry. Synthetic only.

const CONTRACT = join(import.meta.dirname, '..', '..', '..', 'adapters', 'domains', 'identity', 'http', 'contract');
const ISSUED = JSON.parse(readFileSync(join(CONTRACT, 'fixtures', 'verification-start', 'response.challenge-issued.json'), 'utf8')) as Record<string, unknown>;
const TOKEN = 'synthetic-r4-sales-agent-token-0001';
const EMAIL = 'valid@synthetic.test';
const REQUEST: CiaStartRequest = {
  context: { channel: 'whatsapp', channelAccountRef: '100000000000001', subjectRef: '15555550101', sessionRef: '0190b0b0-0000-7000-8000-000000000001' },
  email: EMAIL,
  idempotencyKey: `vs.${'b'.repeat(64)}`,
  correlationId: 'corr-start-1',
};

type Init = Parameters<CustomerIdentityFetch>[1];
const recorded: { url: string; init: Init }[] = [];
const respond = (status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): CustomerIdentityFetch => (url, init) => {
  recorded.push({ url, init });
  return Promise.resolve({ status, headers: new Headers(headers), body: new Response(JSON.stringify(body)).body });
};
function client(fetch: CustomerIdentityFetch, events: CiaStartCallTelemetry[] = []) {
  recorded.length = 0;
  return new CiaVerificationStartClient({ config: { baseUrl: 'http://127.0.0.1:8787', bearerToken: TOKEN, timeoutMs: 1_500, lifecycle: 'synthetic' }, fetch, onCall: (e) => events.push(e) });
}
const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
};
const error = (code: string, retryable = false) => ({ error: { code, retryable } });

describe('the start request', () => {
  it('posts the pinned body with the agent credential and the idempotency key; returns only the challenge', async () => {
    const challenge = await client(respond(202, ISSUED)).start(REQUEST);
    expect(challenge).toEqual({ verificationId: ISSUED.verificationId, expiresAt: ISSUED.expiresAt, resendAvailableAt: ISSUED.resendAvailableAt });
    const [{ url, init }] = recorded as [{ url: string; init: Init }];
    expect(url).toBe(`http://127.0.0.1:8787${CIA_START_ROUTE}`);
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'idempotency-key': REQUEST.idempotencyKey });
    expect(JSON.parse(init.body)).toEqual({ schemaVersion: 1, context: { ...REQUEST.context, subjectAssurance: 'provider_signed' }, verificationPurpose: 'link_commercial_account', email: EMAIL, purposes: ['sales_context', 'purchase_history'] });
  });

  it('an e-mail outside the pinned schema (filter injection) is refused before the network', async () => {
    expect(await failure(client(respond(202, ISSUED)).start({ ...REQUEST, email: 'a|b@synthetic.test' }))).toMatchObject({ category: 'validation', code: 'invalid_start_request' });
    expect(recorded).toHaveLength(0);
  });
});

describe('classification', () => {
  it.each<[number, unknown, string, string]>([
    [400, error('invalid_request'), 'validation', 'invalid_request'],
    [401, error('unauthenticated'), 'unauthorized', 'identity_unauthorized'],
    [403, error('consumer_not_allowed'), 'unauthorized', 'identity_unauthorized'],
    [409, error('idempotency_conflict'), 'conflict', 'idempotency_conflict'],
    [409, error('operation_in_progress', true), 'temporarily_unavailable', 'operation_in_progress'],
    [429, error('rate_limited', true), 'temporarily_unavailable', 'rate_limited'],
    [503, error('delivery_unavailable', true), 'temporarily_unavailable', 'delivery_unavailable'],
  ])('HTTP %i → %s', async (status, body, category, code) => {
    expect(await failure(client(respond(status, body)).start(REQUEST))).toMatchObject({ category, code });
  });

  it('an off-contract 202 is a contract violation, never repaired', async () => {
    expect(await failure(client(respond(202, { ...ISSUED, customerRef: 'prestashop_customer:900000201' })).start(REQUEST))).toMatchObject({ category: 'contract_violation', code: 'invalid_response' });
  });
});

describe('no secret leaves the client', () => {
  it('telemetry carries no e-mail, subject, verificationId, token or body', async () => {
    const events: CiaStartCallTelemetry[] = [];
    await client(respond(202, ISSUED), events).start(REQUEST);
    await failure(client(respond(429, error('rate_limited', true)), events).start(REQUEST));
    expect(events.map((e) => [e.outcome, e.httpStatus, e.errorCode])).toEqual([['ok', 202, null], ['failed', 429, 'rate_limited']]);
    const text = JSON.stringify(events);
    for (const secret of [EMAIL, REQUEST.context.subjectRef, REQUEST.context.sessionRef, String(ISSUED.verificationId), TOKEN, REQUEST.idempotencyKey]) expect(text).not.toContain(secret);
  });
});
