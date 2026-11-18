import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CanonicalInbound,
  HeaderBag,
  InboundChannelAdapter,
  OutboundChannelAdapter,
  OutboundSubmission,
  ParsedNotification,
  RejectedInbound,
  SubmissionResult,
} from '@r4/live-ops';

/**
 * Web chat channel (ADR-046). The edge (the service behind the website's chat iframe) is the "provider": it owns visitor
 * sessions and consent, signs every notification it sends to R4, and receives R4's replies. This adapter is pure transport:
 * it knows no agent, store, product or cart. The only page information it carries is a validated, explicitly unverified
 * hint appended to the visitor's text (Core's canonical inbound has no structured context field yet).
 *
 * Signature (both directions): `x-r4-web-timestamp: <epoch ms>` and `x-r4-web-signature: sha256=<hex>` where the hex is
 * HMAC-SHA256(secret, `${timestamp}.${rawBody}`). Fails closed on a missing, malformed, stale or wrong signature.
 */
export const WEB_CHANNEL_ID = 'web';
export const WEB_EDGE_CONTRACT_REF = 'r4-web-edge v1 (ADR-046): signed JSON events in, signed text out';
export const WEB_SIGNATURE_HEADER = 'x-r4-web-signature';
export const WEB_TIMESTAMP_HEADER = 'x-r4-web-timestamp';
const PAGES = ['index', 'product', 'category', 'cart', 'search', 'other'] as const;

/** What the agent can say it is doing while it works (ADR-046): a catalog search, Discover, a product or a shipping quote. */
export const WEB_PROGRESS_STEPS = ['search', 'discover', 'product', 'shipping'] as const;
export type WebProgressStep = (typeof WEB_PROGRESS_STEPS)[number];
const SLUG = /^[a-z][a-z0-9.-]{0,63}$/;
const REF = /^[A-Za-z0-9_-]{8,128}$/;
const BEFORE_SEND = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

export interface WebChannelConfig {
  /** The site this deployment serves (the edge's account), e.g. `my-store`. */
  readonly accountRef: string;
  readonly sharedSecret: string;
  /** Base URL of the edge's R4 endpoints (`/r4/v1/outbound`, `/r4/v1/working`). */
  readonly edgeUrl: string;
  readonly maxSkewMs: number;
}

export function loadWebChannelConfig(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean }): WebChannelConfig {
  const accountRef = env.R4_WEB_ACCOUNT_REF?.trim() ?? '';
  const sharedSecret = env.R4_WEB_SHARED_SECRET ?? '';
  const edgeUrl = (env.R4_WEB_EDGE_URL?.trim() ?? '').replace(/\/+$/, '');
  const maxSkewMs = Number(env.R4_WEB_MAX_SKEW_MS ?? 300_000);
  const problems: string[] = [];
  if (!SLUG.test(accountRef)) problems.push('R4_WEB_ACCOUNT_REF must be a slug');
  if (sharedSecret.length < 32) problems.push('R4_WEB_SHARED_SECRET must have at least 32 characters');
  let url: URL | null = null;
  try {
    url = new URL(edgeUrl);
  } catch {
    problems.push('R4_WEB_EDGE_URL must be an absolute URL');
  }
  if (url) {
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) problems.push('R4_WEB_EDGE_URL must be https (http only on loopback)');
    if (!loopback && !options.allowNetwork) problems.push('a non-loopback R4_WEB_EDGE_URL requires R4_PROD_ALLOW_NETWORK=true');
  }
  if (!Number.isInteger(maxSkewMs) || maxSkewMs < 1_000 || maxSkewMs > 900_000) problems.push('R4_WEB_MAX_SKEW_MS must be an integer in [1000, 900000]');
  if (problems.length > 0) throw new Error(`invalid web channel configuration: ${problems.join('; ')}`);
  return Object.freeze({ accountRef, sharedSecret, edgeUrl, maxSkewMs });
}

