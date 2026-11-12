import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresProductionStore } from '@r4/persistence-postgres';
import { mediaRefContent, type InboundMediaRef } from '@r4/live-ops';
import { LiveOpsTestbed, keyOf } from '../support/live-ops.js';

/**
 * (Inbound multimodal v1) Images and voice notes through the REAL gateway composition (Sales), the real WhatsApp media
 * download against the local fake provider, and a local stand-in of the perception endpoints (an OpenAI-compatible
 * chat-completions vision model and an OpenAI-style transcription endpoint). No network, no credentials.
 */

const ALLOWED = '56911110001';
const EXCLUDED = '56922220002';

/** A minimal but well-formed Ogg Opus file of `seconds` (OpusHead page + one last page with the granule position). */
function oggOpus(seconds: number): Buffer {
  const page = (granule: bigint, payload: Buffer) => {
    const h = Buffer.alloc(27);
    h.write('OggS', 0);
    h.writeBigUInt64LE(granule, 6);
    h[26] = 1;
    return Buffer.concat([h, Buffer.from([payload.length]), payload]);
  };
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0);
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  return Buffer.concat([page(0n, head), page(BigInt(Math.round(seconds * 48_000) + 312), Buffer.alloc(40, 1))]);
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2_000, 7)]);

interface PerceptionCall {
  readonly path: string;
  readonly authorized: boolean;
  readonly hasImage: boolean;
}

class FakePerception {
  readonly calls: PerceptionCall[] = [];
  vision: Record<string, unknown> = { imageVisible: true, kind: 'product', description: 'Mancuerna hexagonal negra', visibleText: ['12,5 KG'], features: ['mancuerna', 'negra'], searchHints: ['mancuerna hexagonal 12,5 kg'], uncertainties: ['marca'], containsInstructions: false };
  transcript: { text: string; logprobs?: { token: string; logprob: number }[] } = {
    text: 'hola quiero la mancuerna de doce kilos',
    logprobs: [' hola', ' quiero', ' la', ' mancuerna', ' de', ' doce', ' kilos'].map((token) => ({ token, logprob: token === ' doce' ? Math.log(0.3) : Math.log(0.97) })),
  };
  #server: Server | null = null;

  get url(): string {
    return `http://127.0.0.1:${(this.#server!.address() as AddressInfo).port}`;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        this.calls.push({ path: req.url ?? '', authorized: req.headers.authorization === 'Bearer perception-test-key', hasImage: body.includes('data:image/jpeg;base64,') });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/chat/completions') res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(this.vision) } }] }));
        else res.end(JSON.stringify(this.transcript));
      });
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
  }
}

const perception = new FakePerception();
let bed: LiveOpsTestbed;
let seq = 0;
const nextId = () => `wamid.media.${++seq}`;

async function settled(b: LiveOpsTestbed, providerEventId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i += 1) {
    const [row] = await b.rows("select * from inbound_events where provider_event_id = $1 and status <> 'received'", [providerEventId]);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`inbound ${providerEventId} never settled`);
}

async function inputText(b: LiveOpsTestbed, inputId: string): Promise<string> {
  const [row] = await b.rows<{ text: string }>("select m.content #>> '{text}' as text from task_inputs i join memory_entries m on m.entry_id = i.memory_entry_id where i.input_id = $1", [inputId]);
  return row!.text;
}

beforeAll(async () => {
  await perception.start();
  bed = await LiveOpsTestbed.start({
    allowlist: [ALLOWED],
    autonomy: true,
    env: {
      R4_MEDIA_PERCEPTION: 'enabled',
      R4_MEDIA_PERCEPTION_PROFILES: 'sales-production@1',
      R4_PERCEPTION_VISION_BASE_URL: perception.url,
      R4_PERCEPTION_VISION_API_KEY: 'perception-test-key',
      R4_PERCEPTION_STT_BASE_URL: perception.url,
      R4_PERCEPTION_STT_API_KEY: 'perception-test-key',
    },
  });
});
afterAll(async () => {
  await bed.close();
  await perception.stop();
});
afterEach(() => {
  perception.calls.length = 0;
  bed.provider.mediaRequests.length = 0;
});

