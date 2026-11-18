import { z } from 'zod';
import { ModelProviderError, type ModelFinishReason, type ModelProvider, type ModelRequest, type ProviderResponse } from '@r4/model-gateway';
import type { OpenAICompatibleConfig } from './config.js';
import { estimateTokens, jsonDocumentOf, renderMessages } from './render.js';

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** The part of a chat-completions answer the adapter maps; everything else (incl. any reasoning text) is ignored. */
const completionSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(z.unknown()).optional() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  // The detail fields are read leniently (see `count`): a server that omits or mangles them never fails the call.
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      prompt_cache_hit_tokens: z.unknown().optional(),
      prompt_tokens_details: z.object({ cached_tokens: z.unknown().optional() }).nullable().optional().catch(undefined),
      completion_tokens_details: z.object({ reasoning_tokens: z.unknown().optional() }).nullable().optional().catch(undefined),
    })
    .optional(),
});

const MAX_ERROR_TEXT = 300;

/**
 * ModelProvider for OpenAI-compatible chat-completions endpoints. Everything
 * vendor-specific stays here: the HTTP schema, the rendering of the
 * CompiledContext into messages, structured-output quirks, usage fields,
 * finish reasons and error statuses. Core sees only ModelProvider /
 * ModelGateway values.
 *
 * - Physical envelope: a request whose estimated input plus reserved output
 *   exceeds `contextWindowTokens` is refused explicitly
 *   (`model_envelope_exceeded`), never truncated. With a provider-managed
 *   output limit nothing is reserved: only the input is checked, and no
 *   `max_tokens` is sent.
 * - Errors are classified: 429 → rate_limited; 408/504 and the adapter's own
 *   deadline → timeout; 5xx and transport failures → provider_error
 *   (retryable); other 4xx → provider_error (not retryable); an answer that
 *   cannot be mapped → invalid_provider_response.
 * - Secrets: the API key goes only into the Authorization header of the
 *   outgoing request. It is never part of an error message, a response, a
 *   log line or anything the platform persists.
 * - Decisions stay R4's structured protocol (ADR-008): no native tools are
 *   sent; tool calls a server returns anyway are ignored.
 */
export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly providerId: string;
  readonly #config: OpenAICompatibleConfig;
  readonly #fetch: FetchLike;

  constructor(config: OpenAICompatibleConfig, options: { fetch?: FetchLike } = {}) {
    this.#config = config;
    this.providerId = `openai-compatible.${config.profile}`;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async invoke(request: ModelRequest, signal: AbortSignal): Promise<ProviderResponse> {
    const config = this.#config;
    const messages = renderMessages(request, config.renderOrder ?? 'compiled');
    const maxTokens = outputCeiling(request.limits.maxOutputTokens, config.maxOutputTokens);
    const estimated = estimateTokens(messages);
    if (estimated + (maxTokens ?? 0) > config.contextWindowTokens) {
      throw new ModelProviderError(
        'provider_error',
        maxTokens === null
          ? `model_envelope_exceeded: estimated ${estimated} input tokens exceed the ${config.contextWindowTokens}-token window of profile ${config.profile}`
          : `model_envelope_exceeded: estimated ${estimated} input tokens + ${maxTokens} reserved output exceed the ${config.contextWindowTokens}-token window of profile ${config.profile}`,
        false,
      );
    }
    // Deployment extras first: the fields the adapter owns always win (config validation also refuses them).
    const body = {
      ...config.extraBody,
      model: config.model,
      messages,
      ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
      stream: false,
      ...(config.temperature === null ? {} : { temperature: config.temperature }),
      ...(config.responseFormat === 'json_object' && request.outputContract.kind === 'json' ? { response_format: { type: 'json_object' } } : {}),
    };
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (config.apiKey !== null) headers.authorization = `Bearer ${config.apiKey}`;

    const deadline = AbortSignal.timeout(config.timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      response = await this.#fetch(`${config.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.any([signal, deadline]) });
      text = await response.text();
    } catch (error) {
      // The gateway's own abort (its timeout or a cancellation) is the gateway's to classify.
      if (signal.aborted) throw error;
      if (deadline.aborted) throw new ModelProviderError('timeout', `no answer within the ${config.timeoutMs}ms transport deadline of profile ${config.profile}`, true);
      throw new ModelProviderError('provider_error', `transport failure: ${safeText(error instanceof Error ? error.message : String(error), config)}`, true);
    }

    if (!response.ok) throw classifyStatus(response.status, text, config);
    let parsed: z.infer<typeof completionSchema>;
    try {
      const document = completionSchema.safeParse(JSON.parse(text));
      if (!document.success) throw new Error('unexpected shape');
      parsed = document.data;
    } catch {
      throw new ModelProviderError('invalid_provider_response', `profile ${config.profile}: the answer is not a chat completion`, false);
    }
    const choice = parsed.choices[0]!;
    const content = typeof choice.message.content === 'string' ? choice.message.content : null;
    const structured = request.outputContract.kind === 'json' ? jsonDocumentOf(content) : undefined;
    return {
      content,
      toolCalls: [],
      ...(structured === undefined ? {} : { structuredData: structured }),
      usage: {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
        // Counts only (telemetry): where the latency and the cost of a call come from. The reasoning text is still never kept.
        cachedInputTokens: count(parsed.usage?.prompt_tokens_details?.cached_tokens) ?? count(parsed.usage?.prompt_cache_hit_tokens),
        reasoningTokens: count(parsed.usage?.completion_tokens_details?.reasoning_tokens),
      },
      finishReason: finishReasonOf(choice.finish_reason ?? null),
      modelId: parsed.model ?? config.model,
      requestId: parsed.id ?? response.headers.get('x-request-id'),
    };
  }
}

