import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import {
  ModelProviderError,
  type ModelCallOptions,
  type ModelError,
  type ModelErrorKind,
  type ModelGateway,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelResult,
} from './types.js';
import type { RequestRateLimiter } from './rate-limit.js';

/** Shape a provider adapter must return. Validated because adapters are fallible. */
const providerResponseSchema = z.object({
  content: z.string().nullable(),
  toolCalls: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1), arguments: z.unknown() }))
    .default([]),
  structuredData: z.unknown().optional(),
  usage: z.object({
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    /** Telemetry only (never part of ModelUsage): the share of the input served from the provider's cache and of the output spent reasoning. Null = not reported. */
    cachedInputTokens: z.int().nonnegative().nullable().default(null),
    reasoningTokens: z.int().nonnegative().nullable().default(null),
  }),
  finishReason: z.enum(['stop', 'tool_calls', 'length', 'content_filter', 'other']),
  modelId: z.string().min(1),
  requestId: z.string().nullable().default(null),
});
export type ProviderResponse = z.input<typeof providerResponseSchema>;

const TIMEOUT = Symbol('timeout');
const CANCELLED = Symbol('cancelled');

export interface DefaultModelGatewayOptions {
  provider: ModelProvider;
  logger: StructuredLogger;
  /**
   * The provider account's request-rate budget for this process (R4_MODEL_MAX_REQUESTS_PER_MINUTE). Absent ⇒ unlimited.
   * A call waits for a start at most its own timeout, else fails `rate_limited` (retryable) without reaching the provider;
   * once started, the provider gets its full timeout, as without a budget. A worker runs one call at a time, so it never
   * waits longer than one window minus its previous call: with the default 60 s timeout its own calls are never refused.
   */
  rateLimiter?: RequestRateLimiter;
}

/**
 * Wraps a single provider with the platform's guarantees:
 * - hard timeout enforced here, even if the provider ignores the abort signal;
 * - every failure classified into a `ModelError` value (no leaked exceptions);
 * - provider responses validated before they reach the runtime;
 * - metadata-only telemetry (no prompt or output text is logged);
 * - optionally, a request-rate budget: a burst waits for capacity instead of meeting the provider's 429.
 *
 * Model routing across providers is intentionally not implemented (deferred).
 */
export class DefaultModelGateway implements ModelGateway {
  readonly #provider: ModelProvider;
  readonly #logger: StructuredLogger;
  readonly #rateLimiter: RequestRateLimiter | undefined;

  constructor(options: DefaultModelGatewayOptions) {
    this.#provider = options.provider;
    this.#logger = options.logger;
    this.#rateLimiter = options.rateLimiter;
  }

  async generate(request: ModelRequest, options: ModelCallOptions = {}): Promise<ModelResult> {
    const providerId = this.#provider.providerId;
    let started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);

    if (!Number.isInteger(request.limits.timeoutMs) || request.limits.timeoutMs <= 0) {
      return this.#fail(request, { kind: 'provider_error', retryable: false, message: 'limits.timeoutMs must be a positive integer', providerId, latencyMs: 0 });
    }
    if (options.signal?.aborted) {
      return this.#fail(request, { kind: 'cancelled', retryable: false, message: 'call cancelled before start', providerId, latencyMs: 0 });
    }

    // latencyMs stays the provider's own time: the wait is reported by model.call.throttled.
    if (this.#rateLimiter) {
      const limiter = this.#rateLimiter;
      const maxWaitMs = request.limits.timeoutMs;
      let waitMs: number | null;
      try {
        waitMs = await limiter.acquire(maxWaitMs, options.signal);
      } catch {
        return this.#fail(request, { kind: 'cancelled', retryable: false, message: 'call cancelled while waiting for provider capacity', providerId, latencyMs: 0 });
      }
      if (waitMs === null || waitMs > 0) {
        emitTelemetry(this.#logger, 'model.call.throttled', { ...request.correlation, providerId, outcome: waitMs === null ? 'refused' : 'waited', waitMs: Math.round(waitMs ?? 0), maxRequests: limiter.maxRequests, windowMs: limiter.windowMs });
      }
      if (waitMs === null) {
        return this.#fail(request, { kind: 'rate_limited', retryable: true, message: `no provider capacity within ${maxWaitMs}ms (local budget: ${limiter.maxRequests} requests per ${limiter.windowMs}ms)`, providerId, latencyMs: 0 });
      }
      started = performance.now();
    }

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let onExternalAbort: (() => void) | undefined;

    const guard = new Promise<typeof TIMEOUT | typeof CANCELLED>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMEOUT);
      }, request.limits.timeoutMs);
      if (options.signal) {
        onExternalAbort = () => {
          controller.abort();
          resolve(CANCELLED);
        };
        options.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    });

    try {
      const raw = await Promise.race([this.#provider.invoke(request, controller.signal), guard]);
      if (raw === TIMEOUT) {
        return this.#fail(request, { kind: 'timeout', retryable: true, message: `model call exceeded ${request.limits.timeoutMs}ms`, providerId, latencyMs: elapsed() });
      }
      if (raw === CANCELLED) {
        return this.#fail(request, { kind: 'cancelled', retryable: false, message: 'model call cancelled', providerId, latencyMs: elapsed() });
      }

      const parsed = providerResponseSchema.safeParse(raw);
      if (!parsed.success) {
        return this.#fail(request, { kind: 'invalid_provider_response', retryable: false, message: `provider response failed validation: ${z.prettifyError(parsed.error)}`, providerId, latencyMs: elapsed() });
      }

      const data = parsed.data;
      const response: ModelResponse = {
        content: data.content,
        toolCalls: data.toolCalls,
        structuredData: data.structuredData,
        usage: { inputTokens: data.usage.inputTokens, outputTokens: data.usage.outputTokens },
        finishReason: data.finishReason,
        latencyMs: elapsed(),
        provider: { providerId, modelId: data.modelId, requestId: data.requestId },
      };
      emitTelemetry(this.#logger, 'model.call.completed', {
        ...request.correlation,
        providerId,
        modelId: response.provider.modelId,
        finishReason: response.finishReason,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedInputTokens: data.usage.cachedInputTokens,
        reasoningTokens: data.usage.reasoningTokens,
        toolCallCount: response.toolCalls.length,
        latencyMs: response.latencyMs,
      });
      return { ok: true, response };
    } catch (error) {
      if (controller.signal.aborted) {
        // The provider rejected because we aborted it; the guard decides why.
        const reason = await guard;
        const kind: ModelErrorKind = reason === TIMEOUT ? 'timeout' : 'cancelled';
        return this.#fail(request, { kind, retryable: kind === 'timeout', message: kind === 'timeout' ? `model call exceeded ${request.limits.timeoutMs}ms` : 'model call cancelled', providerId, latencyMs: elapsed() });
      }
      if (error instanceof ModelProviderError) {
        return this.#fail(request, { kind: error.kind, retryable: error.retryable, message: error.message, providerId, latencyMs: elapsed() });
      }
      const message = error instanceof Error ? error.message : 'unknown provider failure';
      return this.#fail(request, { kind: 'provider_error', retryable: false, message, providerId, latencyMs: elapsed() });
    } finally {
      clearTimeout(timer);
      if (onExternalAbort) options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  #fail(request: ModelRequest, error: ModelError): ModelResult {
    emitTelemetry(this.#logger, 'model.call.failed', {
      ...request.correlation,
      providerId: error.providerId,
      errorKind: error.kind,
      retryable: error.retryable,
      latencyMs: error.latencyMs,
    });
    return { ok: false, error };
  }
}
