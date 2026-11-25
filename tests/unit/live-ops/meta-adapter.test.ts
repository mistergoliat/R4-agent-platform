import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MetaInboundAdapter, MetaOutboundAdapter, checkMetaConnection, loadMetaChannelConfig, splitForSurface, type MetaFetch } from '@r4-adapters/meta';
import type { OutboundSubmission } from '@r4/live-ops';

/** ADR-060 M1: Messenger and Instagram Direct through the Page — verification, signature, canonical inbound, honest send. */
const env = { R4_META_PAGE_ID: '1111111111', R4_META_INSTAGRAM_ACCOUNT_ID: '17840000000000001', R4_META_PAGE_ACCESS_TOKEN: 'page-token', R4_WHATSAPP_APP_SECRET: 'app-secret', R4_WHATSAPP_VERIFY_TOKEN: 'verify-me', R4_META_GRAPH_BASE_URL: 'http://127.0.0.1:9' };
const config = loadMetaChannelConfig(env, { allowNetwork: false });
const sign = (body: string) => `sha256=${createHmac('sha256', 'app-secret').update(body, 'utf8').digest('hex')}`;
const dm = (object: 'page' | 'instagram', accountId: string, message: Record<string, unknown>, sender = '2222222222') =>
  JSON.stringify({ object, entry: [{ id: accountId, time: 1764040000000, messaging: [{ sender: { id: sender }, recipient: { id: accountId }, timestamp: 1764040000000, message: { mid: 'm_1', ...message } }] }] });

type Call = { url: string; headers: Record<string, string>; body: unknown };
function fakeFetch(responses: Array<{ status: number; body: unknown } | Error>): { fetch: MetaFetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
      const next = responses.shift() ?? { status: 500, body: null };
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ status: next.status, text: () => Promise.resolve(JSON.stringify(next.body)) });
    },
  };
}
const submission = (text: string, accountRef = '1111111111'): OutboundSubmission => ({ outboundId: 'o1', idempotencyKey: 'k1', accountRef, recipientRef: '2222222222', text, attempt: 1 });

describe('Meta channel configuration', () => {
  it('connects with the Page id and token (+ the Instagram id), reusing the WhatsApp app secret and verify token', () => {
    expect(config).toMatchObject({ pageId: '1111111111', instagramAccountId: '17840000000000001', appSecret: 'app-secret', verifyToken: 'verify-me', graphVersion: 'v25.0' });
    expect(loadMetaChannelConfig({ ...env, R4_META_INSTAGRAM_ACCOUNT_ID: '' }, { allowNetwork: false }).instagramAccountId).toBeNull();
    expect(loadMetaChannelConfig({ ...env, R4_META_APP_SECRET: 'own' }, { allowNetwork: false }).appSecret).toBe('own');
  });

  it('says exactly what is missing, and refuses the real Graph API without the network opt-in', () => {
    expect(() => loadMetaChannelConfig({ R4_WHATSAPP_APP_SECRET: 'x', R4_WHATSAPP_VERIFY_TOKEN: 'y' }, { allowNetwork: false })).toThrow(/R4_META_PAGE_ID is missing.*R4_META_PAGE_ACCESS_TOKEN is missing/);
    expect(() => loadMetaChannelConfig({ ...env, R4_META_GRAPH_BASE_URL: '' }, { allowNetwork: false })).toThrow(/R4_PROD_ALLOW_NETWORK/);
    expect(() => loadMetaChannelConfig({ ...env, R4_META_PAGE_ID: 'my-page' }, { allowNetwork: false })).toThrow(/numeric Page id/);
  });
});

