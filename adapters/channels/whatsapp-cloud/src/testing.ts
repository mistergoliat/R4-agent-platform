import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Local stand-in for the WhatsApp Cloud API (tests and offline validation
 * only; loopback, no network, no credentials). Behaviour is scripted per
 * send call so every delivery path can be exercised deterministically:
 * accepted, rate limited, rejected, 5xx, slow (timeout) or the connection
 * dropped after the request was read (the provider may have processed it).
 */
export type FakeSendBehaviour =
  | { readonly kind: 'accept' }
  | { readonly kind: 'status'; readonly status: number; readonly body?: unknown; readonly retryAfter?: string }
  | { readonly kind: 'hang'; readonly ms: number }
  | { readonly kind: 'drop' }
  | { readonly kind: 'accept_without_id' };

export interface FakeSend {
  readonly phoneNumberId: string;
  readonly to: string;
  /** The text body, or a document's caption. */
  readonly text: string;
  /** A document message: the uploaded media it names and the file name shown. */
  readonly document: { readonly mediaId: string; readonly filename: string } | null;
  readonly authorized: boolean;
  /** The wamid returned, when the fake accepted it (also for hang/drop: the fake "processed" it). */
  readonly providerMessageId: string | null;
}

/** A read receipt / typing indicator request ("status": "read"), recorded apart from message sends. */
export interface FakeWorkingSignal {
  readonly messageId: string;
  readonly typing: boolean;
  readonly authorized: boolean;
}

/** One "upload media" call. */
export interface FakeUpload {
  readonly authorized: boolean;
  readonly type: string;
  readonly filename: string;
  readonly bytes: Buffer;
  /** The media id returned, when the fake accepted it. */
  readonly mediaId: string | null;
}

export class FakeWhatsAppProvider {
  readonly sends: FakeSend[] = [];
  readonly signals: FakeWorkingSignal[] = [];
  readonly uploads: FakeUpload[] = [];
  #script: FakeSendBehaviour[] = [];
  #mediaScript: FakeSendBehaviour[] = [];
  #server: Server | null = null;
  #sockets = new Set<Socket>();
  #counter = 0;
  readonly #accessToken: string;

  constructor(options: { accessToken: string }) {
    this.#accessToken = options.accessToken;
  }

  /** Behaviour of the next send calls, in order; afterwards: accept. */
  script(...behaviours: FakeSendBehaviour[]): void {
    this.#script.push(...behaviours);
  }

  /** Behaviour of the next "upload media" calls, in order; afterwards: accept. */
  scriptMedia(...behaviours: FakeSendBehaviour[]): void {
    this.#mediaScript.push(...behaviours);
  }

  /** The bytes uploaded under a media id (what the contact receives). */
  media(mediaId: string): Buffer | null {
    return this.uploads.find((u) => u.mediaId === mediaId)?.bytes ?? null;
  }