/** Never echoes the secret. */
export function describeWebChannelConfig(config: WebChannelConfig): Record<string, string> {
  return { channel: WEB_CHANNEL_ID, accountRef: config.accountRef, edgeUrl: config.edgeUrl, sharedSecret: 'set' };
}

export function signWebBody(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')}`;
}

export function verifyWebSignature(secret: string, headers: HeaderBag, rawBody: string, maxSkewMs: number, now = Date.now()): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const timestamp = headers[WEB_TIMESTAMP_HEADER] ?? '';
  const signature = headers[WEB_SIGNATURE_HEADER] ?? '';
  if (!timestamp || !signature) return { ok: false, reason: 'missing_signature' };
  if (!/^\d{13}$/.test(timestamp) || !/^sha256=[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'invalid_signature_format' };
  if (Math.abs(now - Number(timestamp)) > maxSkewMs) return { ok: false, reason: 'stale_signature' };
  const expected = Buffer.from(signWebBody(secret, timestamp, rawBody));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? { ok: true } : { ok: false, reason: 'invalid_signature' };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The page hint, rebuilt from validated values only (an enum and an integer; no free text from the browser). It stays
 * part of the visitor's own message and says so: the browser is not an authority, the agent verifies with its owners.
 */
export function pageHint(context: unknown): string | null {
  if (!isObject(context) || !PAGES.includes(context.page as (typeof PAGES)[number])) return null;
  const parts: string[] = [];
  const productId = positiveId(context.productId);
  if (context.page === 'product' && productId !== null) {
    const variant = positiveId(context.productAttributeId);
    parts.push(`el cliente está viendo la ficha del producto P${String(productId)}${variant !== null ? ` con la opción ${catalogKey(productId, variant)} elegida` : ''}`);
  } else if (context.page === 'cart') {
    parts.push('el cliente está en su carrito');
  } else if (context.page === 'category') {
    parts.push('el cliente está viendo una categoría');
  }
  const cart = itemLines(context.cart);
  if (cart.length) parts.push(`su carrito tiene ${cart.join(', ')}`);
  const kit = itemLines(context.kit);
  if (kit.length) parts.push(`en Mi gym armó ${kit.join(', ')}`);
  return parts.length ? `[Contexto informado por el navegador, no verificado: ${parts.join('; ')}.]` : null;
}

const positiveId = (v: unknown): number | null => (Number.isInteger(v) && (v as number) > 0 && (v as number) < 1e9 ? (v as number) : null);
const catalogKey = (productId: number, variantId: number): string => (variantId > 0 ? `P${String(productId)}-V${String(variantId)}` : `P${String(productId)}`);

/** Up to 10 `{productId, productAttributeId, quantity}` lines rebuilt as catalog keys and quantities; anything else is dropped. */
function itemLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((line: unknown) => {
    if (!isObject(line)) return [];
    const productId = positiveId(line.productId);
    const variantId = line.productAttributeId === 0 ? 0 : positiveId(line.productAttributeId);
    const quantity = line.quantity;
    if (productId === null || variantId === null || !Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 99) return [];
    return [`${catalogKey(productId, variantId)} x${String(quantity)}`];
  });
}

export class WebInboundAdapter implements InboundChannelAdapter {
  readonly channel = WEB_CHANNEL_ID;
  /** One visitor session = one conversation; the edge signs that the sender is the session. */
  readonly directConversations = true;
  readonly #config: WebChannelConfig;
  readonly #now: () => number;

  constructor(config: WebChannelConfig, options: { readonly now?: () => number } = {}) {
    this.#config = config;
    this.#now = options.now ?? Date.now;
  }

  verifySubscription() {
    return { ok: false as const, status: 404, reason: 'no_subscription_handshake' };
  }

