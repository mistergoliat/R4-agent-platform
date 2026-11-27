import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { TRANSCRIPT_LINE_MAX, TRANSCRIPT_MAX_LINES, type CanonicalInbound, type HeaderBag, type InboundChannelAdapter, type ParsedNotification, type SessionTranscriptLine } from '@r4/live-ops';
import { WHATSAPP_CHANNEL_ID, type WhatsAppCloudConfig } from './config.js';
import { normalizeWaId } from './inbound.js';

/**
 * (ADR-068) WhatsApp calls: the second ingress of the WhatsApp channel. The call gateway (r4-voice) answers the call,
 * and when its speech engine hands over a commercial request it posts here WHAT THE CALLER SAID (the final transcript of
 * that turn, never the engine's own words). Each item becomes a `transcript` input of the caller's own WhatsApp
 * conversation (same contact: the number Meta signed in the call). The pack frames it; it is never an ordinary text.
 *
 * Transport only: it knows no agent, product or quote. Signed both ways like the web channel (ADR-046):
 * `x-r4-call-timestamp: <epoch ms>` and `x-r4-call-signature: sha256=<hex>` = HMAC-SHA256(secret, `${timestamp}.${rawBody}`).
 * Served on the gateway's loopback only, at `/v1/channels/whatsapp-call/webhook` (never through the public proxy).
 */
export const WHATSAPP_CALL_ROUTE = 'whatsapp-call';
export const CALL_SIGNATURE_HEADER = 'x-r4-call-signature';
export const CALL_TIMESTAMP_HEADER = 'x-r4-call-timestamp';

export interface WhatsAppCallConfig {
  /** The business number id the call came in on: the only account this ingress serves (= the WhatsApp adapter's). */
  readonly phoneNumberId: string;
  readonly sharedSecret: string;
  readonly maxSkewMs: number;
}

/** Absent R4_WHATSAPP_CALL_SECRET: no call ingress (null). */
export function loadWhatsAppCallConfig(env: Readonly<Record<string, string | undefined>>, whatsapp: WhatsAppCloudConfig): WhatsAppCallConfig | null {
  const secret = env.R4_WHATSAPP_CALL_SECRET ?? '';
  if (secret === '') return null;
  if (secret.length < 32) throw new Error('R4_WHATSAPP_CALL_SECRET must have at least 32 characters');
  const maxSkewMs = Number(env.R4_WHATSAPP_CALL_MAX_SKEW_MS ?? 60_000);
  if (!Number.isInteger(maxSkewMs) || maxSkewMs < 1_000 || maxSkewMs > 600_000) throw new Error('R4_WHATSAPP_CALL_MAX_SKEW_MS must be 1000–600000');
  return { phoneNumberId: whatsapp.phoneNumberId, sharedSecret: secret, maxSkewMs };
}