describe('Meta inbound', () => {
  const inbound = new MetaInboundAdapter(config);

  it('verifies the subscription and the signature over the raw body, failing closed', () => {
    expect(inbound.verifySubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '42' })).toEqual({ ok: true, body: '42' });
    expect(inbound.verifySubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '42' })).toMatchObject({ ok: false, status: 403 });
    const body = dm('page', '1111111111', { text: 'hola \\u00e1' });
    expect(inbound.authenticate(body, { 'x-hub-signature-256': sign(body) })).toEqual({ ok: true });
    expect(inbound.authenticate(body, { 'x-hub-signature-256': sign(`${body} `) })).toEqual({ ok: false, reason: 'invalid_signature' });
    expect(inbound.authenticate(body, {})).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('a Messenger text becomes a one-to-one inbound with the platform channel note', () => {
    const parsed = inbound.parse(dm('page', '1111111111', { text: ' ¿Tienen barras olímpicas? ' }));
    expect(parsed.rejected).toEqual([]);
    expect(parsed.inbound).toEqual([
      { channel: 'meta', accountRef: '1111111111', conversationRef: '2222222222', senderRef: '2222222222', providerEventId: 'm_1', occurredAt: new Date(1764040000000).toISOString(), metadata: { surface: 'messenger' }, content: { kind: 'text', text: '¿Tienen barras olímpicas?\n\n[Canal informado por la plataforma: Messenger de Facebook, mensaje directo.]' } },
    ]);
  });

  it('an Instagram story reply says so; media is unsupported (told to the agent), never dropped', () => {
    const story = inbound.parse(dm('instagram', '17840000000000001', { text: 'qué buena rutina', reply_to: { story: { id: 's1', url: 'https://x' } } }));
    expect(story.inbound[0]!.content).toEqual({ kind: 'text', text: 'qué buena rutina\n\n[Canal informado por la plataforma: Instagram, mensaje directo, respondiendo a una historia de la cuenta.]' });
    expect(story.inbound[0]!.metadata).toEqual({ surface: 'instagram' });
    expect(inbound.parse(dm('instagram', '17840000000000001', { attachments: [{ type: 'image', payload: { url: 'https://x' } }] })).inbound[0]!.content).toEqual({ kind: 'unsupported', contentType: 'instagram.image' });
    expect(inbound.parse(dm('instagram', '17840000000000001', { is_unsupported: true })).inbound[0]!.content).toEqual({ kind: 'unsupported', contentType: 'instagram.unsupported' });
  });

  it('skips echoes (what the account sent) and deleted messages; refuses foreign accounts and a mismatched object', () => {
    expect(inbound.parse(dm('page', '1111111111', { text: 'eco', is_echo: true }))).toEqual({ inbound: [], statuses: [], rejected: [] });
    expect(inbound.parse(dm('instagram', '17840000000000001', { is_deleted: true })).inbound).toEqual([]);
    expect(inbound.parse(dm('page', '9999999999', { text: 'hola' })).rejected).toEqual([{ providerEventId: null, reason: 'foreign_account' }]);
    expect(inbound.parse(dm('instagram', '1111111111', { text: 'hola' })).rejected).toEqual([{ providerEventId: null, reason: 'foreign_account' }]);
    expect(inbound.parse(JSON.stringify({ object: 'whatsapp_business_account', entry: [] })).rejected[0]!.reason).toBe('unsupported_notification_object');
  });

  it('without an Instagram account, Instagram notifications are foreign', () => {
    const messengerOnly = new MetaInboundAdapter(loadMetaChannelConfig({ ...env, R4_META_INSTAGRAM_ACCOUNT_ID: '' }, { allowNetwork: false }));
    expect(messengerOnly.parse(dm('instagram', '17840000000000001', { text: 'hola' })).rejected[0]!.reason).toBe('foreign_account');
  });
});

