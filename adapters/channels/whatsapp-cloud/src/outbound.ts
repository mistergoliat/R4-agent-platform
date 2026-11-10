import type { OutboundChannelAdapter, OutboundDocument, OutboundSubmission, SubmissionResult } from '@r4/live-ops';
import { WHATSAPP_CHANNEL_ID, WHATSAPP_CLOUD_CONTRACT_REF, WHATSAPP_CUSTOMER_WINDOW_MS, type WhatsAppCloudConfig } from './config.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Connection failures that prove the request never reached the provider. */
const BEFORE_SEND = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
/** A document message is not attempted with less time than this left of the submission deadline (it is not sent, so it is retried). */
const MIN_MESSAGE_MS = 1000;
/** Meta error code for free-form text outside the 24 h customer-service window. */
const WINDOW_CLOSED_CODES = new Set(['131047']);

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string | FormData; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

/**
 * Outbound side of the WhatsApp Cloud API: ONE submission per call, classified
 * honestly for the delivery owner (which alone decides about retries):
 *
 *   2xx + messages[0].id        accepted
 *   2xx without an id           unknown   (protocol)
 *   429                         not_sent  (rate_limited; Retry-After honored)
 *   400/401/403/404 (+ window)  rejected  (definitive: the provider refused it)
 *   5xx, 408, other             unknown   (the provider may have processed it)
 *   connection refused / DNS / connect timeout      not_sent (never left)
 *   response timeout / reset after connect / other  unknown
 *
 * Replaces the audited CRM behavior of retrying `meta_network_error`
 * (including timeouts) and 5xx, which can duplicate a message Meta already
 * accepted: Meta documents no idempotency key, so exactly-once is never
 * claimed. Never logs or returns the token, the recipient or the body.
 *
 * (Platform notice document) A submission with a document first uploads the file to the business number's media
 * ("upload media"), then sends ONE document message with the text as caption. The upload creates nothing the contact
 * sees, so every upload failure is `not_sent` (or `rejected` when the provider refuses the file); only the message
 * call is classified as above. The file, its media id and the caption are never logged or returned.
 */
export class WhatsAppOutboundAdapter implements OutboundChannelAdapter {
  readonly channel = WHATSAPP_CHANNEL_ID;
  readonly bindingKind = 'real' as const;
  readonly contractRef = WHATSAPP_CLOUD_CONTRACT_REF;
  readonly customerWindowMs = WHATSAPP_CUSTOMER_WINDOW_MS;
  readonly supportsDocuments = true;
  readonly #config: WhatsAppCloudConfig;
  readonly #fetch: FetchLike;

