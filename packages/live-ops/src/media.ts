/**
 * Inbound media (images and audio), channel-neutral. An inbound `media` item carries only the provider's REFERENCE to a
 * file. Ingress turns it into the ONE thing the rest of R4 already understands — the participant's text input — through
 * a `MediaPerception` composed by the agent pack (which owns what the text says). No binary ever reaches the task
 * runtime, the model gateway, memory, logs or the database; the file lives in the composing process's memory for the
 * duration of one perception and is dropped.
 *
 * Separation of permissions: the channel adapter's downloader holds the provider token and only downloads; the pack's
 * perception holds its own credentials and only sees bytes; the agent sees only the text and acts only through its
 * governed capabilities. A file is never an authorization.
 */

export type MediaKind = 'image' | 'audio';

export interface InboundMediaRef {
  readonly kind: MediaKind;
  readonly mediaId: string;
  readonly mimeType: string;
  readonly sha256: string | null;
  readonly caption: string | null;
  readonly voice: boolean;
}

const REF_TAG = 'r4-media-ref/v1';

/** What an unsettled media inbound row holds as its content until perception replaces it with the perceived text. */
export function mediaRefContent(ref: InboundMediaRef): string {
  return JSON.stringify({ [REF_TAG]: ref });
}

/** The reference of a NOT-yet-perceived media row; null when the content is already the perceived text. */
export function parseMediaRefContent(content: string): InboundMediaRef | null {
  if (!content.startsWith(`{"${REF_TAG}"`)) return null;
  try {
    const ref = (JSON.parse(content) as Record<string, InboundMediaRef>)[REF_TAG];
    return ref && (ref.kind === 'image' || ref.kind === 'audio') && typeof ref.mediaId === 'string' ? ref : null;
  } catch {
    return null;
  }
}

export type MediaDownloadResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly mimeType: string }
  | { readonly ok: false; readonly reason: 'not_found' | 'too_large' | 'forbidden_location' | 'integrity_mismatch' | 'timeout' | 'provider_error' };

/** The provider's media download (a channel adapter: holds the provider token, downloads only, never interprets). */
export interface InboundMediaDownloader {
  download(ref: InboundMediaRef, options: { readonly accountRef: string; readonly maxBytes: number; readonly timeoutMs: number }): Promise<MediaDownloadResult>;
}

export interface MediaPerceptionResult {
  readonly outcome: 'perceived' | 'degraded';
  readonly reason: string | null;
  /** The participant input text (framed by the pack as untrusted, machine-perceived content). */
  readonly text: string;
  /** Audit metadata only (sizes, hashes, formats, models, timings): never content, bytes or URLs. */
  readonly evidence: Readonly<Record<string, string | number | boolean | null>>;
}

/** One inbound media reference → one input text. Never throws (failures degrade to a text the agent can act on). */
export interface MediaPerception {
  perceive(ref: InboundMediaRef, context: { readonly accountRef: string }): Promise<MediaPerceptionResult>;
}
