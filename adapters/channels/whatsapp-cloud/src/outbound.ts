import type { OutboundChannelAdapter, OutboundSubmission, SubmissionResult } from '@r4/live-ops';
import { WHATSAPP_CHANNEL_ID, WHATSAPP_CLOUD_CONTRACT_REF, WHATSAPP_CUSTOMER_WINDOW_MS, type WhatsAppCloudConfig } from './config.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Connection failures that prove the request never reached the provider. */
const BEFORE_SEND = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
/** Meta error code for free-form text outside the 24 h customer-service window. */
const WINDOW_CLOSED_CODES = new Set(['131047']);

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

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
 */
export class WhatsAppOutboundAdapter implements OutboundChannelAdapter {
  readonly channel = WHATSAPP_CHANNEL_ID;
  readonly bindingKind = 'real' as const;
  readonly contractRef = WHATSAPP_CLOUD_CONTRACT_REF;
  readonly customerWindowMs = WHATSAPP_CUSTOMER_WINDOW_MS;
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
    const url = `${this.#config.graphBaseUrl}/${this.#config.graphVersion}/${encodeURIComponent(this.#config.phoneNumberId)}/messages`;
    const body = JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: submission.recipientRef, type: 'text', text: { preview_url: false, body: submission.text } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
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