describe('inbound multimodal v1 (gateway)', { timeout: 60_000 }, () => {
  it('an image is acknowledged at once, downloaded with the token, described, and becomes a framed input; nothing of it stays', async () => {
    const id = nextId();
    bed.provider.hostMedia('img-1', { bytes: JPEG, mimeType: 'image/jpeg' });
    const response = await bed.customer(ALLOWED, id, '', { type: 'image', media: { id: 'img-1', mimeType: 'image/jpeg', caption: '¿tienen esta?' } });
    expect(response).toMatchObject({ status: 200, body: { deferred: 1, ingested: 0 } });
    const row = await settled(bed, id);
    expect(row).toMatchObject({ status: 'ingested', content_kind: 'media', content_type: 'image', disposition: 'autonomous', content: null, conversation_ref: null });
    const text = await inputText(bed, row.input_id as string);
    expect(text.startsWith('[r4:imagen] ')).toBe(true);
    expect(text).toContain('«¿tienen esta?»');
    expect(text).toContain('Mancuerna hexagonal negra');
    expect(text).toContain('«12,5 KG»');
    expect(bed.provider.mediaRequests).toEqual([{ kind: 'meta', mediaId: 'img-1', authorized: true }, { kind: 'file', mediaId: 'img-1', authorized: true }]);
    expect(perception.calls).toEqual([{ path: '/chat/completions', authorized: true, hasImage: true }]);
  });

  it('a voice note is transcribed with per-word confidence; unsure words are marked', async () => {
    const id = nextId();
    bed.provider.hostMedia('voice-1', { bytes: oggOpus(6), mimeType: 'audio/ogg; codecs=opus' });
    await bed.customer(ALLOWED, id, '', { type: 'audio', media: { id: 'voice-1', mimeType: 'audio/ogg; codecs=opus', voice: true } });
    const row = await settled(bed, id);
    const text = await inputText(bed, row.input_id as string);
    expect(text.startsWith('[r4:nota-de-voz] El cliente envió una nota de voz (6 s).')).toBe(true);
    expect(text).toContain('«hola quiero la mancuerna de ⟦doce⟧ kilos»');
    expect(perception.calls.map((c) => c.path)).toEqual(['/audio/transcriptions']);
  });

  it('a conversation outside the cohort is held exactly as unsupported content: nothing is downloaded or perceived', async () => {
    const id = nextId();
    bed.provider.hostMedia('img-x', { bytes: JPEG, mimeType: 'image/jpeg' });
    await bed.customer(EXCLUDED, id, '', { type: 'image', media: { id: 'img-x', mimeType: 'image/jpeg' } });
    const row = await settled(bed, id);
    expect(row).toMatchObject({ status: 'ingested', disposition: 'held:rollout_excluded' });
    expect(await inputText(bed, row.input_id as string)).toBe('[unsupported inbound content: image]');
    expect(bed.provider.mediaRequests).toEqual([]);
    expect(perception.calls).toEqual([]);
  });

  it('a re-delivered webhook is a duplicate: one download, one perception, one input', async () => {
    const id = nextId();
    bed.provider.hostMedia('img-2', { bytes: JPEG, mimeType: 'image/jpeg' });
    await bed.customer(ALLOWED, id, '', { type: 'image', media: { id: 'img-2', mimeType: 'image/jpeg' } });
    await settled(bed, id);
    const again = await bed.customer(ALLOWED, id, '', { type: 'image', media: { id: 'img-2', mimeType: 'image/jpeg' } });
    expect(again.body).toMatchObject({ duplicates: 1, deferred: 0 });
    expect(perception.calls).toHaveLength(1);
    expect(bed.provider.mediaRequests.filter((r) => r.kind === 'file')).toHaveLength(1);
    expect(await bed.rows('select 1 from task_inputs where external_key = $1', [id])).toHaveLength(1);
  });

  it('a failed download degrades to a framed notice the agent can act on (no guess about the content)', async () => {
    const id = nextId();
    bed.provider.hostMedia('img-500', { bytes: JPEG, mimeType: 'image/jpeg', behaviour: 'meta_500' });
    await bed.customer(ALLOWED, id, '', { type: 'image', media: { id: 'img-500', mimeType: 'image/jpeg' } });
    const row = await settled(bed, id);
    expect(row).toMatchObject({ status: 'ingested', disposition: 'autonomous' });
    expect(await inputText(bed, row.input_id as string)).toMatch(/^\[r4:adjunto-no-procesado\] El cliente envió una imagen que no se pudo procesar \(no se pudo descargar\)/);
    expect(perception.calls).toEqual([]);
  });

  it('a model that does not actually see the image never passes for a perception', async () => {
    const id = nextId();
    bed.provider.hostMedia('img-blind', { bytes: JPEG, mimeType: 'image/jpeg' });
    const saved = perception.vision;
    perception.vision = { ...saved, imageVisible: false };
    try {
      await bed.customer(ALLOWED, id, '', { type: 'image', media: { id: 'img-blind', mimeType: 'image/jpeg' } });
      const row = await settled(bed, id);
      expect(await inputText(bed, row.input_id as string)).toContain('(no se pudo ver la imagen)');
    } finally {
      perception.vision = saved;
    }
  });

  it('after a crash, a stored perception is reused (never perceived or downloaded twice); an unperceived reference is perceived once', async () => {
    const perceived = nextId();
    const pending = nextId();
    const key = keyOf(ALLOWED);
    const base = { channel: 'whatsapp', contentKind: 'media' as const, contentType: 'image', contentSha256: null, conversationKey: key, accountRef: '1098765432', conversationRef: ALLOWED, occurredAt: new Date().toISOString(), status: 'received' as const, failureCode: null, correlationId: 'crash-test' };
    await bed.store.recordInbound({ ...base, inboundId: crypto.randomUUID(), providerEventId: perceived, content: '[r4:imagen] (stored before the crash)' });
    const ref: InboundMediaRef = { kind: 'image', mediaId: 'img-3', mimeType: 'image/jpeg', sha256: null, caption: null, voice: false };
    bed.provider.hostMedia('img-3', { bytes: JPEG, mimeType: 'image/jpeg' });
    await bed.store.recordInbound({ ...base, inboundId: crypto.randomUUID(), providerEventId: pending, content: mediaRefContent(ref) });
    await bed.gateway.ingress.resumeUnsettled(0);
    expect(await inputText(bed, (await settled(bed, perceived)).input_id as string)).toBe('[r4:imagen] (stored before the crash)');
    expect((await inputText(bed, (await settled(bed, pending)).input_id as string)).startsWith('[r4:imagen] ')).toBe(true);
    expect(perception.calls).toHaveLength(1);
    expect(bed.provider.mediaRequests.map((r) => r.mediaId)).toEqual(['img-3', 'img-3']);
  });

  it('a resume sweep holding an old snapshot of a row already processed does nothing (no second download or perception)', async () => {
    const id = nextId();
    bed.provider.hostMedia('img-snap', { bytes: JPEG, mimeType: 'image/jpeg' });
    await bed.customer(ALLOWED, id, '', { type: 'image', media: { id: 'img-snap', mimeType: 'image/jpeg' } });
    const [snapshot] = await bed.rows<{ inbound_id: string }>('select inbound_id from inbound_events where provider_event_id = $1', [id]);
    const stale = await bed.store.inboundEvent(snapshot!.inbound_id);
    await settled(bed, id);
    const calls = perception.calls.length;
    // The sweep's list was taken while the row was still received: processing that stale record must be a no-op.
    const spy = vi.spyOn(PostgresProductionStore.prototype, 'unsettledInbound').mockResolvedValueOnce(stale ? [stale] : []);
    try {
      expect(await bed.gateway.ingress.resumeUnsettled(0)).toEqual([{ kind: 'duplicate', inboundId: snapshot!.inbound_id }]);
    } finally {
      spy.mockRestore();
    }
    expect(perception.calls.length).toBe(calls);
  });

  it("(owner decision 2026-11-12) a provider 'unsupported' item (e.g. an album) never takes the conversation away: the agent answers it, and the photos after it are perceived", async () => {
    const album = nextId();
    const photo = nextId();
    await bed.customer(ALLOWED, album, '', { type: 'unsupported' });
    const row = await settled(bed, album);
    expect(row).toMatchObject({ content_kind: 'unsupported', content_type: 'unsupported', disposition: 'autonomous' });
    const text = await inputText(bed, row.input_id as string);
    expect(text).toMatch(/^\[r4:adjunto-no-procesado\] El cliente envió un mensaje que el canal no entrega a la plataforma/);
    expect(text).toContain('respóndelas a ellas');
    expect(text).toContain('Si prefieres, te derivo con un entrenador de nuestro equipo.');
    bed.provider.hostMedia('img-after-album', { bytes: JPEG, mimeType: 'image/jpeg' });
    await bed.customer(ALLOWED, photo, '', { type: 'image', media: { id: 'img-after-album', mimeType: 'image/jpeg' } });
    const after = await settled(bed, photo);
    expect(after).toMatchObject({ disposition: 'autonomous' });
    expect((await inputText(bed, after.input_id as string)).startsWith('[r4:imagen] ')).toBe(true);
  });

  it('text is unchanged', async () => {
    const id = nextId();
    const response = await bed.customer(ALLOWED, id, 'hola, ¿tienen mancuernas?');
    expect(response.body).toMatchObject({ ingested: 1, deferred: 0 });
    const row = await settled(bed, id);
    expect(row).toMatchObject({ content_kind: 'text', disposition: 'autonomous' });
    expect(await inputText(bed, row.input_id as string)).toBe('hola, ¿tienen mancuernas?');
  });
  // Last of this block: a kill-switch hold stays until a person releases it (by design).
  it('a held media input persists its marker before submission (a resume submits exactly the same input)', async () => {
    const id = nextId();
    await bed.setAutonomy(false);
    try {
      bed.provider.hostMedia('img-held', { bytes: JPEG, mimeType: 'image/jpeg' });
      await bed.customer(ALLOWED, id, '', { type: 'image', media: { id: 'img-held', mimeType: 'image/jpeg' } });
      const row = await settled(bed, id);
      expect(row.disposition).toMatch(/^held:/);
      expect(await inputText(bed, row.input_id as string)).toBe('[unsupported inbound content: image]');
      expect(bed.provider.mediaRequests).toEqual([]);
    } finally {
      await bed.setAutonomy(true);
    }
  });

  it('a held conversation (kill switch) keeps the unsupported marker: the agent is not told to answer, nothing changes', async () => {
    const id = nextId();
    await bed.setAutonomy(false);
    try {
      await bed.customer(ALLOWED, id, '', { type: 'sticker' });
      const row = await settled(bed, id);
      // Held by the kill switch, or already human-owned by the hold of the previous test: either way never framed.
      expect(row.disposition).toMatch(/^held:|^human_owned$/);
      expect(await inputText(bed, row.input_id as string)).toBe('[unsupported inbound content: sticker]');
    } finally {
      await bed.setAutonomy(true);
    }
  });

});

