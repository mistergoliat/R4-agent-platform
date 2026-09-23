import type { ModelProvider, ModelRequest } from '@r4/model-gateway';

/**
 * One model call as the live harness saw it: what the adapter returned as
 * the decision document (its visible output — adapters never pass reasoning
 * text on), how the call finished and what it cost. Kept only in live
 * artifacts, for diagnosis: a decision the platform rejects is recorded on
 * its run step without its content (`decision: null`), so without this the
 * exact output that was refused cannot be reconstructed.
 */
export interface RecordedModelCall {
  readonly index: number;
  readonly runId: string | null;
  readonly finishReason: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
  /** The decision document as parsed by the adapter, or null when it produced none. */
  readonly decision: unknown;
  /**
   * When no decision document could be parsed: its structure only, never
   * the text (free text next to a decision can be the model narrating its
   * reasoning, which is never persisted).
   */
  readonly unparsedShape: UnparsedShape | null;
  readonly error: string | null;
}

export interface UnparsedShape {
  readonly chars: number;
  /** Top-level JSON objects found in the text, in order, by their "type" (null when absent). */
  readonly jsonDocuments: readonly (string | null)[];
  /** Characters outside those JSON objects, whitespace excluded. */
  readonly otherTextChars: number;
}

/** Describes unparseable output without keeping any of its text. */
export function shapeOf(content: string): UnparsedShape {
  const jsonDocuments: (string | null)[] = [];
  let other = 0;
  let i = 0;
  while (i < content.length) {
    const end = content[i] === '{' ? balancedEnd(content, i) : -1;
    const parsed = end > 0 ? tryParse(content.slice(i, end + 1)) : undefined;
    if (parsed !== undefined) {
      const type = parsed !== null && typeof parsed === 'object' ? (parsed as { type?: unknown }).type : undefined;
      jsonDocuments.push(typeof type === 'string' ? type : null);
      i = end + 1;
    } else {
      if (!/\s/.test(content[i]!)) other += 1;
      i += 1;
    }
  }
  return { chars: content.length, jsonDocuments, otherTextChars: other };
}

function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Harness-only ModelProvider decorator (never used by a deployed worker):
 * forwards every call unchanged and records its visible output and
 * metadata. It sits outside the gateway, so the platform validates exactly
 * what it would have validated without it.
 */
export class RecordingModelProvider implements ModelProvider {
  readonly providerId: string;
  readonly calls: RecordedModelCall[] = [];
  readonly #inner: ModelProvider;

  constructor(inner: ModelProvider) {
    this.#inner = inner;
    this.providerId = inner.providerId;
  }

  async invoke(request: ModelRequest, signal: AbortSignal): Promise<unknown> {
    const started = Date.now();
    const base = { index: this.calls.length + 1, runId: request.correlation.runId ?? null };
    try {
      const raw = (await this.#inner.invoke(request, signal)) as {
        content?: string | null;
        structuredData?: unknown;
        finishReason?: string;
        usage?: { inputTokens?: number; outputTokens?: number };
      };
      const decision = raw.structuredData ?? null;
      this.calls.push({
        ...base,
        finishReason: raw.finishReason ?? null,
        inputTokens: raw.usage?.inputTokens ?? null,
        outputTokens: raw.usage?.outputTokens ?? null,
        latencyMs: Date.now() - started,
        decision,
        unparsedShape: decision === null && typeof raw.content === 'string' ? shapeOf(raw.content) : null,
        error: null,
      });
      return raw;
    } catch (error) {
      this.calls.push({ ...base, finishReason: null, inputTokens: null, outputTokens: null, latencyMs: Date.now() - started, decision: null, unparsedShape: null, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
