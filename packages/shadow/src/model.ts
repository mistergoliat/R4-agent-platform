import { z } from 'zod';
import type { ModelCallRecord } from '@r4/evaluation';
import { ModelProviderError, type ModelProvider, type ModelRequest } from '@r4/model-gateway';

/**
 * Shadow model recording (R4-H). A ModelProvider decorator that sits
 * OUTSIDE the gateway — the platform validates exactly what it would have
 * validated without it — and records per call: latency, provider-reported
 * tokens, finish reason, and how the call ended. It never keeps output text
 * (a decision the platform accepted is in the step log; unparseable output
 * is kept as its structure only) and never reasoning text.
 *
 * Controlled provider faults: a shadow workload may ask that an upcoming model
 * call fail in a named way (`timeout`, `rate_limited`, `provider_error`,
 * `trailing_prose`). The fault is injected instead of calling the provider
 * and is labeled `injected: true`, so it is never mistaken for the model's
 * own behavior. There is no retry here (ADR-008): recovery, when there is
 * one, is a new run of the platform (ADR-028).
 *
 * Directives queue up, one per upcoming call, in order: two `trailing_prose`
 * make the next two calls invalid; `pass` lets one call through untouched,
 * so a later call can be targeted (e.g. a READ first, then the fault).
 */
export const MODEL_FAULTS = ['timeout', 'rate_limited', 'provider_error', 'trailing_prose', 'pass'] as const;
export type ModelFault = (typeof MODEL_FAULTS)[number];

export const shadowModelCallSchema = z.strictObject({
  index: z.int().positive(),
  runId: z.string().nullable(),
  outcome: z.enum(['decision', 'unparsed', 'error']),
  /** Classified failure (provider_error, rate_limited, timeout, invalid_provider_response, cancelled, unclassified). */
  errorKind: z.string().max(64).nullable(),
  injected: z.boolean(),
  finishReason: z.string().nullable(),
  inputTokens: z.int().nonnegative().nullable(),
  outputTokens: z.int().nonnegative().nullable(),
  reasoningTokens: z.int().nonnegative().nullable(),
  latencyMs: z.int().nonnegative(),
  unparsedShape: z.strictObject({ chars: z.int().nonnegative(), jsonDocuments: z.array(z.string().nullable()), otherTextChars: z.int().nonnegative() }).nullable(),
});
export type ShadowModelCall = z.infer<typeof shadowModelCallSchema>;

export class ShadowRecordingModelProvider implements ModelProvider {
  readonly providerId: string;
  readonly #inner: ModelProvider;
  readonly #calls: ShadowModelCall[] = [];
  readonly #pending: ModelFault[] = [];
  readonly #onCall: ((call: ShadowModelCall) => void) | undefined;

  constructor(inner: ModelProvider, options: { onCall?: (call: ShadowModelCall) => void } = {}) {
    this.#inner = inner;
    this.providerId = inner.providerId;
    this.#onCall = options.onCall;
  }

  get calls(): readonly ShadowModelCall[] {
    return [...this.#calls];
  }

  /** Queues `fault` for the first model call no earlier directive claims (one call per directive). */
  injectNext(fault: ModelFault): void {
    this.#pending.push(fault);
  }

  /** The directive the next call will consume, if any. */
  get pendingFault(): ModelFault | null {
    return this.#pending[0] ?? null;
  }

  async invoke(request: ModelRequest, signal: AbortSignal): Promise<unknown> {
    const started = Date.now();
    const index = this.#calls.length + 1;
    const runId = request.correlation.runId ?? null;
    const directive = this.#pending.shift() ?? null;
    const fault = directive === 'pass' ? null : directive;
    const push = (fields: Omit<ShadowModelCall, 'index' | 'runId' | 'latencyMs' | 'reasoningTokens'>) => {
      const call = shadowModelCallSchema.parse({ index, runId, latencyMs: Math.max(0, Date.now() - started), reasoningTokens: null, ...fields });
      this.#calls.push(call);
      this.#onCall?.(call);
    };
    if (fault !== null) {
      if (fault === 'trailing_prose') {
        const content = '{"type":"respond","content":"(injected)"}\n\nEspero que esto te sirva.';
        push({ outcome: 'unparsed', errorKind: null, injected: true, finishReason: 'stop', inputTokens: 0, outputTokens: 0, unparsedShape: outputShape(content) });
        return { content, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop', modelId: 'injected-fault', requestId: null };
      }
      const kind = fault === 'timeout' ? 'timeout' : fault === 'rate_limited' ? 'rate_limited' : 'provider_error';
      push({ outcome: 'error', errorKind: kind, injected: true, finishReason: null, inputTokens: null, outputTokens: null, unparsedShape: null });
      throw new ModelProviderError(kind, `injected shadow fault: ${fault}`, kind !== 'provider_error');
    }
    try {
      const raw = (await this.#inner.invoke(request, signal)) as { content?: string | null; structuredData?: unknown; finishReason?: string; usage?: { inputTokens?: number; outputTokens?: number } };
      const decision = raw.structuredData;
      const parsed = decision !== undefined && decision !== null;
      push({
        outcome: parsed ? 'decision' : 'unparsed',
        errorKind: null,
        injected: false,
        finishReason: raw.finishReason ?? null,
        inputTokens: raw.usage?.inputTokens ?? null,
        outputTokens: raw.usage?.outputTokens ?? null,
        unparsedShape: !parsed && typeof raw.content === 'string' ? outputShape(raw.content) : null,
      });
      return raw;
    } catch (error) {
      const errorKind = error instanceof ModelProviderError ? error.kind : signal.aborted ? 'cancelled_or_gateway_timeout' : 'unclassified';
      push({ outcome: 'error', errorKind, injected: false, finishReason: null, inputTokens: null, outputTokens: null, unparsedShape: null });
      throw error;
    }
  }
}

/** The G-compatible, metadata-only record of a call (for EvaluationSubject.modelCalls). */
export function toModelCallRecord(call: ShadowModelCall): ModelCallRecord {
  return {
    index: call.index,
    runId: call.runId,
    finishReason: call.finishReason,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    reasoningTokens: call.reasoningTokens,
    latencyMs: call.latencyMs,
    unparsedShape: call.unparsedShape ? { ...call.unparsedShape, jsonDocuments: [...call.unparsedShape.jsonDocuments] } : null,
    error: call.outcome === 'error' ? `${call.injected ? 'injected ' : ''}${call.errorKind ?? 'error'}` : null,
  };
}

/** Structure of an output that did not parse as one decision: never its text. */
export function outputShape(content: string): { chars: number; jsonDocuments: (string | null)[]; otherTextChars: number } {
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
