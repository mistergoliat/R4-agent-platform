import { ChatCompletionsImageDescriber, OpenAICompatibleModelProvider, OpenAISpeechTranscriber, describeModelConfig, describePerceptionConfig, loadOpenAICompatibleConfig, loadPerceptionConfig, perceptionRateLimiter } from '@r4-adapters/openai-compatible';
import type { ModelProvider } from '@r4/model-gateway';

/**
 * Deployment-side model selection. The AgentDefinition states abstract
 * requirements only; which endpoint, model and key serve them is process
 * configuration (`R4_MODEL_*`). Returns null when nothing is configured, so
 * callers report "not executed" instead of pretending.
 */
export function configuredModelProvider(env: NodeJS.ProcessEnv): { provider: ModelProvider; description: ReturnType<typeof describeModelConfig> } | null {
  const config = loadOpenAICompatibleConfig(env);
  if (!config) return null;
  return { provider: new OpenAICompatibleModelProvider(config), description: describeModelConfig(config) };
}

/**
 * (Inbound multimodal v1, owner decision 2026-11-11) Deployment-side perception selection: images through an
 * OpenAI-compatible vision endpoint (DeepSeek `deepseek-flash`), voice notes through OpenAI `gpt-transcribe`, each with
 * its own credential (`R4_PERCEPTION_VISION_*`, `R4_PERCEPTION_STT_*`). Off unless `R4_MEDIA_PERCEPTION=enabled`.
 */
export function configuredMediaPerception(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean; readonly imageInstructions: string }): {
  enabled: boolean;
  describer?: ChatCompletionsImageDescriber;
  transcriber?: OpenAISpeechTranscriber;
  transcriptionPromptOverride: string | null;
  description: Record<string, string | boolean>;
} {
  const c = loadPerceptionConfig(env, { allowNetwork: options.allowNetwork });
  // One budget for vision and speech (R4_PERCEPTION_MAX_REQUESTS_PER_MINUTE): this process's share of the provider account.
  const limiter = perceptionRateLimiter(c);
  return {
    enabled: c.enabled,
    ...(c.vision ? { describer: new ChatCompletionsImageDescriber(c.vision, { instructions: options.imageInstructions, ...(limiter ? { limiter } : {}) }) } : {}),
    ...(c.speech ? { transcriber: new OpenAISpeechTranscriber(c.speech, limiter ? { limiter } : {}) } : {}),
    transcriptionPromptOverride: c.speech?.promptOverride ?? null,
    description: describePerceptionConfig(c),
  };
}
