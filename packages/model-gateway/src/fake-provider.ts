import type { ProviderResponse } from './gateway.js';
import {
  ModelProviderError,
  type ModelFinishReason,
  type ModelProvider,
  type ModelRequest,
  type ModelUsage,
} from './types.js';

/**
 * One scripted model behavior. Lets tests drive every outcome the runtime must
 * handle without network access or a real vendor.
 */
export type FakeModelStep =
  /** Plain successful completion. */
  | { readonly type: 'text'; readonly content: string; readonly usage?: ModelUsage; readonly finishReason?: ModelFinishReason }
  /** Structured decision/output (validated later by the caller, as with any model). */
  | { readonly type: 'structured'; readonly data: unknown; readonly content?: string | null; readonly usage?: ModelUsage }
  /** Tool calls proposed by the model. */
  | { readonly type: 'tool_calls'; readonly calls: readonly { readonly name: string; readonly arguments: unknown; readonly id?: string }[]; readonly usage?: ModelUsage }
  /** Provider-side failure (5xx, auth, rate limit...). */
  | { readonly type: 'provider_error'; readonly message?: string; readonly retryable?: boolean; readonly kind?: 'provider_error' | 'rate_limited' }
  /**
   * Never completes. With `ignoreAbort`, it also ignores the abort signal, which
   * proves the gateway enforces timeouts even against a misbehaving provider.
   */
  | { readonly type: 'timeout'; readonly ignoreAbort?: boolean }
  /** Returns a response that violates the provider contract. */
  | { readonly type: 'malformed'; readonly raw: unknown };

export type FakeModelScript =
  | readonly FakeModelStep[]
  | ((request: ModelRequest, callIndex: number) => FakeModelStep);

export const FAKE_PROVIDER_ID = 'fake';
export const FAKE_MODEL_ID = 'fake-deterministic-1';

/**
 * Deterministic in-process provider for tests and offline evaluation. Token
 * usage is a deterministic character count, labelled as such — not a real
 * tokenizer.
 */
export class FakeModelProvider implements ModelProvider {
  readonly providerId = FAKE_PROVIDER_ID;
  readonly #script: FakeModelScript;
  readonly #requests: ModelRequest[] = [];

  constructor(script: FakeModelScript) {
    this.#script = script;
  }

  /** Requests received, in order, for assertions. */
  get requests(): readonly ModelRequest[] {
    return this.#requests;
  }

  get callCount(): number {
    return this.#requests.length;
  }

  async invoke(request: ModelRequest, signal: AbortSignal): Promise<unknown> {
    const index = this.#requests.length;
    this.#requests.push(request);
    const step = this.#nextStep(request, index);
    const inputTokens = request.messages.reduce((sum, m) => sum + m.content.length, 0);

    switch (step.type) {
      case 'text':
        return this.#response({
          content: step.content,
          usage: step.usage ?? { inputTokens, outputTokens: step.content.length },
          finishReason: step.finishReason ?? 'stop',
        });
      case 'structured': {
        const serialized = JSON.stringify(step.data) ?? '';
        return this.#response({
          content: step.content ?? null,
          structuredData: step.data,
          usage: step.usage ?? { inputTokens, outputTokens: serialized.length },
          finishReason: 'stop',
        });
      }
      case 'tool_calls':
        return this.#response({
          content: null,
          toolCalls: step.calls.map((call, i) => ({ id: call.id ?? `fake-call-${index}-${i}`, name: call.name, arguments: call.arguments })),
          usage: step.usage ?? { inputTokens, outputTokens: 0 },
          finishReason: 'tool_calls',
        });
      case 'provider_error':
        throw new ModelProviderError(step.kind ?? 'provider_error', step.message ?? 'fake provider failure', step.retryable ?? false);
      case 'timeout':
        return new Promise<never>((_resolve, reject) => {
          if (!step.ignoreAbort) {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }
        });
      case 'malformed':
        return step.raw;
    }
  }

  #nextStep(request: ModelRequest, index: number): FakeModelStep {
    if (typeof this.#script === 'function') return this.#script(request, index);
    const step = this.#script[index];
    if (!step) {
      throw new ModelProviderError('provider_error', `FakeModelProvider script exhausted at call ${index + 1}`, false);
    }
    return step;
  }

  #response(partial: Omit<ProviderResponse, 'modelId' | 'requestId'>): ProviderResponse {
    return { ...partial, modelId: FAKE_MODEL_ID, requestId: `fake-req-${this.#requests.length}` };
  }
}
