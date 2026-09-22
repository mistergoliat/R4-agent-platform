import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ModelRequirements } from '@r4/contracts';
import {
  DefaultModelGateway,
  FAKE_MODEL_ID,
  FakeModelProvider,
  parseStructuredOutput,
  type FakeModelScript,
  type ModelGateway,
  type ModelRequest,
} from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { captureLogs } from '../../support/logs.js';

const requirements: ModelRequirements = {
  reasoningLevel: 'low',
  latencySensitivity: 'medium',
  costSensitivity: 'high',
  structuredOutput: true,
  toolUse: true,
};

const SECRET_PROMPT = 'confidential-user-text-7f3a';

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    correlation: { correlationId: 'corr-1', taskId: 't-1', runId: 'r-1', agentId: 'platform-probe' },
    requirements,
    messages: [
      { role: 'system', content: 'be precise' },
      { role: 'user', content: SECRET_PROMPT },
    ],
    outputContract: { kind: 'text' },
    limits: { timeoutMs: 1_000 },
    ...overrides,
  };
}

function gateway(script: FakeModelScript): { gateway: ModelGateway; provider: FakeModelProvider } {
  const provider = new FakeModelProvider(script);
  return { gateway: new DefaultModelGateway({ provider, logger: createSilentLogger() }), provider };
}

/** An example structured decision schema, owned by the caller (not by the gateway). */
const decisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('read'), capabilityId: z.string(), arguments: z.record(z.string(), z.unknown()) }),
  z.strictObject({ decision: z.literal('respond'), message: z.string() }),
]);

describe('DefaultModelGateway with FakeModelProvider', () => {
  it('returns a successful text completion with provider metadata and usage', async () => {
    const { gateway: g, provider } = gateway([{ type: 'text', content: 'hi' }]);
    const result = await g.generate(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.content).toBe('hi');
    expect(result.response.finishReason).toBe('stop');
    expect(result.response.provider).toMatchObject({ providerId: 'fake', modelId: FAKE_MODEL_ID });
    expect(result.response.usage.outputTokens).toBe(2);
    expect(provider.callCount).toBe(1);
    expect(provider.requests[0]!.correlation.runId).toBe('r-1');
  });

  it('returns a structured decision that the caller validates as untrusted', async () => {
    const decision = { decision: 'read', capabilityId: 'platform_test.get_test_fact', arguments: { factKey: 'alpha' } };
    const { gateway: g } = gateway([{ type: 'structured', data: decision }]);
    const result = await g.generate(request({ outputContract: { kind: 'json', name: 'decision', schema: z.toJSONSchema(decisionSchema) } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseStructuredOutput(result.response, decisionSchema);
    expect(parsed).toEqual({ ok: true, data: decision });
  });

  it('classifies a structured decision that violates the caller schema as invalid_model_output', async () => {
    const { gateway: g } = gateway([{ type: 'structured', data: { decision: 'delete_everything' } }]);
    const result = await g.generate(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseStructuredOutput(result.response, decisionSchema);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.kind).toBe('invalid_model_output');
  });

  it('reports missing structured data as invalid_model_output', async () => {
    const { gateway: g } = gateway([{ type: 'text', content: 'I did it!' }]);
    const result = await g.generate(request());
    if (!result.ok) throw new Error('expected success');
    expect(parseStructuredOutput(result.response, decisionSchema).ok).toBe(false);
  });

  it('returns proposed tool calls without executing anything', async () => {
    const { gateway: g } = gateway([{ type: 'tool_calls', calls: [{ name: 'platform_test.get_test_fact', arguments: { factKey: 'alpha' } }] }]);
    const result = await g.generate(request());
    if (!result.ok) throw new Error('expected success');
    expect(result.response.finishReason).toBe('tool_calls');
    expect(result.response.toolCalls).toEqual([{ id: 'fake-call-0-0', name: 'platform_test.get_test_fact', arguments: { factKey: 'alpha' } }]);
  });

  it('classifies provider failures as values, honoring retryability', async () => {
    const { gateway: g } = gateway([
      { type: 'provider_error', message: 'upstream 503', retryable: true },
      { type: 'provider_error', kind: 'rate_limited', message: 'slow down', retryable: true },
      { type: 'provider_error', message: 'bad credentials', retryable: false },
    ]);
    const a = await g.generate(request());
    const b = await g.generate(request());
    const c = await g.generate(request());
    expect(a).toMatchObject({ ok: false, error: { kind: 'provider_error', retryable: true, message: 'upstream 503', providerId: 'fake' } });
    expect(b).toMatchObject({ ok: false, error: { kind: 'rate_limited', retryable: true } });
    expect(c).toMatchObject({ ok: false, error: { kind: 'provider_error', retryable: false } });
  });

  it('enforces the timeout on a provider that honors abort', async () => {
    const { gateway: g } = gateway([{ type: 'timeout' }]);
    const result = await g.generate(request({ limits: { timeoutMs: 20 } }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout', retryable: true } });
  });

  it('enforces the timeout even when the provider ignores abort', async () => {
    const { gateway: g } = gateway([{ type: 'timeout', ignoreAbort: true }]);
    const started = Date.now();
    const result = await g.generate(request({ limits: { timeoutMs: 25 } }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('supports external cancellation', async () => {
    const { gateway: g } = gateway([{ type: 'timeout' }]);
    const controller = new AbortController();
    const pending = g.generate(request({ limits: { timeoutMs: 5_000 } }), { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'cancelled', retryable: false } });

    const already = new AbortController();
    already.abort();
    expect(await g.generate(request(), { signal: already.signal })).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  });

  it('rejects provider responses that violate the provider contract', async () => {
    const { gateway: g } = gateway([{ type: 'malformed', raw: { content: 42, usage: 'lots' } }]);
    expect(await g.generate(request())).toMatchObject({ ok: false, error: { kind: 'invalid_provider_response', retryable: false } });
  });

  it('fails deterministically when the fake script is exhausted', async () => {
    const { gateway: g } = gateway([]);
    const result = await g.generate(request());
    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error' } });
    if (!result.ok) expect(result.error.message).toMatch(/script exhausted/);
  });

  it('supports a function script for request-dependent behavior', async () => {
    const { gateway: g } = gateway((req, i) => ({ type: 'text', content: `${i}:${req.messages.length}` }));
    const first = await g.generate(request());
    const second = await g.generate(request());
    expect(first.ok && first.response.content).toBe('0:2');
    expect(second.ok && second.response.content).toBe('1:2');
  });

  it('rejects an invalid timeout without calling the provider', async () => {
    const { gateway: g, provider } = gateway([{ type: 'text', content: 'x' }]);
    expect(await g.generate(request({ limits: { timeoutMs: 0 } }))).toMatchObject({ ok: false });
    expect(provider.callCount).toBe(0);
  });

  it('emits metadata-only telemetry: never prompt or output text', async () => {
    const logs = captureLogs();
    const provider = new FakeModelProvider([
      { type: 'text', content: 'model-output-secret-9b1c' },
      { type: 'provider_error' },
    ]);
    const g = new DefaultModelGateway({ provider, logger: logs.logger });
    await g.generate(request());
    await g.generate(request());

    const completed = logs.events('model.call.completed');
    const failed = logs.events('model.call.failed');
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ taskId: 't-1', runId: 'r-1', agentId: 'platform-probe', correlationId: 'corr-1', providerId: 'fake' });
    expect(logs.raw()).not.toContain(SECRET_PROMPT);
    expect(logs.raw()).not.toContain('model-output-secret-9b1c');
  });
});