  constructor(config: WhatsAppCloudConfig, options: { fetch?: FetchLike } = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async submit(submission: OutboundSubmission, options: { readonly timeoutMs: number }): Promise<SubmissionResult> {
    const started = Date.now();
    const result = (partial: Omit<SubmissionResult, 'latencyMs'>): SubmissionResult => ({ ...partial, latencyMs: Date.now() - started });
    if (submission.accountRef !== this.#config.phoneNumberId) {
      return result({ outcome: 'rejected', providerMessageId: null, httpStatus: null, errorClass: 'foreign_business_number', errorCode: null, retryAfterMs: null });
    }
    let message: Json = { type: 'text', text: { preview_url: false, body: submission.text } };
    let timeoutMs = options.timeoutMs;
    if (submission.document) {
      const media = await this.#upload(submission.document, options.timeoutMs);
      if (typeof media !== 'string') return result(media);
      // ONE deadline for the whole submission (upload + message), so the dispatch lease still outlives the call.
      timeoutMs = options.timeoutMs - (Date.now() - started);
      if (timeoutMs < MIN_MESSAGE_MS) return result({ outcome: 'not_sent', providerMessageId: null, httpStatus: null, errorClass: 'deadline_before_message', errorCode: null, retryAfterMs: null });
      message = { type: 'document', document: { id: media, filename: submission.document.filename, caption: submission.text } };
    }
    const url = `${this.#config.graphBaseUrl}/${this.#config.graphVersion}/${encodeURIComponent(this.#config.phoneNumberId)}/messages`;
    const body = JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: submission.recipientRef, ...message });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    let raw: string;
    try {
      response = await this.#fetch(url, { method: 'POST', headers: { authorization: `Bearer ${this.#config.accessToken}`, 'content-type': 'application/json' }, body, signal: controller.signal });
      raw = await response.text();
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) return result({ outcome: 'unknown', providerMessageId: null, httpStatus: null, errorClass: 'timeout', errorCode: null, retryAfterMs: null });
      const code = causeCode(error);
      if (code && BEFORE_SEND.has(code)) return result({ outcome: 'not_sent', providerMessageId: null, httpStatus: null, errorClass: 'network_before_send', errorCode: code, retryAfterMs: null });
      return result({ outcome: 'unknown', providerMessageId: null, httpStatus: null, errorClass: 'network_after_send', errorCode: code, retryAfterMs: null });
    }
    clearTimeout(timer);
    const status = response.status;
    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : null;
    const errorCode = error && (typeof error.code === 'number' || typeof error.code === 'string') ? String(error.code).slice(0, 32) : null;
    if (status >= 200 && status < 300) {
      const first = isObject(parsed) && Array.isArray(parsed.messages) && isObject(parsed.messages[0]) ? parsed.messages[0] : null;
      const id = first && typeof first.id === 'string' && first.id.length > 0 ? first.id.slice(0, 256) : null;
      return id
        ? result({ outcome: 'accepted', providerMessageId: id, httpStatus: status, errorClass: null, errorCode: null, retryAfterMs: null })
        : result({ outcome: 'unknown', providerMessageId: null, httpStatus: status, errorClass: 'protocol', errorCode: null, retryAfterMs: null });
    }
    if (status === 429) return result({ outcome: 'not_sent', providerMessageId: null, httpStatus: status, errorClass: 'rate_limited', errorCode, retryAfterMs: retryAfter(response.headers.get('retry-after')) });
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      const errorClass = errorCode && WINDOW_CLOSED_CODES.has(errorCode) ? 'window_closed' : status === 401 ? 'auth' : status === 403 ? 'permission' : 'invalid_request';
      return result({ outcome: 'rejected', providerMessageId: null, httpStatus: status, errorClass, errorCode, retryAfterMs: null });
    }
    return result({ outcome: 'unknown', providerMessageId: null, httpStatus: status, errorClass: status >= 500 ? 'provider_5xx' : 'unexpected_status', errorCode, retryAfterMs: null });
  }

  /** Uploads the document to the business number's media: its media id, or why nothing was sent. */
  async #upload(document: OutboundDocument, timeoutMs: number): Promise<string | Omit<SubmissionResult, 'latencyMs'>> {
    const url = `${this.#config.graphBaseUrl}/${this.#config.graphVersion}/${encodeURIComponent(this.#config.phoneNumberId)}/media`;
    const notSent = (errorClass: string, httpStatus: number | null, errorCode: string | null, retryAfterMs: number | null = null) => ({ outcome: 'not_sent' as const, providerMessageId: null, httpStatus, errorClass, errorCode, retryAfterMs });
    let response: Awaited<ReturnType<FetchLike>>;
    let raw: string;
    try {
      const form = new FormData();
      form.set('messaging_product', 'whatsapp');
      form.set('type', document.contentType);
      form.set('file', new Blob([new Uint8Array(document.bytes)], { type: document.contentType }), document.filename);
      response = await this.#fetch(url, { method: 'POST', headers: { authorization: `Bearer ${this.#config.accessToken}` }, body: form, signal: AbortSignal.timeout(timeoutMs) });
      raw = await response.text();
    } catch (error) {
      return notSent('media_upload_failed', null, causeCode(error));
    }
    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : null;
    const errorCode = error && (typeof error.code === 'number' || typeof error.code === 'string') ? String(error.code).slice(0, 32) : null;
    const status = response.status;
    if (status >= 200 && status < 300 && isObject(parsed) && typeof parsed.id === 'string' && parsed.id.length > 0) return parsed.id;
    if (status === 429) return notSent('rate_limited', status, errorCode, retryAfter(response.headers.get('retry-after')));
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      return { outcome: 'rejected', providerMessageId: null, httpStatus: status, errorClass: status === 401 ? 'auth' : status === 403 ? 'permission' : 'media_rejected', errorCode, retryAfterMs: null };
    }
    return notSent('media_upload_failed', status, errorCode);
  }

  /**
   * Marks the contact's message as read and shows the typing indicator (Cloud API "typing indicators": dismissed when
   * the business replies or after 25 s). Best effort: true only on a 2xx `{"success": true}`; anything else is false.
   */
  async signalWorking(signal: { readonly accountRef: string; readonly providerEventId: string }, options: { readonly timeoutMs: number }): Promise<boolean> {
    if (signal.accountRef !== this.#config.phoneNumberId) return false;
    const url = `${this.#config.graphBaseUrl}/${this.#config.graphVersion}/${encodeURIComponent(this.#config.phoneNumberId)}/messages`;
    const body = JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: signal.providerEventId, typing_indicator: { type: 'text' } });
    try {
      const response = await this.#fetch(url, { method: 'POST', headers: { authorization: `Bearer ${this.#config.accessToken}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(options.timeoutMs) });
      const raw = await response.text();
      return response.status >= 200 && response.status < 300 && /"success"\s*:\s*true/.test(raw);
    } catch {
      return false;
    }
  }
}

function causeCode(error: unknown): string | null {
  const cause = isObject(error) && 'cause' in error ? (error as { cause?: unknown }).cause : null;
  const code = isObject(cause) && typeof cause.code === 'string' ? cause.code : isObject(error) && typeof (error as { code?: unknown }).code === 'string' ? ((error as { code: string }).code) : null;
  return code ? code.slice(0, 64) : null;
}

function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(Math.floor(seconds * 1000), 15 * 60_000) : null;
}
