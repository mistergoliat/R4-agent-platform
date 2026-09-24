import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CanonicalInbound, HeaderBag, InboundChannelAdapter, ParsedNotification, ProviderStatusEvent, RejectedInbound } from '@r4/live-ops';
import { WHATSAPP_CHANNEL_ID, type WhatsAppCloudConfig } from './config.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

/** Meta epoch-seconds timestamp → ISO; null when absent or invalid (never "now": the CRM fallback is not ported). */
export function whatsappTimestamp(value: unknown): string | null {
  const raw = typeof value === 'number' ? value : typeof value === 'string' && /^\d{9,12}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isFinite(raw)) return null;
  const date = new Date(raw * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Digits-only WhatsApp id (ported normalization). */
export function normalizeWaId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const stripped = value.trim().replace(/[\s()-]+/g, '').replace(/^\++/, '');
  return /^\d{5,32}$/.test(stripped) ? stripped : null;
}

const STATUS_MAP: Readonly<Record<string, ProviderStatusEvent['status']>> = { sent: 'accepted', delivered: 'delivered', read: 'read', failed: 'failed' };

/**
 * Inbound side of the WhatsApp Cloud API. Ported from the audited CRM
 * webhook (verification, signature, extraction), with R4 corrections:
 * signature required always; metadata read per `change` (not from the
 * first one); only the canary business number is accepted; a missing or
 * invalid timestamp rejects the item instead of defaulting to now; non-text
 * content is classified `unsupported` (never an empty text); the raw payload
 * never leaves this adapter.
 */
export class WhatsAppInboundAdapter implements InboundChannelAdapter {
  readonly channel = WHATSAPP_CHANNEL_ID;
  readonly #config: WhatsAppCloudConfig;

  constructor(config: WhatsAppCloudConfig) {
    this.#config = config;
  }

  verifySubscription(query: Readonly<Record<string, string | undefined>>) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'] ?? '';
    const challenge = query['hub.challenge'];
    if (mode !== 'subscribe' || !challenge || !safeEqual(token, this.#config.verifyToken)) return { ok: false as const, status: 403, reason: 'verification_failed' };
    return { ok: true as const, body: challenge };
  }

  authenticate(rawBody: string, headers: HeaderBag) {
    const header = headers['x-hub-signature-256'];
    if (!header) return { ok: false as const, reason: 'missing_signature' };
    const [algorithm, digest] = header.split('=', 2);
    if (algorithm !== 'sha256' || !digest || !/^[0-9a-f]{64}$/i.test(digest)) return { ok: false as const, reason: 'invalid_signature_format' };
    const expected = createHmac('sha256', this.#config.appSecret).update(rawBody, 'utf8').digest();
    const actual = Buffer.from(digest, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false as const, reason: 'invalid_signature' };
    return { ok: true as const };
  }

  parse(rawBody: string): ParsedNotification {
    const inbound: CanonicalInbound[] = [];
    const statuses: ProviderStatusEvent[] = [];
    const rejected: RejectedInbound[] = [];
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { inbound, statuses, rejected: [{ providerEventId: null, reason: 'invalid_json' }] };
    }
    if (!isObject(payload) || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
      return { inbound, statuses, rejected: [{ providerEventId: null, reason: 'unsupported_notification_object' }] };
    }
    for (const entry of payload.entry) {
      if (!isObject(entry) || !Array.isArray(entry.changes)) continue;
      for (const change of entry.changes) {
        if (!isObject(change) || change.field !== 'messages' || !isObject(change.value)) continue;
        const value = change.value;
        const phoneNumberId = isObject(value.metadata) ? text(value.metadata.phone_number_id) : null;
        const messages = Array.isArray(value.messages) ? value.messages : [];
        const statusItems = Array.isArray(value.statuses) ? value.statuses : [];
        if (phoneNumberId !== this.#config.phoneNumberId) {
          // Another business number's traffic is never R4's (the production number stays with its current owner).
          for (const m of messages) rejected.push({ providerEventId: isObject(m) ? text(m.id) : null, reason: 'foreign_business_number' });
          continue;
        }
        for (const m of messages) {
          const item = this.#message(m, phoneNumberId);
          if ('reason' in item) rejected.push(item);
          else inbound.push(item);
        }
        for (const s of statusItems) {
          const status = this.#status(s);
          if (status) statuses.push(status);
        }
      }
    }
    return { inbound, statuses, rejected };
  }

  #message(m: unknown, phoneNumberId: string): CanonicalInbound | RejectedInbound {
    if (!isObject(m)) return { providerEventId: null, reason: 'invalid_message_item' };
    const id = text(m.id);
    const from = normalizeWaId(m.from);
    const occurredAt = whatsappTimestamp(m.timestamp);
    const type = typeof m.type === 'string' && /^[a-z_]{1,32}$/.test(m.type) ? m.type : null;
    if (!id) return { providerEventId: null, reason: 'missing_message_id' };
    if (!from) return { providerEventId: id, reason: 'missing_sender' };
    if (!occurredAt) return { providerEventId: id, reason: 'invalid_timestamp' };
    if (!type) return { providerEventId: id, reason: 'missing_message_type' };
    const base = { channel: WHATSAPP_CHANNEL_ID, accountRef: phoneNumberId, conversationRef: from, senderRef: from, providerEventId: id, occurredAt, metadata: { messageType: type, hasContext: isObject(m.context) } };
    if (type === 'text') {
      const body = isObject(m.text) ? text(m.text.body) : null;
      if (!body) return { providerEventId: id, reason: 'empty_text' };
      return { ...base, content: { kind: 'text', text: body.slice(0, 8000) } };
    }
    return { ...base, content: { kind: 'unsupported', contentType: type.replace(/_/g, '-') } };
  }

  #status(s: unknown): ProviderStatusEvent | null {
    if (!isObject(s)) return null;
    const id = text(s.id);
    const mapped = typeof s.status === 'string' ? STATUS_MAP[s.status] : undefined;
    const occurredAt = whatsappTimestamp(s.timestamp);
    if (!id || !mapped || !occurredAt) return null;
    const firstError = Array.isArray(s.errors) && isObject(s.errors[0]) ? s.errors[0] : null;
    const code = firstError && (typeof firstError.code === 'number' || typeof firstError.code === 'string') ? String(firstError.code).slice(0, 32) : null;
    return { channel: WHATSAPP_CHANNEL_ID, providerMessageId: id, status: mapped, occurredAt, eventKey: `${id}:${String(s.status)}:${String(s.timestamp)}`, errorCode: code };
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
