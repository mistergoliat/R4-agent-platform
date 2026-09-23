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
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).optional(),
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
 *   (`model_envelope_exceeded`), never truncated.
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
    const messages = renderMessages(request);
    const maxTokens = Math.min(request.limits.maxOutputTokens ?? config.maxOutputTokens, config.maxOutputTokens);
    const estimated = estimateTokens(messages);
    if (estimated + maxTokens > config.contextWindowTokens) {
      throw new ModelProviderError(
        'provider_error',
        `model_envelope_exceeded: estimated ${estimated} input tokens + ${maxTokens} reserved output exceed the ${config.contextWindowTokens}-token window of profile ${config.profile}`,
        false,
      );
    }
    // Deployment extras first: the fields the adapter owns always win (config validation also refuses them).
    const body = {
      ...config.extraBody,
      model: config.model,
      messages,
      max_tokens: maxTokens,
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
      usage: { inputTokens: parsed.usage?.prompt_tokens ?? 0, outputTokens: parsed.usage?.completion_tokens ?? 0 },
      finishReason: finishReasonOf(choice.finish_reason ?? null),
      modelId: parsed.model ?? config.model,
      requestId: parsed.id ?? response.headers.get('x-request-id'),
    };
  }
}

function classifyStatus(status: number, body: string, config: OpenAICompatibleConfig): ModelProviderError {
  const detail = providerMessage(body, config);
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
