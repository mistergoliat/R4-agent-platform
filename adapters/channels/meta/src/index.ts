import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CanonicalInbound, HeaderBag, InboundChannelAdapter, OutboundChannelAdapter, OutboundSubmission, ParsedNotification, RejectedInbound, SubmissionResult } from '@r4/live-ops';

/**
 * Meta direct messages (ADR-060): two channels, `facebook` (Messenger, on the store's Facebook Page) and `instagram`
 * (Instagram Direct, on the professional account linked to that Page), one agent each (ADR-053). Both go through the
 * Page with Facebook Login, in the same Meta app as WhatsApp; an adapter instance serves exactly one of them:
 *
 *   in   POST /v1/channels/meta/webhook, `X-Hub-Signature-256` = "sha256=" HMAC-SHA256(app secret, raw body)
 *        object "page" (Messenger) or "instagram" (Instagram Direct), entry[].messaging[] {sender, recipient, timestamp,
 *        message{mid, text, is_echo, is_deleted, is_unsupported, attachments, reply_to}}
 *   out  POST {graph}/{version}/{page-id}/messages, Page access token, {recipient{id}, messaging_type RESPONSE,
 *        message{text}} → {recipient_id, message_id}; Instagram text ≤ 1000 bytes, Messenger ≤ 2000 characters
 *   typing  the same endpoint with sender_action typing_on
 *
 * Verified 2026-11-25 on developers.facebook.com (messenger-platform/webhooks, webhook-events/messages, message-echoes,
 * send-messages, instagram-messaging/webhooks, instagram-api-with-instagram-login/messaging-api). Pure transport: it
 * knows no agent, product or store. Comments and mentions (feed / comments webhooks) are not handled here (ADR-060 M2).
 */
export type MetaSurface = 'facebook' | 'instagram';
export const META_SURFACES: readonly MetaSurface[] = ['facebook', 'instagram'];
export const META_CONTRACT_REF = 'meta:messenger-platform + instagram-messaging via the Page (Facebook Login): webhooks page/instagram messaging[], Send API POST /{page-id}/messages (verified 2026-11-25, ADR-060)';
/** Standard messaging window after the contact's last message (Messenger and Instagram policy). */
export const META_CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const META_DEFAULT_GRAPH_VERSION = 'v25.0';
export const META_DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com';
/** The parameters that connect both channels; everything else has a default or comes from the WhatsApp app. */
export const META_CONNECTION_PARAMETERS = ['R4_META_PAGE_ID', 'R4_META_PAGE_ACCESS_TOKEN', 'R4_META_INSTAGRAM_ACCOUNT_ID'] as const;

/** The webhook object of each channel. */
const OBJECT: Readonly<Record<MetaSurface, string>> = { facebook: 'page', instagram: 'instagram' };
const TEXT_FITS: Readonly<Record<MetaSurface, (s: string) => boolean>> = {
  facebook: (s) => [...s].length <= 2000,
  instagram: (s) => Buffer.byteLength(s, 'utf8') <= 1000,
};
const META_ID = /^\d{5,32}$/;
const BEFORE_SEND = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

export interface MetaChannelConfig {
  readonly pageId: string;
  /** The Instagram professional account linked to the Page; null = the instagram channel cannot be composed. */
  readonly instagramAccountId: string | null;
  readonly pageAccessToken: string;
  readonly appSecret: string;
  readonly verifyToken: string;
  readonly graphVersion: string;
  readonly graphBaseUrl: string;
}

const isLoopback = (url: URL): boolean => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);

/**
 * Fails closed and says exactly what is missing. The app secret and the verify token default to the WhatsApp ones
 * (same Meta app); R4_META_APP_SECRET / R4_META_VERIFY_TOKEN override them for an app of its own.
 */
