import type { ModelRequirements } from '@r4/contracts';

/**
 * Provider-neutral model contracts. Nothing here names a vendor. The kernel
 * (R4-C) will depend on `ModelGateway` only; vendor adapters implement
 * `ModelProvider` behind it.
 */

export interface ModelCallCorrelation {
  readonly correlationId: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly agentId?: string;
}

export type ModelMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string;
  /** For `tool` messages: the tool call this message answers. */
  readonly toolCallId?: string;
}

/** A tool the model may call. Schemas are JSON Schema documents. */
export interface ModelToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type ModelOutputContract =
  | { readonly kind: 'text' }
  | {
      readonly kind: 'json';
      readonly name: string;
      readonly schema: Readonly<Record<string, unknown>>;
    };

export interface ModelRequest {
  readonly correlation: ModelCallCorrelation;
  readonly requirements: ModelRequirements;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolSpec[];
  readonly outputContract: ModelOutputContract;
  readonly limits: {
    readonly timeoutMs: number;
    readonly maxOutputTokens?: number;
  };
}

/** A tool call as proposed by the model. `arguments` is untrusted. */
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type ModelFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelProviderInfo {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestId: string | null;
}

export interface ModelResponse {
  readonly content: string | null;
  readonly toolCalls: readonly ModelToolCall[];
  /**
   * Structured output as produced by the model. UNTRUSTED: callers must
   * validate it (see `parseStructuredOutput`) before acting on it.
   */
  readonly structuredData: unknown;
  readonly usage: ModelUsage;
  readonly finishReason: ModelFinishReason;
  readonly latencyMs: number;
  readonly provider: ModelProviderInfo;
}

export type ModelErrorKind =
  | 'provider_error'
  | 'rate_limited'
  | 'timeout'
  | 'cancelled'
  | 'invalid_provider_response';

export interface ModelError {
  readonly kind: ModelErrorKind;
  readonly retryable: boolean;
  readonly message: string;
  readonly providerId: string;
  readonly latencyMs: number;
}

/** Failures are values, not exceptions: callers must handle every outcome. */
export type ModelResult =
  | { readonly ok: true; readonly response: ModelResponse }
  | { readonly ok: false; readonly error: ModelError };

export interface ModelCallOptions {
  /** External cancellation (e.g. task cancelled). */
  readonly signal?: AbortSignal;
}

/**
 * The only model surface available to the runtime. It returns proposals and
 * data; it has no access to persistence and cannot cause side effects.
 */
export interface ModelGateway {
  generate(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResult>;
}

/**
 * Service-provider interface for vendor adapters. Implementations translate a
 * `ModelRequest` into a vendor call and return a raw response object, which the
 * gateway validates. They may throw `ModelProviderError` to classify failures.
 */
export interface ModelProvider {
  readonly providerId: string;
  invoke(request: ModelRequest, signal: AbortSignal): Promise<unknown>;
}

export class ModelProviderError extends Error {
  readonly kind: 'provider_error' | 'rate_limited';
  readonly retryable: boolean;

  constructor(kind: 'provider_error' | 'rate_limited', message: string, retryable: boolean) {
    super(message);
    this.name = 'ModelProviderError';
    this.kind = kind;
    this.retryable = retryable;
  }
}
