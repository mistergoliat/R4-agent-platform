import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresProductionStore } from '@r4/persistence-postgres';
import { LiveOpsTestbed, say } from '../support/live-ops.js';

/**
 * (Platform notice document, Core 0015) A platform notice may carry ONE owner document (a quote PDF): staged byte for
 * byte, sent by the single delivery owner as a document message to the conversation's own contact under the
 * agent-output gates, once per (task, noticeKey), and its bytes purged once the outbound settles. Real production
 * composition over PostgreSQL with the local WhatsApp provider.
 */
const CUSTOMER = '56911113333';
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const SHA = createHash('sha256').update(PDF).digest('hex');
const document = (bytes: Buffer = PDF, sha = SHA) => ({ contentType: 'application/pdf' as const, filename: 'Cotizacion-PC-000099.pdf', sha256: sha, bytes: new Uint8Array(bytes) });
const CAPTION = 'Cotización N° PC-000099 (PDF).';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

async function conversation() {
  const b = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
  bed = b;
  b.next(say('Hola'));
  await b.customer(CUSTOMER, 'wamid.1', 'Hola');
  await b.runAgent();
  await b.deliver();
  return { b, taskId: await b.taskOf(CUSTOMER), store: new PostgresProductionStore(b.pool) };
}
const staged = (b: LiveOpsTestbed, key: string) =>
  b.rows<{ sha256: string; byte_length: number; has_bytes: boolean; purged: boolean }>(
    `select d.sha256, d.byte_length, d.bytes is not null as has_bytes, d.purged_at is not null as purged from outbound_documents d join outbound_messages o using (outbound_id) where o.notice_key = $1`,
    [key],
  );

describe('platform notice with a document (0015)', { timeout: 90_000 }, () => {
  it('sends the exact bytes once to the conversation contact, replays the same key, and purges the bytes once settled', async () => {
    const { b, taskId, store } = await conversation();
    const key = 'sales.quote-document:q-1';
    expect((await store.createPlatformNotice({ taskId, noticeKey: key, text: CAPTION, correlationId: randomUUID(), document: document() })).replayed).toBe(false);
    expect((await store.createPlatformNotice({ taskId, noticeKey: key, text: CAPTION, correlationId: randomUUID(), document: document() })).replayed).toBe(true);
    expect(await staged(b, key)).toEqual([{ sha256: SHA, byte_length: PDF.byteLength, has_bytes: true, purged: false }]);
    await b.deliver();
    await b.deliver();
    const docs = b.provider.sends.filter((s) => s.document !== null);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ to: CUSTOMER, text: CAPTION, document: { filename: 'Cotizacion-PC-000099.pdf' } });
    expect(b.provider.media(docs[0]!.document!.mediaId)?.equals(PDF)).toBe(true);
    expect(b.provider.uploads).toHaveLength(1);
    // Settled (accepted): only the manifest remains.
    expect(await staged(b, key)).toEqual([{ sha256: SHA, byte_length: PDF.byteLength, has_bytes: false, purged: true }]);
  });

  it('refuses bytes that do not match their SHA-256, and the same key with another document', async () => {
    const { taskId, store } = await conversation();
    await expect(store.createPlatformNotice({ taskId, noticeKey: 'sales.quote-document:q-2', text: CAPTION, correlationId: randomUUID(), document: document(PDF, '0'.repeat(64)) })).rejects.toMatchObject({ code: 'document_sha256_mismatch' });
    await store.createPlatformNotice({ taskId, noticeKey: 'sales.quote-document:q-2', text: CAPTION, correlationId: randomUUID(), document: document() });
    const other = Buffer.from('%PDF-1.7\nother\n%%EOF\n');
    await expect(store.createPlatformNotice({ taskId, noticeKey: 'sales.quote-document:q-2', text: CAPTION, correlationId: randomUUID(), document: document(other, createHash('sha256').update(other).digest('hex')) })).rejects.toMatchObject({ code: 'idempotency_key_reused' });
    await expect(store.createPlatformNotice({ taskId, noticeKey: 'sales.quote-document:q-2', text: CAPTION, correlationId: randomUUID() })).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('is held by the kill switch like agent output (nothing uploaded), and sent once autonomy returns', async () => {
    const { b, taskId, store } = await conversation();
    await b.setAutonomy(false);
    await store.createPlatformNotice({ taskId, noticeKey: 'sales.quote-document:q-3', text: CAPTION, correlationId: randomUUID(), document: document() });
    await b.deliver();
    expect(b.provider.uploads).toHaveLength(0);
    expect((await staged(b, 'sales.quote-document:q-3'))[0]!.has_bytes).toBe(true);
    await b.setAutonomy(true);
    await b.rows(`update outbound_messages set next_attempt_at = null where notice_key = 'sales.quote-document:q-3'`);
    await b.deliver();
    expect(b.provider.sends.filter((s) => s.document !== null)).toHaveLength(1);
  });

  it('a failed upload is retried as not sent (one message in the end); a pending document without its bytes is cancelled, never sent as a bare caption', async () => {
    const { b, taskId, store } = await conversation();
    b.provider.scriptMedia({ kind: 'status', status: 503 });
    await store.createPlatformNotice({ taskId, noticeKey: 'sales.quote-document:q-4', text: CAPTION, correlationId: randomUUID(), document: document() });
    await b.deliver();
    expect(b.provider.sends.filter((s) => s.document !== null)).toHaveLength(0);
    await b.rows(`update outbound_messages set next_attempt_at = null where notice_key = 'sales.quote-document:q-4'`);
    await b.deliver();
    expect(b.provider.sends.filter((s) => s.document !== null)).toHaveLength(1);
    expect(b.provider.uploads).toHaveLength(2);

    await store.createPlatformNotice({ taskId, noticeKey: 'sales.quote-document:q-5', text: CAPTION, correlationId: randomUUID(), document: document() });
    await b.rows(`update outbound_documents set bytes = null, purged_at = clock_timestamp() where outbound_id = (select outbound_id from outbound_messages where notice_key = 'sales.quote-document:q-5')`);
    const before = b.provider.sends.length;
    await b.deliver();
    expect(b.provider.sends.length).toBe(before);
    expect((await b.rows<{ status: string; cancel_reason: string }>(`select status, cancel_reason from outbound_messages where notice_key = 'sales.quote-document:q-5'`))[0]).toEqual({ status: 'cancelled', cancel_reason: 'document_unavailable' });
  });

  it('staged bytes that no longer match their SHA-256 are never uploaded nor sent (document_integrity)', async () => {
    const { b, taskId, store } = await conversation();
    await store.createPlatformNotice({ taskId, noticeKey: 'sales.quote-document:q-6', text: CAPTION, correlationId: randomUUID(), document: document() });
    const tampered = Buffer.alloc(PDF.byteLength, 0x41);
    await b.rows(`update outbound_documents set bytes = $1 where outbound_id = (select outbound_id from outbound_messages where notice_key = 'sales.quote-document:q-6')`, [tampered]);
    await b.deliver();
    expect(b.provider.uploads).toHaveLength(0);
    expect(b.provider.sends.filter((s) => s.document !== null)).toHaveLength(0);
    expect((await b.rows<{ status: string; error_class: string }>(`select status, error_class from outbound_messages where notice_key = 'sales.quote-document:q-6'`))[0]).toEqual({ status: 'failed', error_class: 'document_integrity' });
  });
});