  get baseUrl(): string {
    const address = this.#server?.address() as AddressInfo | null;
    if (!address) throw new Error('fake provider not started');
    return `http://127.0.0.1:${address.port}`;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    this.#server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
    this.#server = null;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const authorized = req.headers.authorization === `Bearer ${this.#accessToken}`;
    if (req.method === 'POST' && /^\/v\d+\.\d+\/(\d+)\/media$/.test(req.url ?? '')) {
      await this.#upload(req, res, Buffer.concat(chunks), authorized);
      return;
    }
    const match = /^\/v\d+\.\d+\/(\d+)\/messages$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !match) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { to?: string; text?: { body?: string }; document?: { id?: string; filename?: string; caption?: string }; status?: string; message_id?: string; typing_indicator?: { type?: string } };
    if (body.status === 'read') {
      this.signals.push({ messageId: body.message_id ?? '', typing: body.typing_indicator?.type === 'text', authorized });
      res.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(authorized ? { success: true } : { error: { code: 190 } }));
      return;
    }
    const behaviour = this.#script.shift() ?? { kind: 'accept' };
    const processes = behaviour.kind === 'accept' || behaviour.kind === 'hang' || behaviour.kind === 'drop' || behaviour.kind === 'accept_without_id';
    const providerMessageId = authorized && processes ? `wamid.fake.${++this.#counter}` : null;
    const document = body.document ? { mediaId: body.document.id ?? '', filename: body.document.filename ?? '' } : null;
    this.sends.push({ phoneNumberId: match[1]!, to: body.to ?? '', text: body.text?.body ?? body.document?.caption ?? '', document, authorized, providerMessageId });
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 190, message: 'invalid token' } }));
      return;
    }
    switch (behaviour.kind) {
      case 'accept':
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: providerMessageId }] }));
        return;
      case 'accept_without_id':
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ messaging_product: 'whatsapp' }));
        return;
      case 'status':
        res.writeHead(behaviour.status, { 'content-type': 'application/json', ...(behaviour.retryAfter ? { 'retry-after': behaviour.retryAfter } : {}) }).end(JSON.stringify(behaviour.body ?? { error: { code: behaviour.status } }));
        return;
      case 'hang':
        setTimeout(() => {
          if (!res.writableEnded && !res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ messages: [{ id: providerMessageId }] }));
        }, behaviour.ms);
        return;
      case 'drop':
        req.socket.destroy();
        return;
    }
  }

  async #upload(req: IncomingMessage, res: ServerResponse, raw: Buffer, authorized: boolean): Promise<void> {
    const form = await new Request('http://fake.local/media', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: raw }).formData();
    const file = form.get('file');
    const bytes = file instanceof Blob ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
    const behaviour = authorized ? (this.#mediaScript.shift() ?? { kind: 'accept' }) : { kind: 'status' as const, status: 401, body: { error: { code: 190 } } };
    const mediaId = behaviour.kind === 'accept' ? `media.fake.${++this.#counter}` : null;
    this.uploads.push({ authorized, type: typeof form.get('type') === 'string' ? (form.get('type') as string) : '', filename: file instanceof File ? file.name : '', bytes, mediaId });
    switch (behaviour.kind) {
      case 'accept':
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: mediaId }));
        return;
      case 'accept_without_id':
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({}));
        return;
      case 'status':
        res.writeHead(behaviour.status, { 'content-type': 'application/json', ...('retryAfter' in behaviour && behaviour.retryAfter ? { 'retry-after': behaviour.retryAfter } : {}) }).end(JSON.stringify(behaviour.body ?? { error: { code: behaviour.status } }));
        return;
      case 'hang':
        setTimeout(() => {
          if (!res.writableEnded && !res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'media.fake.late' }));
        }, behaviour.ms);
        return;
      case 'drop':
        req.socket.destroy();
        return;
    }
  }
}

/** Signs a notification exactly like the provider (X-Hub-Signature-256 over the raw body). */
export function signNotification(appSecret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
}

export interface NotificationMessage {
  readonly id: string;
  readonly from: string;
  readonly timestamp?: number;
  readonly text?: string;
  readonly type?: string;
}

export interface NotificationStatus {
  readonly id: string;
  readonly status: 'sent' | 'delivered' | 'read' | 'failed';
  readonly timestamp?: number;
  readonly recipientId: string;
  readonly errorCode?: number;
}

/** A provider-shaped `messages` notification (official field names). */
export function notification(phoneNumberId: string, items: { messages?: readonly NotificationMessage[]; statuses?: readonly NotificationStatus[] }): string {
  const now = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-test',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
              contacts: (items.messages ?? []).map((m) => ({ profile: { name: 'Test Contact' }, wa_id: m.from })),
              messages: (items.messages ?? []).map((m) => {
                const type = m.type ?? 'text';
                return type === 'text'
                  ? { from: m.from, id: m.id, timestamp: String(m.timestamp ?? now), type, text: { body: m.text ?? '' } }
                  : { from: m.from, id: m.id, timestamp: String(m.timestamp ?? now), type, [type]: { id: `media-${m.id}`, mime_type: 'image/jpeg' } };
              }),
              statuses: (items.statuses ?? []).map((s) => ({
                id: s.id, status: s.status, timestamp: String(s.timestamp ?? now), recipient_id: s.recipientId,
                ...(s.errorCode ? { errors: [{ code: s.errorCode, title: 'failure' }] } : {}),
              })),
            },
          },
        ],
      },
    ],
  });
}
