import { OpenAICompatibleModelProvider, describeModelConfig, loadOpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
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
