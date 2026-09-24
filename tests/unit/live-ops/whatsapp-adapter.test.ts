import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WhatsAppInboundAdapter, WhatsAppOutboundAdapter, describeWhatsAppConfig, loadWhatsAppCloudConfig, type WhatsAppCloudConfig } from '@r4-adapters/whatsapp-cloud';
import { FakeWhatsAppProvider, notification, signNotification } from '@r4-adapters/whatsapp-cloud/testing';

const PHONE = '1098765432';
const env = (base: string) => ({
  R4_WHATSAPP_APP_SECRET: 'app-secret-for-tests',
  R4_WHATSAPP_VERIFY_TOKEN: 'verify-me',
  R4_WHATSAPP_ACCESS_TOKEN: 'token-for-tests',
  R4_WHATSAPP_PHONE_NUMBER_ID: PHONE,
  R4_WHATSAPP_GRAPH_BASE_URL: base,
});

let provider: FakeWhatsAppProvider;
let config: WhatsAppCloudConfig;

beforeAll(async () => {
  provider = new FakeWhatsAppProvider({ accessToken: 'token-for-tests' });
  await provider.start();
  config = loadWhatsAppCloudConfig(env(provider.baseUrl), { allowNetwork: false });
});
afterAll(() => provider.stop());

describe('configuration (fail closed)', () => {
  it('requires every secret and refuses a non-local provider without the network opt-in', () => {
    expect(() => loadWhatsAppCloudConfig({ ...env(provider.baseUrl), R4_WHATSAPP_APP_SECRET: '' }, { allowNetwork: false })).toThrow(/missing R4_WHATSAPP_APP_SECRET/);
    expect(() => loadWhatsAppCloudConfig(env('https://graph.facebook.com'), { allowNetwork: false })).toThrow(/network_not_allowed|R4_PROD_ALLOW_NETWORK/);
    expect(loadWhatsAppCloudConfig(env('https://graph.facebook.com'), { allowNetwork: true }).graphBaseUrl).toBe('https://graph.facebook.com');
  });

  it('describes itself without secrets', () => {
    const text = JSON.stringify(describeWhatsAppConfig(config));
    for (const secret of ['app-secret-for-tests', 'verify-me', 'token-for-tests', PHONE]) expect(text).not.toContain(secret);
  });
});

