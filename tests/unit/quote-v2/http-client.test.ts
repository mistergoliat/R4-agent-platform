import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QuoteV2HttpClient, loadQuoteHttpConfig, describeQuoteHttpConfig, type QuoteCallTelemetry, type QuoteFetch } from '@r4-adapters/quote-http';
import type { QuoteV2CreateRequest } from '@r4-adapters/domains';

const fixture = (name: string): string => readFileSync(new URL(`../../../adapters/domains/quote/http/fixtures/${name}`, import.meta.url), 'utf8');
const REQUEST = JSON.parse(fixture('create-and-issue.request.json')) as QuoteV2CreateRequest;
const TOKEN = 'r4-test-token-0123456789abcdef0123456789abcdef';
const KEY = 'r4x_0123456789abcdef0123456789abcdef';
const config = { baseUrl: 'http://127.0.0.1:4020', bearerToken: TOKEN, timeoutMs: 1_000 };

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function respond(status: number, body: string | Uint8Array, headers: Record<string, string> = {}): Awaited<ReturnType<QuoteFetch>> {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(typeof body === 'string' ? body : new TextDecoder().decode(body)),
    arrayBuffer: () => Promise.resolve((typeof body === 'string' ? new TextEncoder().encode(body) : body).slice().buffer),
  };
}

function client(answer: (seen: Seen) => Awaited<ReturnType<QuoteFetch>> | Promise<never>) {
  const seen: Seen[] = [];
  const telemetry: QuoteCallTelemetry[] = [];
  const fetch: QuoteFetch = (url, init) => {
    const s = { url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) };
    seen.push(s);
    const aborted = new Promise<never>((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    return Promise.race([Promise.resolve().then(() => answer(s)), aborted]);
  };
  return { quotes: new QuoteV2HttpClient({ config, fetch, onCall: (e) => telemetry.push(e) }), seen, telemetry };
}

const networkError = (code: string) => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code } }));

describe('QuoteV2HttpClient — create and issue', () => {
  it('sends bearer auth, Idempotency-Key and the exact body; parses the owner 201 example', async () => {
    const { quotes, seen, telemetry } = client(() => respond(201, fixture('create-and-issue.response-201.json'), { 'Idempotent-Replay': 'true' }));
    const result = await quotes.createAndIssue(REQUEST, KEY, { correlationId: 'corr-1' });
    expect(result).toMatchObject({ httpStatus: 201, replayed: true, quote: { status: 'issued', quoteNumber: 'PC-000137', totals: { gross: 147_098 } }, operation: { status: 'succeeded' } });
    expect(seen[0]).toMatchObject({ url: 'http://127.0.0.1:4020/v2/quotes', method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'idempotency-key': KEY, 'content-type': 'application/json', 'x-correlation-id': 'corr-1' } });
    expect(JSON.parse(seen[0]!.body!)).toEqual(REQUEST);
    // Telemetry never carries the token, the key or the body.
    expect(JSON.stringify(telemetry)).not.toMatch(new RegExp(`${TOKEN}|${KEY}|Camila`));
    expect(telemetry[0]).toMatchObject({ operation: 'createAndIssue', outcome: 'ok', httpStatus: 201, replayed: true });
  });

  it('202 is accepted but issuing (never success by status alone)', async () => {
    const { quotes } = client(() => respond(202, fixture('create-and-issue.response-202.json')));
    expect(await quotes.createAndIssue(REQUEST, KEY)).toMatchObject({ httpStatus: 202, quote: { status: 'issuing', document: { available: false } }, operation: { status: 'pending' } });
  });

  it('a status that contradicts the quote state, or an invalid body, is a contract violation', async () => {
    await expect(client(() => respond(201, fixture('create-and-issue.response-202.json'))).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'contract_violation' });
    await expect(client(() => respond(201, '{"quote":{}}')).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'contract_violation' });
    await expect(client(() => respond(200, fixture('create-and-issue.response-201.json'))).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'contract_violation' });
  });

  it('maps owner refusals to typed errors: 401/403, 409 idempotency vs lifecycle, 422 arithmetic', async () => {
    const error = (code: string) => JSON.stringify({ error: { code, message: 'x', requestId: 'req_1' } });
    await expect(client(() => respond(401, error('unauthenticated'))).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'unauthorized', code: 'unauthenticated' });
    await expect(client(() => respond(403, error('forbidden'))).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'unauthorized', code: 'forbidden' });
    await expect(client(() => respond(409, fixture('error.idempotency-key-conflict.json'))).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'conflict', code: 'idempotency_key_conflict', details: { boundRequestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    await expect(client(() => respond(409, fixture('error.operation-in-progress.json'))).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'conflict', code: 'operation_in_progress' });
    await expect(client(() => respond(422, fixture('error.arithmetic-mismatch.json'))).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'validation', code: 'arithmetic_mismatch', details: { expected_gross: 147_099, computed_gross: 147_098 } });
    await expect(client(() => respond(422, fixture('error.validation.json'))).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'validation', code: 'validation_error' });
  });

  it('a mutation that may have committed is unknown, never "unavailable": 503/500, reset after send, deadline', async () => {
    await expect(client(() => respond(503, fixture('error.dependency-unavailable.json'))).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'unknown_outcome', outcomeUnknown: true });
    await expect(client(() => respond(500, '')).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'unknown_outcome' });
    await expect(client(() => networkError('ECONNRESET')).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'unknown_outcome' });
    const hang = client(() => new Promise<never>(() => undefined));
    await expect(hang.quotes.createAndIssue(REQUEST, KEY, { signal: AbortSignal.timeout(20) })).rejects.toMatchObject({ category: 'timeout', outcomeUnknown: true });
    // A connection that was never established proves nothing was sent.
    await expect(client(() => networkError('ECONNREFUSED')).quotes.createAndIssue(REQUEST, KEY)).rejects.toMatchObject({ category: 'temporarily_unavailable', outcomeUnknown: false });
  });
});

