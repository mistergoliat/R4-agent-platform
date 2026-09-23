import type { JudgeRequest, ModelProfile, SemanticJudge } from '@r4/evaluation';
import type { ModelGateway } from '@r4/model-gateway';

/**
 * A semantic judge over the platform's existing ModelGateway: no new model
 * client, no vendor code. Any ModelProvider (hosted, or a locally served
 * model) can judge; the evaluator model is configured separately from the
 * model under test and recorded by its profile.
 *
 * It sends the rubric as system instructions and the privacy projection as
 * the only user content — never secrets, never the runtime's configuration.
 * It returns the provider's structured output as-is: validation (and the
 * inconclusive verdict on failure) belongs to the evaluation framework.
 */
export class ModelGatewayJudge implements SemanticJudge {
  readonly profile: ModelProfile;
  readonly #gateway: ModelGateway;
  readonly #timeoutMs: number;
  readonly #maxOutputTokens: number | undefined;

  constructor(options: { gateway: ModelGateway; profile: ModelProfile; timeoutMs?: number; maxOutputTokens?: number }) {
    if (options.profile.role !== 'evaluator') throw new Error('a judge profile must have role "evaluator"');
    this.#gateway = options.gateway;
    this.profile = options.profile;
    this.#timeoutMs = options.timeoutMs ?? 180_000;
    this.#maxOutputTokens = options.maxOutputTokens;
  }

  async judge(request: JudgeRequest, signal: AbortSignal): Promise<unknown> {
    const result = await this.#gateway.generate(
      {
        correlation: { correlationId: `r4-evaluation.${request.rubric.id}.v${request.rubric.version}` },
        requirements: { reasoningLevel: 'medium', latencySensitivity: 'low', costSensitivity: 'medium', structuredOutput: true, toolUse: false },
        messages: [
          { role: 'system', content: `Rubric ${request.rubric.id}@${request.rubric.version} — ${request.rubric.title}\n${request.rubric.instructions}\nAllowed finding codes: ${request.rubric.allowedCodes.join(', ') || '(none: extraction only)'}` },
          { role: 'user', content: JSON.stringify({ view: request.view }) },
        ],
        outputContract: { kind: 'json', name: `${request.rubric.id}.v${request.rubric.version}`, schema: request.outputSchema },
        limits: { timeoutMs: this.#timeoutMs, ...(this.#maxOutputTokens ? { maxOutputTokens: this.#maxOutputTokens } : {}) },
      },
      { signal },
    );
    if (!result.ok) throw new Error(`judge model call failed: ${result.error.kind}`);
    return result.response.structuredData ?? null;
  }
}