describe('Meta outbound', () => {
  it('sends through the Page with the Page token and classifies the reply id as accepted', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { recipient_id: '2222222222', message_id: 'mid.1' } }]);
    const result = await new MetaOutboundAdapter(config, { fetch }).submit(submission('Hola 💪'), { timeoutMs: 5000 });
    expect(result).toMatchObject({ outcome: 'accepted', providerMessageId: 'mid.1' });
    expect(calls[0]).toEqual({ url: 'http://127.0.0.1:9/v25.0/1111111111/messages', headers: { authorization: 'Bearer page-token', 'content-type': 'application/json' }, body: { recipient: { id: '2222222222' }, messaging_type: 'RESPONSE', message: { text: 'Hola 💪' } } });
  });

  it('a long Instagram reply goes as parts ≤ 1000 bytes; a failed later part is a partial delivery, never a retry', async () => {
    const long = `${'á'.repeat(450)}\n\n${'é'.repeat(450)}`;
    expect(splitForSurface(long, 'instagram').map((p) => Buffer.byteLength(p))).toEqual([900, 900]);
    expect(splitForSurface(long, 'messenger')).toEqual([long]);
    const ok = fakeFetch([{ status: 200, body: { message_id: 'a' } }, { status: 200, body: { message_id: 'b' } }]);
    expect(await new MetaOutboundAdapter(config, { fetch: ok.fetch }).submit(submission(long, '17840000000000001'), { timeoutMs: 5000 })).toMatchObject({ outcome: 'accepted', providerMessageId: 'a', errorClass: null });
    expect(ok.calls).toHaveLength(2);
    const partial = fakeFetch([{ status: 200, body: { message_id: 'a' } }, { status: 500, body: null }]);
    expect(await new MetaOutboundAdapter(config, { fetch: partial.fetch }).submit(submission(long, '17840000000000001'), { timeoutMs: 5000 })).toMatchObject({ outcome: 'accepted', providerMessageId: 'a', errorClass: 'partial_delivery' });
  });

  it.each([
    [{ status: 400, body: { error: { code: 10, error_subcode: 2018278 } } }, { outcome: 'rejected', errorClass: 'window_closed', errorCode: '10/2018278' }],
    [{ status: 400, body: { error: { code: 613 } } }, { outcome: 'not_sent', errorClass: 'rate_limited' }],
    [{ status: 401, body: { error: { code: 190 } } }, { outcome: 'rejected', errorClass: 'auth' }],
    [{ status: 503, body: null }, { outcome: 'unknown', errorClass: 'provider_5xx' }],
    [{ status: 200, body: {} }, { outcome: 'unknown', errorClass: 'protocol' }],
    [Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }), { outcome: 'not_sent', errorClass: 'network_before_send' }],
    [Object.assign(new Error('reset'), { cause: { code: 'ECONNRESET' } }), { outcome: 'unknown', errorClass: 'network_after_send' }],
  ])('classifies honestly: %o', async (response, expected) => {
    const { fetch } = fakeFetch([response]);
    expect(await new MetaOutboundAdapter(config, { fetch }).submit(submission('hola'), { timeoutMs: 5000 })).toMatchObject(expected);
  });

  it('refuses a foreign account or a malformed recipient before any call', async () => {
    const { fetch, calls } = fakeFetch([]);
    const adapter = new MetaOutboundAdapter(config, { fetch });
    expect(await adapter.submit(submission('hola', '5555555555'), { timeoutMs: 5000 })).toMatchObject({ outcome: 'rejected', errorClass: 'foreign_account' });
    expect(await adapter.submit({ ...submission('hola'), recipientRef: '+56 9' }, { timeoutMs: 5000 })).toMatchObject({ outcome: 'rejected', errorClass: 'invalid_recipient' });
    expect(calls).toEqual([]);
  });

  it('shows typing in the conversation of the inbound; without it, nothing', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { recipient_id: '2222222222' } }]);
    const adapter = new MetaOutboundAdapter(config, { fetch });
    expect(await adapter.signalWorking({ accountRef: '1111111111', providerEventId: 'm_1', conversationRef: '2222222222' }, { timeoutMs: 1000 })).toBe(true);
    expect(calls[0]!.body).toEqual({ recipient: { id: '2222222222' }, sender_action: 'typing_on' });
    expect(await adapter.signalWorking({ accountRef: '1111111111', providerEventId: 'm_1' }, { timeoutMs: 1000 })).toBe(false);
  });
});

describe('Meta connection check', () => {
  it('passes when the token reads the Page, the Instagram account is the linked one and the app gets the messages', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { id: '1111111111', name: 'Pesas Chile', instagram_business_account: { id: '17840000000000001' } } }, { status: 200, body: { data: [{ name: 'R4', subscribed_fields: ['messages'] }] } }]);
    const result = await checkMetaConnection(config, { fetch });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.step)).toEqual(['page', 'instagram', 'subscription']);
    expect(calls.map((c) => c.url)).toEqual(['http://127.0.0.1:9/v25.0/1111111111?fields=name,instagram_business_account', 'http://127.0.0.1:9/v25.0/1111111111/subscribed_apps']);
  });

  it('names the problem: a wrong Instagram id, and a Page not subscribed (subscribed with --subscribe)', async () => {
    const page = { status: 200, body: { id: '1111111111', name: 'Pesas Chile', instagram_business_account: { id: '17849999999999999' } } };
    const wrong = await checkMetaConnection(config, { fetch: fakeFetch([page, { status: 200, body: { data: [] } }]).fetch });
    expect(wrong.ok).toBe(false);
    expect(wrong.steps.find((s) => s.step === 'instagram')!.detail).toMatch(/linked: 17849999999999999/);
    expect(wrong.steps.find((s) => s.step === 'subscription')!.detail).toMatch(/--subscribe/);
    const fixed = fakeFetch([{ ...page, body: { ...page.body, instagram_business_account: { id: '17840000000000001' } } }, { status: 200, body: { data: [] } }, { status: 200, body: { success: true } }]);
    expect((await checkMetaConnection(config, { fetch: fixed.fetch, subscribe: true })).ok).toBe(true);
    expect(fixed.calls[2]!.url).toBe('http://127.0.0.1:9/v25.0/1111111111/subscribed_apps?subscribed_fields=messages');
  });

  it('a token that cannot read the Page stops there', async () => {
    const result = await checkMetaConnection(config, { fetch: fakeFetch([{ status: 400, body: { error: { message: 'Invalid OAuth access token' } } }]).fetch });
    expect(result).toEqual({ ok: false, steps: [{ step: 'page', ok: false, detail: 'the token cannot read Page 1111111111 (HTTP 400: Invalid OAuth access token)' }] });
  });
});