  authenticate(rawBody: string, headers: HeaderBag) {
    return verifyWebSignature(this.#config.sharedSecret, headers, rawBody, this.#config.maxSkewMs, this.#now());
  }

  parse(rawBody: string): ParsedNotification {
    const inbound: CanonicalInbound[] = [];
    const rejected: RejectedInbound[] = [];
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { inbound, statuses: [], rejected: [{ providerEventId: null, reason: 'invalid_json' }] };
    }
    if (!isObject(payload) || !Array.isArray(payload.events) || payload.events.length > 20) return { inbound, statuses: [], rejected: [{ providerEventId: null, reason: 'invalid_notification' }] };
    for (const e of payload.events) {
      const id = isObject(e) && typeof e.eventId === 'string' && REF.test(e.eventId) ? e.eventId : null;
      if (!isObject(e) || !id) {
        rejected.push({ providerEventId: id, reason: 'invalid_event' });
        continue;
      }
      if (e.accountRef !== this.#config.accountRef) {
        rejected.push({ providerEventId: id, reason: 'foreign_account' });
        continue;
      }
      const occurred = typeof e.occurredAt === 'string' ? new Date(e.occurredAt) : null;
      const text = typeof e.text === 'string' ? e.text.trim() : '';
      if (e.type !== 'message' || typeof e.conversationRef !== 'string' || !REF.test(e.conversationRef)) rejected.push({ providerEventId: id, reason: 'invalid_event' });
      else if (!occurred || Number.isNaN(occurred.getTime())) rejected.push({ providerEventId: id, reason: 'invalid_timestamp' });
      else if (!text) rejected.push({ providerEventId: id, reason: 'empty_text' });
      else {
        const hint = pageHint(e.context);
        const body = hint ? `${text.slice(0, 8000 - hint.length - 2)}\n\n${hint}` : text.slice(0, 8000);
        inbound.push({
          channel: WEB_CHANNEL_ID, accountRef: this.#config.accountRef, conversationRef: e.conversationRef, senderRef: e.conversationRef, providerEventId: id,
          occurredAt: occurred.toISOString(), content: { kind: 'text', text: body }, metadata: { page: isObject(e.context) && typeof e.context.page === 'string' ? e.context.page.slice(0, 16) : 'none' },
        });
      }
    }
    return { inbound, statuses: [], rejected };
  }
}

export type WebFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * Text back to the edge, ONE submission per call, classified honestly (the delivery owner alone retries). The edge
 * deduplicates by R4's idempotency key, so a retried `not_sent` never doubles a message.
 *   2xx + messageId → accepted · 2xx without → unknown · 429 → not_sent · 400/401/403/404 → rejected
 *   5xx / other → unknown · connection refused/DNS → not_sent · timeout / reset after connect → unknown
 */
export class WebOutboundAdapter implements OutboundChannelAdapter {
  readonly channel = WEB_CHANNEL_ID;
  readonly bindingKind = 'real' as const;
  readonly contractRef = WEB_EDGE_CONTRACT_REF;
  readonly customerWindowMs = null;
  readonly #config: WebChannelConfig;
  readonly #fetch: WebFetch;

  constructor(config: WebChannelConfig, options: { readonly fetch?: WebFetch } = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? (globalThis.fetch);
  }

