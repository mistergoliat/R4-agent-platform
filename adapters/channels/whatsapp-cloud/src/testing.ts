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
  readonly text: string;
  readonly authorized: boolean;
  /** The wamid returned, when the fake accepted it (also for hang/drop: the fake "processed" it). */
  readonly providerMessageId: string | null;
}

export class FakeWhatsAppProvider {
  readonly sends: FakeSend[] = [];
  #script: FakeSendBehaviour[] = [];
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
    const match = /^\/v\d+\.\d+\/(\d+)\/messages$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !match) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { to?: string; text?: { body?: string } };
    const authorized = req.headers.authorization === `Bearer ${this.#accessToken}`;
    const behaviour = this.#script.shift() ?? { kind: 'accept' };
    const processes = behaviour.kind === 'accept' || behaviour.kind === 'hang' || behaviour.kind === 'drop' || behaviour.kind === 'accept_without_id';
    const providerMessageId = authorized && processes ? `wamid.fake.${++this.#counter}` : null;
    this.sends.push({ phoneNumberId: match[1]!, to: body.to ?? '', text: body.text?.body ?? '', authorized, providerMessageId });
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