describe('QuoteV2HttpClient — reads', () => {
  const QUOTE_ID = '0f8e4a52-3c1b-4d6e-9b7a-2e5f1c8d9a10';
  const OPERATION_ID = 'a3d9c1e7-5b2f-4a8c-8e1d-6f4b2c9e7d30';

  it('quote, operation and idempotency lookup (bound / not_found) from the owner examples', async () => {
    expect(await client(() => respond(200, fixture('quote-issued.json'))).quotes.getQuote(QUOTE_ID)).toMatchObject({ status: 'issued', document: { available: true } });
    expect(await client(() => respond(200, fixture('operation-failed-non-retryable.json'))).quotes.getOperation(OPERATION_ID)).toMatchObject({ status: 'failed', attempts: { lastErrorCode: 'document_generation_failed' } });
    const bound = client(() => respond(200, fixture('idempotency-lookup.bound.json')));
    expect(await bound.quotes.lookupIdempotency(KEY)).toMatchObject({ quoteId: QUOTE_ID, operationId: OPERATION_ID, quoteStatus: 'issued' });
    expect(bound.seen[0]).toMatchObject({ url: 'http://127.0.0.1:4020/v2/idempotency/current?operation=quote.create_and_issue', method: 'GET', headers: { 'idempotency-key': KEY } });
    expect(await client(() => respond(200, fixture('idempotency-lookup.not-found.json'))).quotes.lookupIdempotency(KEY)).toBeNull();
  });

  it('reads 5xx and network failures as temporarily unavailable (a read has no effect to reconcile)', async () => {
    await expect(client(() => respond(503, fixture('error.dependency-unavailable.json'))).quotes.getQuote(QUOTE_ID)).rejects.toMatchObject({ category: 'temporarily_unavailable' });
    await expect(client(() => networkError('ECONNRESET')).quotes.getQuote(QUOTE_ID)).rejects.toMatchObject({ category: 'temporarily_unavailable' });
    await expect(client(() => respond(404, JSON.stringify({ error: { code: 'quote_not_found', message: 'x', requestId: 'r' } }))).quotes.getQuote(QUOTE_ID)).rejects.toMatchObject({ category: 'not_found', code: 'quote_not_found' });
    await expect(client(() => respond(200, '{}')).quotes.getQuote('not-a-uuid')).rejects.toMatchObject({ category: 'validation' });
  });

  it('document: exact bytes and the declared hash; non-PDF is a contract violation', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\nbytes\n%%EOF\n');
    const sha = createHash('sha256').update(pdf).digest('hex');
    const ok = client(() => respond(200, pdf, { 'content-type': 'application/pdf', 'x-document-sha256': sha }));
    const document = await ok.quotes.getDocument(QUOTE_ID);
    expect(createHash('sha256').update(document.bytes).digest('hex')).toBe(sha);
    expect(document.declaredSha256).toBe(sha);
    expect(ok.seen[0]).toMatchObject({ url: `http://127.0.0.1:4020/v2/quotes/${QUOTE_ID}/document`, headers: { accept: 'application/pdf', authorization: `Bearer ${TOKEN}` } });
    await expect(client(() => respond(200, '<html>', { 'content-type': 'text/html' })).quotes.getDocument(QUOTE_ID)).rejects.toMatchObject({ category: 'contract_violation' });
    await expect(client(() => respond(503, JSON.stringify({ error: { code: 'document_storage_failed', message: 'x', requestId: 'r' } }))).quotes.getDocument(QUOTE_ID)).rejects.toMatchObject({ category: 'temporarily_unavailable', code: 'document_storage_failed' });
  });
});