/** A token count a server may report, or null when it is absent or not a non-negative integer. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const QUOTA_REFUSAL = /credit|insufficient|balance|quota|key limit|spend limit|budget/i;

function classifyStatus(status: number, body: string, config: OpenAICompatibleConfig): ModelProviderError {
  const detail = providerMessage(body, config);
  // 402 is always money (DeepSeek "Insufficient Balance", OpenRouter "insufficient credits"); a 403 or 429 is money only
  // when the server says so (OpenRouter "Key limit exceeded"). Retrying cannot help, so the run goes to a person at
  // once instead of being retried as recoverable.
  if (status === 402 || ((status === 403 || status === 429) && QUOTA_REFUSAL.test(body))) {
    return new ModelProviderError('quota_exhausted', `profile ${config.profile}: the provider refused for balance or spend limit (HTTP ${status})${detail}`, false);
  }
  if (status === 429) return new ModelProviderError('rate_limited', `profile ${config.profile}: rate limited (HTTP 429)${detail}`, true);
  if (status === 408 || status === 504) return new ModelProviderError('timeout', `profile ${config.profile}: upstream timeout (HTTP ${status})${detail}`, true);
  if (status === 400 && /context|maximum.*tokens|too long|max_tokens/i.test(body)) {
    return new ModelProviderError('provider_error', `model_envelope_exceeded: the server refused the request size (HTTP 400)${detail}`, false);
  }
  if (status === 401 || status === 403) return new ModelProviderError('provider_error', `profile ${config.profile}: authentication rejected (HTTP ${status})`, false);
  if (status >= 500) return new ModelProviderError('provider_error', `profile ${config.profile}: server error (HTTP ${status})${detail}`, true);
  return new ModelProviderError('provider_error', `profile ${config.profile}: request refused (HTTP ${status})${detail}`, false);
}

function providerMessage(body: string, config: OpenAICompatibleConfig): string {
  let message: string | null;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    message = typeof parsed.error === 'string' ? parsed.error : typeof parsed.error?.message === 'string' ? parsed.error.message : null;
  } catch {
    message = null;
  }
  return message ? `: ${safeText(message, config)}` : '';
}

/** Error text as it may leave the adapter: bounded, and never containing the key. */
function safeText(text: string, config: OpenAICompatibleConfig): string {
  let out = text;
  if (config.apiKey) out = out.split(config.apiKey).join('[redacted]');
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  return out.length > MAX_ERROR_TEXT ? `${out.slice(0, MAX_ERROR_TEXT - 1)}…` : out;
}

/**
 * The output ceiling sent as `max_tokens` (R4-J1E-R2.3), or null to send none.
 * FIXED profile: the request may only lower it. PROVIDER_MANAGED profile: only
 * a caller's explicit per-request limit is sent; otherwise the provider/model
 * owns the ceiling and no default is substituted.
 */
function outputCeiling(requested: number | undefined, configured: number | null): number | null {
  if (configured === null) return requested ?? null;
  return Math.min(requested ?? configured, configured);
}

function finishReasonOf(reason: string | null): ModelFinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}
