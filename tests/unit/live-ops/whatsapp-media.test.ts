import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WhatsAppInboundAdapter, WhatsAppMediaDownloader, loadWhatsAppCloudConfig, mediaSha256, type WhatsAppCloudConfig } from '@r4-adapters/whatsapp-cloud';
import { FakeWhatsAppProvider, notification } from '@r4-adapters/whatsapp-cloud/testing';
import type { InboundMediaRef } from '@r4/live-ops';

/** (Inbound multimodal v1) The WhatsApp side: what the webhook yields for images and audio, and the guarded download. */

const PHONE = '1098765432';
let provider: FakeWhatsAppProvider;
let config: WhatsAppCloudConfig;

beforeAll(async () => {
  provider = new FakeWhatsAppProvider({ accessToken: 'token-for-tests' });
  await provider.start();
  config = loadWhatsAppCloudConfig({ R4_WHATSAPP_APP_SECRET: 's', R4_WHATSAPP_VERIFY_TOKEN: 'v', R4_WHATSAPP_ACCESS_TOKEN: 'token-for-tests', R4_WHATSAPP_PHONE_NUMBER_ID: PHONE, R4_WHATSAPP_GRAPH_BASE_URL: provider.baseUrl }, { allowNetwork: false });
});
afterAll(() => provider.stop());

describe('inbound parse', () => {
  const parse = (messages: NonNullable<Parameters<typeof notification>[1]['messages']>) => new WhatsAppInboundAdapter(config).parse(notification(PHONE, { messages }));

  it('an image or an audio becomes a media reference (never bytes), with the caption and the voice flag', () => {
    const sha = createHash('sha256').update('x').digest();
    const { inbound } = parse([
      { id: 'w1', from: '56911111111', type: 'image', media: { id: 'mid.1', mimeType: 'image/jpeg', caption: '  ¿esta? ', sha256: sha.toString('base64') } },
      { id: 'w2', from: '56911111111', type: 'audio', media: { id: 'mid.2', mimeType: 'audio/ogg; codecs=opus', voice: true } },
    ]);
    expect(inbound.map((i) => i.content)).toEqual([
      { kind: 'media', mediaKind: 'image', mediaId: 'mid.1', mimeType: 'image/jpeg', sha256: sha.toString('hex'), caption: '¿esta?', voice: false },
      { kind: 'media', mediaKind: 'audio', mediaId: 'mid.2', mimeType: 'audio/ogg; codecs=opus', sha256: null, caption: null, voice: true },
    ]);
  });

  it('a sticker is media; a reaction keeps its emoji and target; unsupported keeps what it was', () => {
    const { inbound } = parse([
      { id: 'w7', from: '56911111111', type: 'sticker', media: { id: 'mid.7', mimeType: 'image/webp' } },
      { id: 'w8', from: '56911111111', type: 'reaction', reaction: { messageId: 'wamid.out.1', emoji: '👍' } },
      { id: 'w9', from: '56911111111', type: 'reaction', reaction: { messageId: 'wamid.out.1' } },
      { id: 'w10', from: '56911111111', type: 'unsupported', unsupportedType: 'view_once' },
      { id: 'w11', from: '56911111111', type: 'unsupported' },
    ]);
    expect(inbound.map((i) => i.content)).toEqual([
      { kind: 'media', mediaKind: 'sticker', mediaId: 'mid.7', mimeType: 'image/webp', sha256: null, caption: null, voice: false },
      { kind: 'reaction', emoji: '👍', targetProviderMessageId: 'wamid.out.1' },
      { kind: 'reaction', emoji: null, targetProviderMessageId: 'wamid.out.1' },
      { kind: 'unsupported', contentType: 'unsupported.view_once' },
      { kind: 'unsupported', contentType: 'unsupported' },
    ]);
  });

  it('video, documents and a media item without a usable reference stay unsupported', () => {
    const { inbound } = parse([
      { id: 'w3', from: '56911111111', type: 'video' },
      { id: 'w4', from: '56911111111', type: 'document' },
      { id: 'w5', from: '56911111111', type: 'image', media: { id: '../../etc/passwd', mimeType: 'image/jpeg' } },
      { id: 'w6', from: '56911111111', type: 'audio', media: { id: 'mid.6', mimeType: 'not a mime' } },
    ]);
    expect(inbound.map((i) => i.content)).toEqual([
      { kind: 'unsupported', contentType: 'video' }, { kind: 'unsupported', contentType: 'document' }, { kind: 'unsupported', contentType: 'image' }, { kind: 'unsupported', contentType: 'audio' },
    ]);
  });

  it('normalizes the provider hash (hex or base64) and ignores anything else', () => {
    const hex = 'ab'.repeat(32);
    expect(mediaSha256(hex.toUpperCase())).toBe(hex);
    expect(mediaSha256(Buffer.from(hex, 'hex').toString('base64'))).toBe(hex);
    expect(mediaSha256('not-a-hash')).toBeNull();
  });
});