describe('Quote adapter configuration', () => {
  const env = { R4_QUOTE_MODE: 'real', R4_QUOTE_BASE_URL: 'http://127.0.0.1:4020', R4_QUOTE_BEARER_TOKEN: TOKEN, R4_QUOTE_TIMEOUT_MS: '20000' };

  it('loads the EC2 loopback configuration and never describes the secret', () => {
    const loaded = loadQuoteHttpConfig(env, { allowNetwork: false });
    expect(loaded).toEqual({ baseUrl: 'http://127.0.0.1:4020', bearerToken: TOKEN, timeoutMs: 20_000 });
    expect(JSON.stringify(describeQuoteHttpConfig(loaded))).not.toContain(TOKEN);
  });

  it('fails closed: unset mode, missing token, short token, public http, network not allowed, bad timeout', () => {
    expect(() => loadQuoteHttpConfig({ ...env, R4_QUOTE_MODE: undefined }, { allowNetwork: false })).toThrow(/not "real"/);
    expect(() => loadQuoteHttpConfig({ ...env, R4_QUOTE_MODE: 'fixture' }, { allowNetwork: false })).toThrow(/must be "real" or unset/);
    expect(() => loadQuoteHttpConfig({ ...env, R4_QUOTE_BEARER_TOKEN: '' }, { allowNetwork: false })).toThrow(/missing R4_QUOTE_BEARER_TOKEN/);
    expect(() => loadQuoteHttpConfig({ ...env, R4_QUOTE_BEARER_TOKEN: 'short' }, { allowNetwork: false })).toThrow(/plausible token/);
    expect(() => loadQuoteHttpConfig({ ...env, R4_QUOTE_BASE_URL: 'https://quote.example.test' }, { allowNetwork: false })).toThrow(/R4_PROD_ALLOW_NETWORK/);
    expect(() => loadQuoteHttpConfig({ ...env, R4_QUOTE_BASE_URL: 'http://quote.example.test' }, { allowNetwork: true })).toThrow(/https/);
    expect(() => loadQuoteHttpConfig({ ...env, R4_QUOTE_BASE_URL: `http://user:${TOKEN}@127.0.0.1:4020` }, { allowNetwork: false })).toThrow(/credentials/);
    expect(() => loadQuoteHttpConfig({ ...env, R4_QUOTE_TIMEOUT_MS: '60000' }, { allowNetwork: false })).toThrow(/between 1000 and 30000/);
  });
});
