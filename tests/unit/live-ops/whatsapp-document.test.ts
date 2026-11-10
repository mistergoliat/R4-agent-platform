import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WhatsAppOutboundAdapter, loadWhatsAppCloudConfig, type WhatsAppCloudConfig } from '@r4-adapters/whatsapp-cloud';
import { FakeWhatsAppProvider } from '@r4-adapters/whatsapp-cloud/testing';

/**
 * (Platform notice document) The WhatsApp Cloud adapter sends a document as "upload media" + ONE document message
 * with the text as caption. The upload creates nothing the contact sees: every upload failure is not_sent (or
 * rejected when the provider refuses the file) and no message call is made.
 */
const PHONE = '1098765432';
const CONTACT = '56900000001';
const PDF = Buffer.from('%PDF-1.7\nquote document bytes\n%%EOF\n');
const document = { contentType: 'application/pdf' as const, filename: 'Cotizacion-PC-000017.pdf', sha256: createHash('sha256').update(PDF).digest('hex'), bytes: new Uint8Array(PDF) };

let provider: FakeWhatsAppProvider;
let config: WhatsAppCloudConfig;
beforeAll(async () => {
  provider = new FakeWhatsAppProvider({ accessToken: 'token-for-tests' });
  await provider.start();
  config = loadWhatsAppCloudConfig(
    { R4_WHATSAPP_APP_SECRET: 's', R4_WHATSAPP_VERIFY_TOKEN: 'v', R4_WHATSAPP_ACCESS_TOKEN: 'token-for-tests', R4_WHATSAPP_PHONE_NUMBER_ID: PHONE, R4_WHATSAPP_GRAPH_BASE_URL: provider.baseUrl },
    { allowNetwork: false },
  );
});
afterAll(() => provider.stop());
beforeEach(() => {
  provider.sends.length = 0;
  provider.uploads.length = 0;
});

const submit = (timeoutMs = 2000) =>
  new WhatsAppOutboundAdapter(config).submit({ outboundId: 'o1', idempotencyKey: 'k1', accountRef: PHONE, recipientRef: CONTACT, text: 'Cotización N° PC-000017 (PDF).', attempt: 1, document }, { timeoutMs });

describe('WhatsApp document submission', () => {
  it('uploads the exact bytes, then sends one document message to the contact with the caption', async () => {
    expect(new WhatsAppOutboundAdapter(config).supportsDocuments).toBe(true);
    const result = await submit();
    expect(result).toMatchObject({ outcome: 'accepted', errorClass: null });
    expect(provider.uploads).toHaveLength(1);
    expect(provider.uploads[0]).toMatchObject({ authorized: true, type: 'application/pdf', filename: 'Cotizacion-PC-000017.pdf' });
    expect(provider.sends).toHaveLength(1);
    const sent = provider.sends[0]!;
    expect(sent).toMatchObject({ to: CONTACT, text: 'Cotización N° PC-000017 (PDF).', document: { filename: 'Cotizacion-PC-000017.pdf' } });
    expect(provider.media(sent.document!.mediaId)?.equals(PDF)).toBe(true);
    // Nothing of the file, its media id or the recipient is returned.
    expect(JSON.stringify(result)).not.toMatch(/media\.fake|56900000001|quote document bytes/);
  });

  it.each([
    ['rate limited', { kind: 'status' as const, status: 429, retryAfter: '3' }, { outcome: 'not_sent', errorClass: 'rate_limited', retryAfterMs: 3000 }],
    ['refused file', { kind: 'status' as const, status: 400, body: { error: { code: 131053 } } }, { outcome: 'rejected', errorClass: 'media_rejected', errorCode: '131053' }],
    ['provider 5xx', { kind: 'status' as const, status: 503 }, { outcome: 'not_sent', errorClass: 'media_upload_failed' }],
    ['no media id', { kind: 'accept_without_id' as const }, { outcome: 'not_sent', errorClass: 'media_upload_failed' }],
    ['connection dropped', { kind: 'drop' as const }, { outcome: 'not_sent', errorClass: 'media_upload_failed' }],
  ])('an upload failure (%s) sends no message', async (_name, behaviour, expected) => {
    provider.scriptMedia(behaviour);
    expect(await submit()).toMatchObject(expected);
    expect(provider.sends).toHaveLength(0);
  });

  it('an upload timeout sends no message', async () => {
    provider.scriptMedia({ kind: 'hang', ms: 1500 });
    expect(await submit(300)).toMatchObject({ outcome: 'not_sent', errorClass: 'media_upload_failed' });
    expect(provider.sends).toHaveLength(0);
  });

  it('one deadline covers upload and message: an upload that used it up leaves the message unsent (retryable)', async () => {
    const slow = new WhatsAppOutboundAdapter(config, { fetch: async (url, init) => {
      if (url.endsWith('/media')) await new Promise((r) => setTimeout(r, 450));
      const r = await fetch(url, init as RequestInit);
      return { status: r.status, headers: r.headers, text: () => r.text() };
    } });
    const result = await slow.submit({ outboundId: 'o2', idempotencyKey: 'k2', accountRef: PHONE, recipientRef: CONTACT, text: 'x', attempt: 1, document }, { timeoutMs: 1200 });
    expect(result).toMatchObject({ outcome: 'not_sent', errorClass: 'deadline_before_message' });
    expect(provider.sends).toHaveLength(0);
  });

  it('after the upload, the document message is classified like any message (5xx: unknown, never retried by itself)', async () => {
    provider.script({ kind: 'status', status: 500 });
    expect(await submit()).toMatchObject({ outcome: 'unknown', errorClass: 'provider_5xx' });
    expect(provider.uploads).toHaveLength(1);
    expect(provider.sends).toHaveLength(1);
  });
});