export function loadMetaChannelConfig(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean; readonly surface?: MetaSurface }): MetaChannelConfig {
  const value = (name: string): string => env[name]?.trim() ?? '';
  const pageId = value('R4_META_PAGE_ID');
  const instagramAccountId = value('R4_META_INSTAGRAM_ACCOUNT_ID');
  const pageAccessToken = value('R4_META_PAGE_ACCESS_TOKEN');
  const appSecret = value('R4_META_APP_SECRET') || value('R4_WHATSAPP_APP_SECRET');
  const verifyToken = value('R4_META_VERIFY_TOKEN') || value('R4_WHATSAPP_VERIFY_TOKEN');
  const graphVersion = value('R4_META_GRAPH_VERSION') || META_DEFAULT_GRAPH_VERSION;
  const rawBase = value('R4_META_GRAPH_BASE_URL') || META_DEFAULT_GRAPH_BASE_URL;
  const problems: string[] = [];
  if (!pageId) problems.push('R4_META_PAGE_ID is missing (the Facebook Page id)');
  else if (!META_ID.test(pageId)) problems.push('R4_META_PAGE_ID must be the numeric Page id');
  if (!pageAccessToken) problems.push('R4_META_PAGE_ACCESS_TOKEN is missing (a Page access token with pages_messaging)');
  if (!instagramAccountId && options.surface === 'instagram') problems.push('R4_META_INSTAGRAM_ACCOUNT_ID is missing (the Instagram professional account id linked to the Page)');
  if (instagramAccountId && !META_ID.test(instagramAccountId)) problems.push('R4_META_INSTAGRAM_ACCOUNT_ID must be the numeric Instagram professional account id');
  if (!appSecret) problems.push('the app secret is missing (R4_WHATSAPP_APP_SECRET of the same Meta app, or R4_META_APP_SECRET)');
  if (!verifyToken) problems.push('the webhook verify token is missing (R4_WHATSAPP_VERIFY_TOKEN, or R4_META_VERIFY_TOKEN)');
  if (!/^v\d{1,3}\.\d{1,3}$/.test(graphVersion)) problems.push('R4_META_GRAPH_VERSION must look like v25.0');
  let base: URL | null = null;
  try {
    base = new URL(rawBase);
  } catch {
    problems.push('R4_META_GRAPH_BASE_URL is not a URL');
  }
  if (base && !isLoopback(base) && !options.allowNetwork) problems.push('a non-local R4_META_GRAPH_BASE_URL requires R4_PROD_ALLOW_NETWORK=true');
  if (base && !isLoopback(base) && base.protocol !== 'https:') problems.push('a non-local R4_META_GRAPH_BASE_URL must use https');
  if (problems.length > 0) throw new Error(`refusing the Meta channel${options.surface ? ` ${options.surface}` : ''}: ${problems.join('; ')}`);
  return Object.freeze({ pageId, instagramAccountId: instagramAccountId || null, pageAccessToken, appSecret, verifyToken, graphVersion, graphBaseUrl: base!.toString().replace(/\/+$/, '') });
}

/** Safe description (no secret). */
export function describeMetaChannelConfig(config: MetaChannelConfig, surface: MetaSurface): Record<string, string | boolean> {
  return {
    channel: surface,
    pageIdSuffix: config.pageId.slice(-4),
    instagram: config.instagramAccountId !== null,
    graphVersion: config.graphVersion,
    graphHost: new URL(config.graphBaseUrl).host,
    pageAccessTokenConfigured: config.pageAccessToken.length > 0,
    appSecretConfigured: config.appSecret.length > 0,
  };
}

/** Which channel an account of this deployment is: the Page (facebook) or the linked Instagram account; null = foreign. */
export function metaSurface(config: MetaChannelConfig, accountRef: string): MetaSurface | null {
  if (accountRef === config.pageId) return 'facebook';
  return config.instagramAccountId !== null && accountRef === config.instagramAccountId ? 'instagram' : null;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const slug = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 40) : '') || 'unknown';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The platform's note on an Instagram message that answers one of the account's stories (the agent cannot see it). */
export const STORY_REPLY_NOTE = '[Nota de la plataforma: este mensaje responde a una historia de la cuenta.]';

export class MetaInboundAdapter implements InboundChannelAdapter {
  readonly channel: MetaSurface;
  /** Direct messages are one to one: the conversation is the sender's Page- or Instagram-scoped id. */
  readonly directConversations = true;
  readonly #config: MetaChannelConfig;