describe('WhatsAppMediaDownloader', () => {
  const ref = (mediaId: string, sha256: string | null = null): InboundMediaRef => ({ kind: 'image', mediaId, mimeType: 'image/jpeg', sha256, caption: null, voice: false });
  const download = (mediaId: string, o: { maxBytes?: number; timeoutMs?: number; sha256?: string | null; accountRef?: string } = {}) =>
    new WhatsAppMediaDownloader(config).download(ref(mediaId, o.sha256 ?? null), { accountRef: o.accountRef ?? PHONE, maxBytes: o.maxBytes ?? 1024 * 1024, timeoutMs: o.timeoutMs ?? 2_000 });
  const bytes = Buffer.from([0xff, 0xd8, 0xff, ...Buffer.alloc(500, 3)]);

  it('downloads with the token and verifies the stated hash', async () => {
    provider.hostMedia('ok', { bytes, mimeType: 'image/jpeg' });
    const r = await download('ok');
    expect(r).toMatchObject({ ok: true, mimeType: 'image/jpeg' });
    expect(r.ok && Buffer.from(r.bytes).equals(bytes)).toBe(true);
    expect(provider.mediaRequests.filter((m) => m.mediaId === 'ok').every((m) => m.authorized)).toBe(true);
  });

  it.each([
    ['unknown media', 'missing', {}, {}, 'not_found'],
    ['provider error', 'meta500', { behaviour: 'meta_500' as const }, {}, 'provider_error'],
    ['a URL outside Meta media hosts (the token is never sent there)', 'foreign', { behaviour: 'foreign_url' as const }, {}, 'forbidden_location'],
    ['a redirect (never followed)', 'redirect', { behaviour: 'redirect' as const }, {}, 'provider_error'],
    ['a declared size over the limit', 'big-declared', { fileSize: 10_000_000 }, {}, 'too_large'],
    ['a stated size that lies (streamed bytes counted)', 'big-streamed', { fileSize: 10, behaviour: 'no_length' as const }, { maxBytes: 100 }, 'too_large'],
    ['a hash mismatch', 'tampered', { sha256: 'cd'.repeat(32) }, {}, 'integrity_mismatch'],
    ['a provider that never answers', 'hang', { behaviour: 'hang' as const }, { timeoutMs: 150 }, 'timeout'],
    ['another business number', 'ok', {}, { accountRef: '999999' }, 'forbidden_location'],
  ])('refuses: %s', async (_name, mediaId, hosted, options, reason) => {
    if (mediaId !== 'missing' && mediaId !== 'ok') provider.hostMedia(mediaId, { bytes, mimeType: 'image/jpeg', ...hosted });
    expect(await download(mediaId, options)).toEqual({ ok: false, reason });
  });

  it('the file request is made only after the metadata names an allowed host', async () => {
    provider.mediaRequests.length = 0;
    provider.hostMedia('foreign-2', { bytes, mimeType: 'image/jpeg', behaviour: 'foreign_url' });
    await download('foreign-2');
    expect(provider.mediaRequests).toEqual([{ kind: 'meta', mediaId: 'foreign-2', authorized: true }]);
  });
});