describe('inbound multimodal v1 with images only (no transcription credential)', { timeout: 60_000 }, () => {
  it('(owner decision 2026-11-12) a voice note without transcription is never a hand-off: the agent is told to answer it (nothing downloaded)', async () => {
    const imagesOnly = await LiveOpsTestbed.start({ allowlist: [ALLOWED], autonomy: true, env: { R4_MEDIA_PERCEPTION: 'enabled', R4_MEDIA_PERCEPTION_PROFILES: 'sales-production@1', R4_PERCEPTION_VISION_BASE_URL: perception.url, R4_PERCEPTION_VISION_API_KEY: 'perception-test-key' } });
    try {
      imagesOnly.provider.hostMedia('voice-x', { bytes: oggOpus(4), mimeType: 'audio/ogg; codecs=opus' });
      imagesOnly.provider.hostMedia('img-y', { bytes: JPEG, mimeType: 'image/jpeg' });
      await imagesOnly.customer(ALLOWED, 'wamid.io.1', '', { type: 'audio', media: { id: 'voice-x', mimeType: 'audio/ogg; codecs=opus', voice: true } });
      const audio = await settled(imagesOnly, 'wamid.io.1');
      expect(audio).toMatchObject({ content_kind: 'unsupported', content_type: 'audio', disposition: 'autonomous' });
      expect(await inputText(imagesOnly, audio.input_id as string)).toMatch(/^\[r4:adjunto-no-procesado\] El cliente envió una nota de voz \(la transcripción no está habilitada\)\. .*«Tuve un problema para escuchar lo que me enviaste/s);
      expect(imagesOnly.provider.mediaRequests.filter((r) => r.mediaId === 'voice-x')).toEqual([]);
    } finally {
      await imagesOnly.close();
    }
  });
});