  constructor(config: MetaChannelConfig, surface: MetaSurface) {
    if (surface === 'instagram' && config.instagramAccountId === null) throw new Error('the instagram channel needs R4_META_INSTAGRAM_ACCOUNT_ID');
    this.#config = config;
    this.channel = surface;
  }

  verifySubscription(query: Readonly<Record<string, string | undefined>>) {
    const challenge = query['hub.challenge'];
    if (query['hub.mode'] !== 'subscribe' || !challenge || !safeEqual(query['hub.verify_token'] ?? '', this.#config.verifyToken)) return { ok: false as const, status: 403, reason: 'verification_failed' };
    return { ok: true as const, body: challenge };
  }

  /** Meta signs the raw body exactly as sent (unicode escaped); the HMAC is over those bytes, never a re-serialization. */
  authenticate(rawBody: string, headers: HeaderBag) {
    const header = headers['x-hub-signature-256'];
    if (!header) return { ok: false as const, reason: 'missing_signature' };
    const [algorithm, digest] = header.split('=', 2);
    if (algorithm !== 'sha256' || !digest || !/^[0-9a-f]{64}$/i.test(digest)) return { ok: false as const, reason: 'invalid_signature_format' };
    const expected = createHmac('sha256', this.#config.appSecret).update(rawBody, 'utf8').digest();
    const actual = Buffer.from(digest, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? { ok: true as const } : { ok: false as const, reason: 'invalid_signature' };
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
    if (!isObject(payload) || payload.object !== OBJECT[this.channel] || !Array.isArray(payload.entry)) {
      return { inbound, statuses: [], rejected: [{ providerEventId: null, reason: 'unsupported_notification_object' }] };
    }
    for (const entry of payload.entry) {
      if (!isObject(entry)) continue;
      const accountRef = typeof entry.id === 'string' ? entry.id : '';
      const surface = metaSurface(this.#config, accountRef);
      if (!surface || surface !== this.channel) {
        rejected.push({ providerEventId: null, reason: 'foreign_account' });
        continue;
      }
      // Reads, deliveries, reactions, postbacks and referrals carry no `message`: not inputs (ADR-060 M1).
      for (const item of Array.isArray(entry.messaging) ? entry.messaging : []) {
        if (!isObject(item) || !isObject(item.message)) continue;
        const message = item.message;
        const mid = typeof message.mid === 'string' && message.mid.length > 0 && message.mid.length <= 256 ? message.mid : null;
        // Echoes are what the account itself sent (R4, or a person from the Meta inbox); a deleted message is gone.
        if (message.is_echo === true || message.is_deleted === true) continue;
        const sender = isObject(item.sender) && typeof item.sender.id === 'string' ? item.sender.id : '';
        if (!mid || !META_ID.test(sender) || sender === accountRef) {
          rejected.push({ providerEventId: mid, reason: 'invalid_message' });
          continue;
        }
        const occurred = typeof item.timestamp === 'number' && Number.isFinite(item.timestamp) ? new Date(item.timestamp) : null;
        if (!occurred || Number.isNaN(occurred.getTime())) {
          rejected.push({ providerEventId: mid, reason: 'invalid_timestamp' });
          continue;
        }
        const attachments: unknown[] = Array.isArray(message.attachments) ? message.attachments : [];
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        const base = { channel: surface, accountRef, conversationRef: sender, senderRef: sender, providerEventId: mid, occurredAt: occurred.toISOString(), metadata: {} };
        if (message.is_unsupported === true || (attachments.length > 0 && !text)) {
          const first = attachments[0];
          inbound.push({ ...base, content: { kind: 'unsupported', contentType: `${surface}.${message.is_unsupported === true ? 'unsupported' : slug(isObject(first) ? first.type : null)}` } });
        } else if (text) {
          const story = isObject(message.reply_to) && isObject(message.reply_to.story);
          inbound.push({ ...base, content: { kind: 'text', text: story ? `${text.slice(0, 8000 - STORY_REPLY_NOTE.length - 2)}\n\n${STORY_REPLY_NOTE}` : text.slice(0, 8000) } });
        } else {
          rejected.push({ providerEventId: mid, reason: 'empty_message' });
        }
      }
    }
    return { inbound, statuses: [], rejected };
  }
}

export type MetaFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * Splits a reply into the parts a surface accepts, at paragraph, then line, then word boundaries (a word longer than a
 * part is cut by characters). Most replies fit one part; the definition keeps them short.
 */
export function splitForSurface(text: string, surface: MetaSurface): string[] {
  const fits = TEXT_FITS[surface];
  if (fits(text)) return [text];
  const parts: string[] = [];
  let current = '';
  const push = (piece: string, sep: string) => {
    const joined = current ? `${current}${sep}${piece}` : piece;
    if (fits(joined)) current = joined;
    else {
      if (current) parts.push(current);
      current = piece;
    }
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    if (fits(paragraph)) push(paragraph, '\n\n');
    else
      for (const line of paragraph.split('\n'))
        for (const word of line.split(' ')) {
          if (fits(word)) push(word, ' ');
          else for (const ch of word) push(ch, '');
        }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Text back through the Page, ONE submission per call, classified honestly (the delivery owner alone retries; Meta
 * documents no idempotency key, so exactly-once is never claimed):
 *   2xx + message_id → accepted · 2xx without → unknown · 429 / code 4, 613 (rate) → not_sent
 *   400/401/403/404 → rejected (window_closed for code 10 subcode 2018278) · 5xx / other → unknown
 *   connection refused / DNS → not_sent · timeout / reset after connect → unknown
 * A reply longer than the surface allows goes as consecutive parts: the first part decides the outcome, and a later
 * part that fails leaves it `accepted` with errorClass `partial_delivery` (never retried: that would repeat part one).
 */
export class MetaOutboundAdapter implements OutboundChannelAdapter {
  readonly channel: MetaSurface;
  readonly bindingKind = 'real' as const;
  readonly contractRef = META_CONTRACT_REF;
  readonly customerWindowMs = META_CUSTOMER_WINDOW_MS;
  readonly #config: MetaChannelConfig;
  readonly #fetch: MetaFetch;

  constructor(config: MetaChannelConfig, surface: MetaSurface, options: { readonly fetch?: MetaFetch } = {}) {
    this.#config = config;
    this.channel = surface;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async submit(submission: OutboundSubmission, options: { readonly timeoutMs: number }): Promise<SubmissionResult> {
    const started = Date.now();
    const result = (r: Omit<SubmissionResult, 'latencyMs'>): SubmissionResult => ({ ...r, latencyMs: Date.now() - started });
    const surface = metaSurface(this.#config, submission.accountRef);
    if (!surface || surface !== this.channel) return result({ outcome: 'rejected', providerMessageId: null, httpStatus: null, errorClass: 'foreign_account', errorCode: null, retryAfterMs: null });
    if (!META_ID.test(submission.recipientRef)) return result({ outcome: 'rejected', providerMessageId: null, httpStatus: null, errorClass: 'invalid_recipient', errorCode: null, retryAfterMs: null });
    const parts = splitForSurface(submission.text, surface);
    let first: Omit<SubmissionResult, 'latencyMs'> | null = null;
    for (const part of parts) {
      const left = options.timeoutMs - (Date.now() - started);
      const sent = left < 1000 ? null : await this.#send({ recipient: { id: submission.recipientRef }, messaging_type: 'RESPONSE', message: { text: part } }, left);
      if (first === null) {
        if (!sent) return result({ outcome: 'not_sent', providerMessageId: null, httpStatus: null, errorClass: 'deadline_before_message', errorCode: null, retryAfterMs: null });
        if (sent.outcome !== 'accepted') return result(sent);
        first = sent;
      } else if (!sent || sent.outcome !== 'accepted') {
        return result({ ...first, errorClass: 'partial_delivery', errorCode: sent?.errorCode ?? null });
      }
    }
    return result(first!);
  }

  /** "typing…" in the contact's conversation (Messenger and Instagram dismiss it after ~20 s or at the reply). Best effort. */
  async signalWorking(signal: { readonly accountRef: string; readonly providerEventId: string; readonly conversationRef?: string }, options: { readonly timeoutMs: number }): Promise<boolean> {
    if (metaSurface(this.#config, signal.accountRef) !== this.channel || !signal.conversationRef || !META_ID.test(signal.conversationRef)) return false;
    const sent = await this.#send({ recipient: { id: signal.conversationRef }, sender_action: 'typing_on' }, options.timeoutMs).catch(() => null);
    return sent !== null && sent.httpStatus !== null && sent.httpStatus >= 200 && sent.httpStatus < 300;
  }

  async #send(body: Json, timeoutMs: number): Promise<Omit<SubmissionResult, 'latencyMs'>> {
    const url = `${this.#config.graphBaseUrl}/${this.#config.graphVersion}/${encodeURIComponent(this.#config.pageId)}/messages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number;
    let raw: string;
    try {
      const response = await this.#fetch(url, { method: 'POST', headers: { authorization: `Bearer ${this.#config.pageAccessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      status = response.status;
      raw = await response.text();
    } catch (error) {
      if (controller.signal.aborted) return { outcome: 'unknown', providerMessageId: null, httpStatus: null, errorClass: 'timeout', errorCode: null, retryAfterMs: null };
      const code = causeCode(error);
      return code && BEFORE_SEND.has(code)
        ? { outcome: 'not_sent', providerMessageId: null, httpStatus: null, errorClass: 'network_before_send', errorCode: code, retryAfterMs: null }
        : { outcome: 'unknown', providerMessageId: null, httpStatus: null, errorClass: 'network_after_send', errorCode: code, retryAfterMs: null };
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : null;
    const code = error && (typeof error.code === 'number' || typeof error.code === 'string') ? String(error.code).slice(0, 16) : null;
    const subcode = error && (typeof error.error_subcode === 'number' || typeof error.error_subcode === 'string') ? String(error.error_subcode).slice(0, 16) : null;
    const errorCode = code ? (subcode ? `${code}/${subcode}` : code) : null;
    if (status >= 200 && status < 300) {
      if (!('message' in body)) return { outcome: 'accepted', providerMessageId: null, httpStatus: status, errorClass: null, errorCode: null, retryAfterMs: null };
      const id = isObject(parsed) && typeof parsed.message_id === 'string' && parsed.message_id ? parsed.message_id.slice(0, 256) : null;
      return id ? { outcome: 'accepted', providerMessageId: id, httpStatus: status, errorClass: null, errorCode: null, retryAfterMs: null } : { outcome: 'unknown', providerMessageId: null, httpStatus: status, errorClass: 'protocol', errorCode: null, retryAfterMs: null };
    }
    // Meta reports throttling as 429 or as error codes 4 / 613 (application / calls-per-period limits).
    if (status === 429 || code === '4' || code === '613') return { outcome: 'not_sent', providerMessageId: null, httpStatus: status, errorClass: 'rate_limited', errorCode, retryAfterMs: 60_000 };
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      // ponytail: window code from Meta's error reference (not among the pages verified 2026-11-25); any other 4xx is still a definitive rejection.
      const errorClass = code === '10' && subcode === '2018278' ? 'window_closed' : status === 401 || code === '190' ? 'auth' : status === 403 ? 'permission' : 'invalid_request';
      return { outcome: 'rejected', providerMessageId: null, httpStatus: status, errorClass, errorCode, retryAfterMs: null };
    }
    return { outcome: 'unknown', providerMessageId: null, httpStatus: status, errorClass: status >= 500 ? 'provider_5xx' : 'unexpected_status', errorCode, retryAfterMs: null };
  }
}

function causeCode(error: unknown): string | null {
  const cause = isObject(error) && isObject(error.cause) ? error.cause : isObject(error) ? error : null;
  return cause && typeof cause.code === 'string' ? cause.code.slice(0, 32) : null;
}

export interface MetaConnectionStep {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * The connection check the operator runs after writing the parameters (`production:sales:meta-check`): the token
 * reads the Page, the Instagram account is the one linked to it, and the app is subscribed to the Page's messages.
 * With `subscribe`, it subscribes the Page (POST /{page-id}/subscribed_apps, subscribed_fields=messages) when it is not.
 * Reads only otherwise. Never prints the token.
 */
export async function checkMetaConnection(config: MetaChannelConfig, options: { readonly fetch?: MetaFetch; readonly subscribe?: boolean; readonly timeoutMs?: number } = {}): Promise<{ readonly ok: boolean; readonly steps: readonly MetaConnectionStep[] }> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const graph = async (method: 'GET' | 'POST', path: string): Promise<{ status: number; json: unknown }> => {
    const response = await fetchFn(`${config.graphBaseUrl}/${config.graphVersion}/${path}`, { method, headers: { authorization: `Bearer ${config.pageAccessToken}` }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    try {
      return { status: response.status, json: text ? JSON.parse(text) : null };
    } catch {
      return { status: response.status, json: null };
    }
  };
  const errorOf = (json: unknown): string => (isObject(json) && isObject(json.error) && typeof json.error.message === 'string' ? json.error.message.slice(0, 200) : 'no detail');
  const steps: MetaConnectionStep[] = [];
  const page = await graph('GET', `${encodeURIComponent(config.pageId)}?fields=name,instagram_business_account`).catch((e: unknown) => ({ status: 0, json: { error: { message: String(e) } } }));
  const pageOk = page.status === 200 && isObject(page.json) && page.json.id === config.pageId;
  steps.push({ step: 'page', ok: pageOk, detail: pageOk ? `the token reads the Page «${str((page.json as Json).name)}»` : `the token cannot read Page ${config.pageId} (HTTP ${page.status}: ${errorOf(page.json)})` });
  if (pageOk) {
    const linked = isObject((page.json as Json).instagram_business_account) ? str(((page.json as Json).instagram_business_account as Json).id) : null;
    if (config.instagramAccountId === null) steps.push({ step: 'instagram', ok: true, detail: linked ? `Facebook only; the Page is linked to Instagram account ${linked} (set R4_META_INSTAGRAM_ACCOUNT_ID=${linked} to connect Instagram too)` : 'Facebook only (no Instagram account linked to the Page)' });
    else steps.push({ step: 'instagram', ok: linked === config.instagramAccountId, detail: linked === config.instagramAccountId ? 'the Instagram account is the one linked to the Page' : `R4_META_INSTAGRAM_ACCOUNT_ID is not the account linked to the Page (linked: ${linked ?? 'none'})` });
    const listed = await graph('GET', `${encodeURIComponent(config.pageId)}/subscribed_apps`).catch(() => ({ status: 0, json: null }));
    const apps = isObject(listed.json) && Array.isArray(listed.json.data) ? listed.json.data.filter(isObject) : [];
    let subscribed = apps.some((a) => Array.isArray(a.subscribed_fields) && a.subscribed_fields.includes('messages'));
    if (!subscribed && options.subscribe) {
      const done = await graph('POST', `${encodeURIComponent(config.pageId)}/subscribed_apps?subscribed_fields=messages`).catch(() => ({ status: 0, json: null }));
      subscribed = done.status === 200 && isObject(done.json) && (done.json.success === true || done.json.success === 'true');
      steps.push({ step: 'subscribe', ok: subscribed, detail: subscribed ? 'the app was subscribed to the Page messages' : `subscribing failed (HTTP ${done.status}: ${errorOf(done.json)})` });
    }
    steps.push({ step: 'subscription', ok: subscribed, detail: subscribed ? `subscribed to messages (${apps.map((a) => str(a.name) || str(a.id) || '?').join(', ') || 'this app'})` : listed.status === 200 ? 'the app is not subscribed to the Page messages: run again with --subscribe' : `cannot read the subscriptions (HTTP ${listed.status}: ${errorOf(listed.json)})` });
  }
  return { ok: steps.every((s) => s.ok), steps };
}
