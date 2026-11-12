import { createHash } from 'node:crypto';
import type { InboundMediaDownloader, InboundMediaRef, MediaDownloadResult } from '@r4/live-ops';
import type { WhatsAppCloudConfig } from './config.js';
import { mediaSha256 } from './inbound.js';

/** Where Meta serves media files (the URL the media endpoint returns); the token is sent to no other host. */
export const WHATSAPP_MEDIA_HOSTS: readonly string[] = Object.freeze(['lookaside.fbsbx.com']);

export type MediaFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isLoopback = (u: URL) => u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';

/**
 * Inbound media download (WhatsApp Cloud API "retrieve media URL" + "download media"):
 *   1. GET {graph}/{version}/{media-id}?phone_number_id=… with the token → { url, mime_type, sha256, file_size };
 *   2. GET url with the token — only when the url is https on Meta's media host (WHATSAPP_MEDIA_HOSTS) or, in tests, the
 *      same loopback host as the fake provider.
 * Redirects are never followed (a 3xx is a failure), the byte count is capped while streaming (the declared size is
 * checked first), one deadline covers both calls, and the provider's SHA-256 is verified when it states one. Never logs
 * or returns the token, the URL or the bytes' content; it only downloads (it never interprets).
 */
export class WhatsAppMediaDownloader implements InboundMediaDownloader {
  readonly #config: WhatsAppCloudConfig;
  readonly #fetch: MediaFetch;
  readonly #hosts: ReadonlySet<string>;

  constructor(config: WhatsAppCloudConfig, options: { readonly fetch?: MediaFetch; readonly mediaHosts?: readonly string[] } = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? (globalThis.fetch);
    this.#hosts = new Set(options.mediaHosts ?? WHATSAPP_MEDIA_HOSTS);
  }

  async download(ref: InboundMediaRef, options: { readonly accountRef: string; readonly maxBytes: number; readonly timeoutMs: number }): Promise<MediaDownloadResult> {
    if (options.accountRef !== this.#config.phoneNumberId) return { ok: false, reason: 'forbidden_location' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const auth = { authorization: `Bearer ${this.#config.accessToken}` };
    try {
      const metaUrl = `${this.#config.graphBaseUrl}/${this.#config.graphVersion}/${encodeURIComponent(ref.mediaId)}?phone_number_id=${encodeURIComponent(this.#config.phoneNumberId)}`;
      const meta = await this.#fetch(metaUrl, { method: 'GET', headers: { ...auth, accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
      if (meta.status === 404) return { ok: false, reason: 'not_found' };
      if (meta.status !== 200) return { ok: false, reason: 'provider_error' };
      const body: unknown = await meta.json().catch(() => null);
      if (!isObject(body) || typeof body.url !== 'string') return { ok: false, reason: 'provider_error' };
      const declaredSize = typeof body.file_size === 'number' ? body.file_size : typeof body.file_size === 'string' && /^\d+$/.test(body.file_size) ? Number(body.file_size) : null;
      if (declaredSize !== null && declaredSize > options.maxBytes) return { ok: false, reason: 'too_large' };
      let target: URL;
      try {
        target = new URL(body.url);
      } catch {
        return { ok: false, reason: 'forbidden_location' };
      }
      const graph = new URL(this.#config.graphBaseUrl);
      const allowed = (target.protocol === 'https:' && this.#hosts.has(target.hostname)) || (isLoopback(graph) && isLoopback(target) && target.host === graph.host);
      if (!allowed || target.username || target.password) return { ok: false, reason: 'forbidden_location' };

      const file = await this.#fetch(target.toString(), { method: 'GET', headers: { ...auth, accept: '*/*', 'user-agent': 'r4-agent-platform' }, redirect: 'manual', signal: controller.signal });
      if (file.status !== 200 || !file.body) return { ok: false, reason: 'provider_error' };
      const length = Number(file.headers.get('content-length') ?? NaN);
      if (Number.isFinite(length) && length > options.maxBytes) {
        controller.abort();
        return { ok: false, reason: 'too_large' };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = (file.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > options.maxBytes) {
          controller.abort();
          return { ok: false, reason: 'too_large' };
        }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks, total);
      const expected = ref.sha256 ?? mediaSha256(body.sha256);
      if (expected && createHash('sha256').update(bytes).digest('hex') !== expected) return { ok: false, reason: 'integrity_mismatch' };
      const mimeType = typeof body.mime_type === 'string' && body.mime_type.length <= 128 ? body.mime_type : ref.mimeType;
      return { ok: true, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mimeType };
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'provider_error' };
    } finally {
      clearTimeout(timer);
      // Releases any response body left unread on an early return (the bytes already read are kept).
      controller.abort();
    }
  }
}
