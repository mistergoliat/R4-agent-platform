import { z } from 'zod';

/**
 * Deployment configuration of one OpenAI-compatible endpoint. It lives in
 * the environment of the process that runs the worker — never in an
 * AgentDefinition — so the same agent can run against a hosted API, a vLLM
 * server or a local model by changing configuration only.
 *
 * `contextWindowTokens` is the model's physical envelope (ADR-015: effective
 * input = min(envelope, R4 budget)); the adapter refuses a request that does
 * not fit instead of truncating it.
 */
export interface OpenAICompatibleConfig {
  /** Logical profile name (e.g. `default`, `sales-strong`): what telemetry reports, never a secret. */
  readonly profile: string;
  readonly baseUrl: string;
  /** Null for endpoints without authentication (e.g. a local server). Never logged or persisted. */
  readonly apiKey: string | null;
  readonly model: string;
  /** Transport deadline of one call (the gateway also enforces the request's own timeout). */
  readonly timeoutMs: number;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  /** `json_object` asks the server for a JSON document; `none` relies on the instructions only. */
  readonly responseFormat: 'json_object' | 'none';
  readonly temperature: number | null;
}

const envSchema = z.object({
  R4_MODEL_PROVIDER: z.literal('openai_compatible'),
  R4_MODEL_PROFILE: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/).default('default'),
  R4_MODEL_BASE_URL: z.url({ protocol: /^https?$/ }),
  R4_MODEL_API_KEY: z.string().min(1).optional(),
  R4_MODEL_NAME: z.string().min(1).max(200),
  R4_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  R4_MODEL_CONTEXT_WINDOW_TOKENS: z.coerce.number().int().min(1_024),
  R4_MODEL_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).default(2_048),
  R4_MODEL_RESPONSE_FORMAT: z.enum(['json_object', 'none']).default('json_object'),
  R4_MODEL_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
});

/**
 * Reads the configuration from the environment. Returns null when no model
 * provider is configured (offline CI, missing credentials) so callers can
 * say so explicitly instead of failing or pretending.
 */
export function loadOpenAICompatibleConfig(env: NodeJS.ProcessEnv): OpenAICompatibleConfig | null {
  if (env.R4_MODEL_PROVIDER === undefined || env.R4_MODEL_PROVIDER === '') return null;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Paths only: never echo values (one of them may be a key).
    throw new Error(`invalid model provider configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  const c = parsed.data;
  if (c.R4_MODEL_MAX_OUTPUT_TOKENS >= c.R4_MODEL_CONTEXT_WINDOW_TOKENS) {
    throw new Error('invalid model provider configuration: R4_MODEL_MAX_OUTPUT_TOKENS must be smaller than R4_MODEL_CONTEXT_WINDOW_TOKENS');
  }
  return {
    profile: c.R4_MODEL_PROFILE,
    baseUrl: c.R4_MODEL_BASE_URL.replace(/\/+$/, ''),
    apiKey: c.R4_MODEL_API_KEY ?? null,
    model: c.R4_MODEL_NAME,
    timeoutMs: c.R4_MODEL_TIMEOUT_MS,
    contextWindowTokens: c.R4_MODEL_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: c.R4_MODEL_MAX_OUTPUT_TOKENS,
    responseFormat: c.R4_MODEL_RESPONSE_FORMAT,
    temperature: c.R4_MODEL_TEMPERATURE ?? null,
  };
}

/** What may be printed or stored about a configuration: no key, no credentials in the URL. */
export function describeModelConfig(config: OpenAICompatibleConfig): { profile: string; host: string; model: string; contextWindowTokens: number; maxOutputTokens: number; responseFormat: string; authenticated: boolean } {
  const url = new URL(config.baseUrl);
  return { profile: config.profile, host: url.host, model: config.model, contextWindowTokens: config.contextWindowTokens, maxOutputTokens: config.maxOutputTokens, responseFormat: config.responseFormat, authenticated: config.apiKey !== null };
}