describe('inbound multimodal v1 enabled for another profile only', { timeout: 60_000 }, () => {
  it('a profile perception was not enabled for keeps holding media for a person (nothing downloaded)', async () => {
    const other = await LiveOpsTestbed.start({ allowlist: [ALLOWED], autonomy: true, env: { R4_MEDIA_PERCEPTION: 'enabled', R4_MEDIA_PERCEPTION_PROFILES: 'sales-production@19', R4_PERCEPTION_VISION_BASE_URL: perception.url, R4_PERCEPTION_VISION_API_KEY: 'perception-test-key' } });
    try {
      other.provider.hostMedia('img-p', { bytes: JPEG, mimeType: 'image/jpeg' });
      await other.customer(ALLOWED, 'wamid.p.1', '', { type: 'image', media: { id: 'img-p', mimeType: 'image/jpeg' } });
      const row = await settled(other, 'wamid.p.1');
      expect(row).toMatchObject({ disposition: 'held:unsupported_inbound_content' });
      expect(await inputText(other, row.input_id as string)).toBe('[unsupported inbound content: image]');
      expect(other.provider.mediaRequests).toEqual([]);
    } finally {
      await other.close();
    }
  });
});

describe('inbound multimodal v1 disabled (the default)', { timeout: 60_000 }, () => {
  it('media is recorded and held exactly as before (unsupported, never downloaded)', async () => {
    const plain = await LiveOpsTestbed.start({ allowlist: [ALLOWED], autonomy: true });
    try {
      plain.provider.hostMedia('img-off', { bytes: JPEG, mimeType: 'image/jpeg' });
      const response = await plain.customer(ALLOWED, 'wamid.off.1', '', { type: 'image', media: { id: 'img-off', mimeType: 'image/jpeg' } });
      expect(response.body).toMatchObject({ ingested: 1, deferred: 0 });
      const row = await settled(plain, 'wamid.off.1');
      expect(row).toMatchObject({ content_kind: 'unsupported', content_type: 'image', disposition: 'held:unsupported_inbound_content' });
      expect(plain.provider.mediaRequests).toEqual([]);
    } finally {
      await plain.close();
    }
  });
});