export function signCallBody(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')}`;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const MAX_TEXT = 4000;

export class WhatsAppCallTranscriptAdapter implements InboundChannelAdapter {
  readonly channel = WHATSAPP_CHANNEL_ID;
  readonly route = WHATSAPP_CALL_ROUTE;
  /** One-to-one: the caller is the conversation (the number Meta signed in the call). */
  readonly directConversations = true;
  /** A trusted internal provider: it reads the reply of the task its input landed on. */
  readonly returnsOutcomes = true;
  readonly #config: WhatsAppCallConfig;
  readonly #now: () => number;

  constructor(config: WhatsAppCallConfig, options: { readonly now?: () => number } = {}) {
    this.#config = config;
    this.#now = options.now ?? Date.now;
  }

  verifySubscription() {
    return { ok: false as const, status: 404, reason: 'no_subscription' };
  }

  authenticate(rawBody: string, headers: HeaderBag) {
    const timestamp = headers[CALL_TIMESTAMP_HEADER] ?? '';
    const signature = headers[CALL_SIGNATURE_HEADER] ?? '';
    if (!timestamp || !signature) return { ok: false as const, reason: 'missing_signature' };
    if (!/^\d{13}$/.test(timestamp) || !/^sha256=[0-9a-f]{64}$/.test(signature)) return { ok: false as const, reason: 'invalid_signature_format' };
    if (Math.abs(this.#now() - Number(timestamp)) > this.#config.maxSkewMs) return { ok: false as const, reason: 'stale_signature' };
    const expected = Buffer.from(signCallBody(this.#config.sharedSecret, timestamp, rawBody));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? { ok: true as const } : { ok: false as const, reason: 'invalid_signature' };
  }

  /** One transcript per notification: `{ callId, turn, from, text, occurredAt }`. */
  parse(rawBody: string): ParsedNotification {
    let p: unknown;
    try {
      p = JSON.parse(rawBody);
    } catch {
      return { inbound: [], statuses: [], rejected: [{ providerEventId: null, reason: 'invalid_json' }] };
    }
    // `{ callId, event: "ended", from, occurredAt }`: the end of a call Don Pesín answered (owner decision 2026-11-26:
    // the only thing the agent writes after a call is a short «¿te pude ayudar?»). A channel event, never content.
    const ended = isObject(p) && p.event === 'ended';
    // (ADR-069) `{ callId, event: "transcript", from, startedAt, endedAt, lines: [{ speaker, at, text }] }`: the whole call,
    // a record of the conversation (never an input).
    const whole = isObject(p) && p.event === 'transcript';
    if (!isObject(p) || typeof p.callId !== 'string' || !/^[A-Za-z0-9._=+/-]{8,512}$/.test(p.callId) || (!ended && !whole && (!Number.isInteger(p.turn) || (p.turn as number) < 1 || (p.turn as number) > 10_000))) {
      return { inbound: [], statuses: [], rejected: [{ providerEventId: null, reason: 'invalid_call_event' }] };
    }
    // The call id is Meta's (long, base64-like): its hash keeps the event identity short and stable.
    const providerEventId = `call:${createHash('sha256').update(p.callId).digest('hex').slice(0, 32)}:${ended ? 'ended' : whole ? 'transcript' : String(p.turn)}`;
    const from = normalizeWaId(p.from);
    if (whole) return this.#transcript(p, providerEventId, from);
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    const at = typeof p.occurredAt === 'string' ? new Date(p.occurredAt) : null;
    if (!from) return { inbound: [], statuses: [], rejected: [{ providerEventId, reason: 'missing_caller' }] };
    if (!ended && text === '') return { inbound: [], statuses: [], rejected: [{ providerEventId, reason: 'empty_transcript' }] };
    if (!at || Number.isNaN(at.getTime())) return { inbound: [], statuses: [], rejected: [{ providerEventId, reason: 'invalid_timestamp' }] };
    const inbound: CanonicalInbound = {
      channel: WHATSAPP_CHANNEL_ID,
      accountRef: this.#config.phoneNumberId,
      conversationRef: from,
      senderRef: from,
      providerEventId,
      occurredAt: at.toISOString(),
      content: ended ? { kind: 'unsupported', contentType: 'call-ended' } : { kind: 'transcript', text: text.slice(0, MAX_TEXT), source: 'call' },
      metadata: ended ? { messageType: 'call_ended' } : { messageType: 'call_transcript', turn: p.turn as number },
    };
    return { inbound: [inbound], statuses: [], rejected: [] };
  }

  /** Over the caps the transcript is cut from the end and marked, never refused (ADR-069 D1). */
  #transcript(p: Json, eventId: string, from: string | null): ParsedNotification {
    const reject = (reason: string): ParsedNotification => ({ inbound: [], statuses: [], rejected: [{ providerEventId: eventId, reason }] });
    if (!from) return reject('missing_caller');
    const started = typeof p.startedAt === 'string' ? new Date(p.startedAt) : null;
    const ended = typeof p.endedAt === 'string' ? new Date(p.endedAt) : null;
    if (!started || !ended || Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime()) || ended < started) return reject('invalid_timestamp');
    if (!Array.isArray(p.lines)) return reject('invalid_transcript');
    const lines: SessionTranscriptLine[] = [];
    // The sender may already have cut it (its own body cap): the mark is kept.
    let truncated = p.truncated === true || p.lines.length > TRANSCRIPT_MAX_LINES;
    for (const l of p.lines.slice(0, TRANSCRIPT_MAX_LINES)) {
      if (!isObject(l) || (l.speaker !== 'contact' && l.speaker !== 'agent') || typeof l.text !== 'string' || typeof l.at !== 'string') return reject('invalid_transcript');
      const at = new Date(l.at);
      if (Number.isNaN(at.getTime())) return reject('invalid_transcript');
      const text = l.text.trim();
      if (text === '') continue;
      if (text.length > TRANSCRIPT_LINE_MAX) truncated = true;
      lines.push({ speaker: l.speaker, at: at.toISOString(), text: text.slice(0, TRANSCRIPT_LINE_MAX) });
    }
    if (lines.length === 0) return reject('empty_transcript');
    // `audit: { delegations, unbacked: [figure] }` (ADR-068 D3), optional; figures are digits only.
    let audit: { delegations: number; unbacked: string[] } | null = null;
    if (p.audit !== undefined && p.audit !== null) {
      const a = p.audit;
      if (!isObject(a) || !Number.isInteger(a.delegations) || (a.delegations as number) < 0 || (a.delegations as number) > 10_000 || !Array.isArray(a.unbacked)
        || a.unbacked.length > 100 || !a.unbacked.every((f): f is string => typeof f === 'string' && /^\d{1,15}$/.test(f))) return reject('invalid_audit');
      audit = { delegations: a.delegations as number, unbacked: a.unbacked };
    }
    return {
      inbound: [], statuses: [], rejected: [],
      transcripts: [{ accountRef: this.#config.phoneNumberId, conversationRef: from, eventId, modality: 'call', startedAt: started.toISOString(), endedAt: ended.toISOString(), lines, truncated, audit }],
    };
  }
}