describe('inbound: verification and authenticity', () => {
  const inbound = () => new WhatsAppInboundAdapter(config);

  it('echoes the challenge only for subscribe + the configured token', () => {
    expect(inbound().verifySubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' })).toEqual({ ok: true, body: '12345' });
    expect(inbound().verifySubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345' })).toMatchObject({ ok: false, status: 403 });
    expect(inbound().verifySubscription({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '1' })).toMatchObject({ ok: false });
  });

  it('accepts only a valid X-Hub-Signature-256 over the exact raw body', () => {
    const body = notification(PHONE, { messages: [{ id: 'wamid.in.1', from: '56911112222', text: 'hola' }] });
    expect(inbound().authenticate(body, { 'x-hub-signature-256': signNotification('app-secret-for-tests', body) })).toEqual({ ok: true });
    expect(inbound().authenticate(body, {})).toEqual({ ok: false, reason: 'missing_signature' });
    expect(inbound().authenticate(body, { 'x-hub-signature-256': signNotification('other-secret', body) })).toEqual({ ok: false, reason: 'invalid_signature' });
    expect(inbound().authenticate(`${body} `, { 'x-hub-signature-256': signNotification('app-secret-for-tests', body) })).toEqual({ ok: false, reason: 'invalid_signature' });
    expect(inbound().authenticate(body, { 'x-hub-signature-256': 'sha1=abc' })).toEqual({ ok: false, reason: 'invalid_signature_format' });
  });
});

describe('inbound: canonicalization', () => {
  it('maps text messages, classifies media as unsupported, maps statuses (sent → accepted)', () => {
    const parsed = new WhatsAppInboundAdapter(config).parse(notification(PHONE, {
      messages: [{ id: 'wamid.a', from: '+56 9 1111 2222', text: 'hola', timestamp: 1_790_000_000 }, { id: 'wamid.b', from: '56911112222', type: 'image' }],
      statuses: [{ id: 'wamid.out.1', status: 'sent', recipientId: '56911112222', timestamp: 1_790_000_100 }, { id: 'wamid.out.1', status: 'failed', recipientId: '56911112222', errorCode: 131047 }],
    }));
    expect(parsed.rejected).toEqual([]);
    expect(parsed.inbound[0]).toMatchObject({ channel: 'whatsapp', accountRef: PHONE, conversationRef: '56911112222', providerEventId: 'wamid.a', occurredAt: new Date(1_790_000_000_000).toISOString(), content: { kind: 'text', text: 'hola' } });
    expect(parsed.inbound[1]).toMatchObject({ providerEventId: 'wamid.b', content: { kind: 'unsupported', contentType: 'image' } });
    expect(parsed.statuses.map((s) => [s.status, s.errorCode])).toEqual([['accepted', null], ['failed', '131047']]);
    expect(JSON.stringify(parsed)).not.toContain('Test Contact');
  });

  it('never takes another business number (the production number stays with its owner) and reads metadata per change', () => {
    const foreign = new WhatsAppInboundAdapter(config).parse(notification('5550001', { messages: [{ id: 'wamid.x', from: '56911112222', text: 'hola' }] }));
    expect(foreign.inbound).toEqual([]);
    expect(foreign.rejected).toEqual([{ providerEventId: 'wamid.x', reason: 'foreign_business_number' }]);
    const mixed = JSON.parse(notification(PHONE, { messages: [{ id: 'wamid.mine', from: '56911112222', text: 'mío' }] })) as { entry: { changes: unknown[] }[] };
    mixed.entry[0]!.changes.unshift((JSON.parse(notification('5550001', { messages: [{ id: 'wamid.theirs', from: '56900000000', text: 'ajeno' }] })) as { entry: { changes: unknown[] }[] }).entry[0]!.changes[0]);
    const parsed = new WhatsAppInboundAdapter(config).parse(JSON.stringify(mixed));
    expect(parsed.inbound.map((m) => m.providerEventId)).toEqual(['wamid.mine']);
    expect(parsed.rejected.map((r) => r.providerEventId)).toEqual(['wamid.theirs']);
  });

  it('rejects what cannot be canonicalized instead of guessing (poison, no retry loop)', () => {
    const adapter = new WhatsAppInboundAdapter(config);
    expect(adapter.parse('not json').rejected).toEqual([{ providerEventId: null, reason: 'invalid_json' }]);
    expect(adapter.parse(JSON.stringify({ object: 'page', entry: [] })).rejected[0]!.reason).toBe('unsupported_notification_object');
    const bad = JSON.parse(notification(PHONE, { messages: [{ id: 'wamid.t', from: '56911112222', text: 'x' }] })) as { entry: { changes: { value: { messages: { timestamp: string }[] } }[] }[] };
    bad.entry[0]!.changes[0]!.value.messages[0]!.timestamp = 'yesterday';
    expect(adapter.parse(JSON.stringify(bad)).rejected).toEqual([{ providerEventId: 'wamid.t', reason: 'invalid_timestamp' }]);
    expect(adapter.parse(notification(PHONE, { messages: [{ id: 'wamid.e', from: '56911112222', text: '   ' }] })).rejected).toEqual([{ providerEventId: 'wamid.e', reason: 'empty_text' }]);
  });
});

describe('outbound: honest classification of one submission', () => {
  const submission = { outboundId: 'o1', idempotencyKey: 'r4-out:s1', accountRef: PHONE, recipientRef: '56911112222', text: 'Hola, ¿en qué te ayudo?', attempt: 1 };
  const send = (timeoutMs = 2000) => new WhatsAppOutboundAdapter(config).submit(submission, { timeoutMs });

  it('accepted with the provider id; the documented request shape', async () => {
    provider.script({ kind: 'accept' });
    const r = await send();
    expect(r).toMatchObject({ outcome: 'accepted', httpStatus: 200 });
    expect(r.providerMessageId).toMatch(/^wamid\.fake\./);
    expect(provider.sends.at(-1)).toMatchObject({ phoneNumberId: PHONE, to: '56911112222', text: submission.text, authorized: true });
  });

  it('429 is definitely not sent (retryable, Retry-After honored)', async () => {
    provider.script({ kind: 'status', status: 429, retryAfter: '3' });
    expect(await send()).toMatchObject({ outcome: 'not_sent', errorClass: 'rate_limited', retryAfterMs: 3000 });
  });

  it('definitive refusals are rejected (incl. the 24 h window)', async () => {
    provider.script({ kind: 'status', status: 400, body: { error: { code: 131047, message: 're-engagement' } } }, { kind: 'status', status: 400, body: { error: { code: 100 } } });
    expect(await send()).toMatchObject({ outcome: 'rejected', errorClass: 'window_closed', errorCode: '131047' });
    expect(await send()).toMatchObject({ outcome: 'rejected', errorClass: 'invalid_request' });
  });

  it('5xx, timeouts, dropped connections and ids missing from a 2xx are UNKNOWN (never retried blindly)', async () => {
    provider.script({ kind: 'status', status: 503 }, { kind: 'hang', ms: 1500 }, { kind: 'drop' }, { kind: 'accept_without_id' });
    expect(await send()).toMatchObject({ outcome: 'unknown', errorClass: 'provider_5xx' });
    expect(await send(200)).toMatchObject({ outcome: 'unknown', errorClass: 'timeout' });
    expect(await send()).toMatchObject({ outcome: 'unknown', errorClass: 'network_after_send' });
    expect(await send()).toMatchObject({ outcome: 'unknown', errorClass: 'protocol' });
  });

  it('a refused connection is definitely not sent', async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
    await new Promise((resolve) => server.close(resolve));
    const closed = loadWhatsAppCloudConfig(env(`http://127.0.0.1:${port}`), { allowNetwork: false });
    expect(await new WhatsAppOutboundAdapter(closed).submit(submission, { timeoutMs: 2000 })).toMatchObject({ outcome: 'not_sent', errorClass: 'network_before_send' });
  });

  it('never sends from another business number', async () => {
    const before = provider.sends.length;
    expect(await new WhatsAppOutboundAdapter(config).submit({ ...submission, accountRef: '5550001' }, { timeoutMs: 1000 })).toMatchObject({ outcome: 'rejected', errorClass: 'foreign_business_number' });
    expect(provider.sends.length).toBe(before);
  });
});