  async submit(submission: OutboundSubmission, options: { readonly timeoutMs: number }): Promise<SubmissionResult> {
    const started = Date.now();
    const result = (r: Omit<SubmissionResult, 'latencyMs'>): SubmissionResult => ({ ...r, latencyMs: Date.now() - started });
    if (submission.accountRef !== this.#config.accountRef) return result({ outcome: 'rejected', providerMessageId: null, httpStatus: null, errorClass: 'foreign_account', errorCode: null, retryAfterMs: null });
    const body = { outboundId: submission.outboundId, idempotencyKey: submission.idempotencyKey, accountRef: submission.accountRef, conversationRef: submission.recipientRef, text: submission.text };
    const sent = await this.#post('/r4/v1/outbound', body, options.timeoutMs);
    if ('error' in sent) return result(sent.error);
    const { status, json } = sent;
    if (status >= 200 && status < 300) {
      const id = isObject(json) && typeof json.messageId === 'string' && json.messageId ? json.messageId.slice(0, 256) : null;
      return result(id ? { outcome: 'accepted', providerMessageId: id, httpStatus: status, errorClass: null, errorCode: null, retryAfterMs: null } : { outcome: 'unknown', providerMessageId: null, httpStatus: status, errorClass: 'protocol', errorCode: null, retryAfterMs: null });
    }
    const errorCode = isObject(json) && typeof json.error === 'string' ? json.error.slice(0, 32) : null;
    if (status === 429) return result({ outcome: 'not_sent', providerMessageId: null, httpStatus: status, errorClass: 'rate_limited', errorCode, retryAfterMs: null });
    if ([400, 401, 403, 404].includes(status)) return result({ outcome: 'rejected', providerMessageId: null, httpStatus: status, errorClass: status === 404 ? 'conversation_not_found' : status === 400 ? 'invalid_request' : 'auth', errorCode, retryAfterMs: null });
    return result({ outcome: 'unknown', providerMessageId: null, httpStatus: status, errorClass: status >= 500 ? 'provider_5xx' : 'unexpected_status', errorCode, retryAfterMs: null });
  }

  async signalWorking(signal: { readonly accountRef: string; readonly providerEventId: string }, options: { readonly timeoutMs: number }): Promise<boolean> {
    if (signal.accountRef !== this.#config.accountRef) return false;
    const sent = await this.#post('/r4/v1/working', { accountRef: signal.accountRef, eventId: signal.providerEventId }, options.timeoutMs).catch(() => null);
    return sent !== null && !('error' in sent) && sent.status >= 200 && sent.status < 300;
  }

  /**
   * What the agent is doing right now (a read it is making), so the chat can say it instead of only "working".
   * Best effort: never throws, and nothing depends on it. `detail` is display text for the visitor (a catalog name,
   * a commune, the agent's search words), cut to 80 characters.
   */
  async reportProgress(signal: { readonly accountRef: string; readonly providerEventId: string; readonly step: WebProgressStep; readonly detail: string | null }, options: { readonly timeoutMs: number }): Promise<boolean> {
    if (signal.accountRef !== this.#config.accountRef || !WEB_PROGRESS_STEPS.includes(signal.step)) return false;
    const detail = typeof signal.detail === 'string' ? signal.detail.replace(/\p{Cc}+/gu, ' ').trim().slice(0, 80) : '';
    const sent = await this.#post('/r4/v1/working', { accountRef: signal.accountRef, eventId: signal.providerEventId, step: signal.step, ...(detail ? { detail } : {}) }, options.timeoutMs).catch(() => null);
    return sent !== null && !('error' in sent) && sent.status >= 200 && sent.status < 300;
  }

  async #post(path: string, payload: Json, timeoutMs: number): Promise<{ status: number; json: unknown } | { error: Omit<SubmissionResult, 'latencyMs'> }> {
    const raw = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.#fetch(`${this.#config.edgeUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [WEB_TIMESTAMP_HEADER]: timestamp, [WEB_SIGNATURE_HEADER]: signWebBody(this.#config.sharedSecret, timestamp, raw) },
        body: raw,
        signal: controller.signal,
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, json };
    } catch (error) {
      if (controller.signal.aborted) return { error: { outcome: 'unknown', providerMessageId: null, httpStatus: null, errorClass: 'timeout', errorCode: null, retryAfterMs: null } };
      const code = causeCode(error);
      return code && BEFORE_SEND.has(code)
        ? { error: { outcome: 'not_sent', providerMessageId: null, httpStatus: null, errorClass: 'network_before_send', errorCode: code, retryAfterMs: null } }
        : { error: { outcome: 'unknown', providerMessageId: null, httpStatus: null, errorClass: 'network_after_send', errorCode: code, retryAfterMs: null } };
    } finally {
      clearTimeout(timer);
    }
  }
}

function causeCode(error: unknown): string | null {
  const cause = isObject(error) && isObject(error.cause) ? error.cause : isObject(error) ? error : null;
  return cause && typeof cause.code === 'string' ? cause.code.slice(0, 32) : null;
}
