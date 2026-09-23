import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '@r4/model-gateway';
import { DefaultModelGateway } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { OpenAICompatibleModelProvider, describeModelConfig, estimateTokens, loadOpenAICompatibleConfig, renderMessages, type FetchLike, type OpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
import { captureLogs } from '../../support/logs.js';

const KEY = 'sk-test-DO-NOT-LEAK-0123456789abcdef';
const CONFIG: OpenAICompatibleConfig = {
  profile: 'test',
  baseUrl: 'https://llm.example.test/v1',
  apiKey: KEY,
  model: 'some-model',
  timeoutMs: 5_000,
  contextWindowTokens: 16_000,
  maxOutputTokens: 1_000,
  responseFormat: 'json_object',
  temperature: 0.2,
};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    correlation: { correlationId: 'c-1', taskId: 't', runId: 'r', agentId: 'sales' },
    requirements: { reasoningLevel: 'high', latencySensitivity: 'medium', costSensitivity: 'medium', structuredOutput: true, toolUse: false },
    messages: [{ role: 'system', content: 'protocol: answer with one JSON decision' }],
    outputContract: { kind: 'json', name: 'agent_decision', schema: { type: 'object' } },
    limits: { timeoutMs: 10_000 },
    ...overrides,
  };
}

type Call = { url: string; init: Parameters<FetchLike>[1] };
function fakeFetch(answer: (call: Call) => { status: number; body: unknown; headers?: Record<string, string> } | Promise<never>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const a = await answer(call);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: (n: string) => a.headers?.[n] ?? null }, text: () => Promise.resolve(typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  };
  return { fetch, calls };
}

const completion = (content: string | null, extra: Record<string, unknown> = {}) => ({ id: 'cmpl-1', model: 'some-model-2026', choices: [{ message: { content, reasoning_content: 'hidden reasoning must never be kept' }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30 }, ...extra });

describe('OpenAI-compatible configuration (deployment, not AgentDefinition)', () => {
  it('is absent when no provider is configured (offline CI)', () => {
    expect(loadOpenAICompatibleConfig({})).toBeNull();
  });

  it('loads an explicit profile and never echoes values when invalid', () => {
    const env = { R4_MODEL_PROVIDER: 'openai_compatible', R4_MODEL_BASE_URL: 'http://127.0.0.1:8000/v1/', R4_MODEL_NAME: 'local-70b', R4_MODEL_CONTEXT_WINDOW_TOKENS: '32768', R4_MODEL_PROFILE: 'local' };
    expect(loadOpenAICompatibleConfig(env)).toMatchObject({ profile: 'local', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: null, model: 'local-70b', contextWindowTokens: 32_768, maxOutputTokens: 2_048, responseFormat: 'json_object' });
    expect(() => loadOpenAICompatibleConfig({ ...env, R4_MODEL_BASE_URL: 'ftp://nope', R4_MODEL_API_KEY: KEY })).toThrow(/R4_MODEL_BASE_URL/);
    try {
      loadOpenAICompatibleConfig({ ...env, R4_MODEL_CONTEXT_WINDOW_TOKENS: 'x', R4_MODEL_API_KEY: KEY });
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
    }
    expect(JSON.stringify(describeModelConfig({ ...CONFIG }))).not.toContain(KEY);
  });
});

describe('OpenAICompatibleModelProvider', () => {
  it('renders the kernel messages and the compiled context, asks for JSON and maps the answer', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: completion('```json\n{"type":"respond","content":"hola"}\n```') }));
    const provider = new OpenAICompatibleModelProvider(CONFIG, { fetch });
    const result = await new DefaultModelGateway({ provider, logger: createSilentLogger() }).generate(request());
    expect(result).toMatchObject({ ok: true, response: { structuredData: { type: 'respond', content: 'hola' }, usage: { inputTokens: 120, outputTokens: 30 }, finishReason: 'stop', provider: { providerId: 'openai-compatible.test', modelId: 'some-model-2026', requestId: 'cmpl-1' } } });
    expect(calls[0]!.url).toBe('https://llm.example.test/v1/chat/completions');
    expect(calls[0]!.init.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(calls[0]!.init.body) as { model: string; response_format: unknown; max_tokens: number; tools?: unknown; messages: { role: string }[] };
    expect(body).toMatchObject({ model: 'some-model', response_format: { type: 'json_object' }, max_tokens: 1_000 });
    // R4 keeps its structured decision protocol: no native tools are offered (ADR-008).
    expect(body.tools).toBeUndefined();
    // Reasoning text a server returns is never passed on.
    expect(JSON.stringify(result)).not.toContain('hidden reasoning');
  });

  it('leaves non-JSON output for the platform parser to reject (no silent repair)', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: completion('I think we should read the catalog') }));
    const result = await new DefaultModelGateway({ provider: new OpenAICompatibleModelProvider(CONFIG, { fetch }), logger: createSilentLogger() }).generate(request());
    expect(result).toMatchObject({ ok: true, response: { content: 'I think we should read the catalog' } });
    if (result.ok) expect(result.response.structuredData).toBeUndefined();
  });

  it('refuses a request beyond the physical envelope explicitly instead of truncating', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: completion('{}') }));
    const provider = new OpenAICompatibleModelProvider({ ...CONFIG, contextWindowTokens: 1_100 }, { fetch });
    const big = request({ messages: [{ role: 'system', content: 'x'.repeat(3_000) }] });
    const result = await new DefaultModelGateway({ provider, logger: createSilentLogger() }).generate(big);
    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error', retryable: false } });
    if (!result.ok) expect(result.error.message).toMatch(/^model_envelope_exceeded/);
    expect(calls).toHaveLength(0);
    expect(estimateTokens(renderMessages(big))).toBeGreaterThan(1_000);
  });

  it.each([
    [429, 'rate_limited', true],
    [408, 'timeout', true],
    [504, 'timeout', true],
    [500, 'provider_error', true],
    [401, 'provider_error', false],
    [422, 'provider_error', false],
  ] as const)('maps HTTP %i to %s (retryable=%s)', async (status, kind, retryable) => {
    const { fetch } = fakeFetch(() => ({ status, body: { error: { message: `upstream said no; key was ${KEY}` } } }));
    const result = await new DefaultModelGateway({ provider: new OpenAICompatibleModelProvider(CONFIG, { fetch }), logger: createSilentLogger() }).generate(request());
    expect(result).toMatchObject({ ok: false, error: { kind, retryable } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('maps a server-side context-length refusal to the envelope error', async () => {
    const { fetch } = fakeFetch(() => ({ status: 400, body: { error: { message: "This model's maximum context length is 8192 tokens" } } }));
    const result = await new DefaultModelGateway({ provider: new OpenAICompatibleModelProvider(CONFIG, { fetch }), logger: createSilentLogger() }).generate(request());
    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toMatch(/^model_envelope_exceeded/);
  });

  it('classifies its own transport deadline as timeout, distinct from the gateway limit', async () => {
    const hang: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const provider = new OpenAICompatibleModelProvider({ ...CONFIG, timeoutMs: 30 }, { fetch: hang });
    const result = await new DefaultModelGateway({ provider, logger: createSilentLogger() }).generate(request({ limits: { timeoutMs: 5_000 } }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout', retryable: true, providerId: 'openai-compatible.test' } });
    if (!result.ok) expect(result.error.message).toMatch(/transport deadline/);
    // When the gateway's own limit is the shorter one, the gateway classifies it.
    const gatewayFirst = await new DefaultModelGateway({ provider: new OpenAICompatibleModelProvider({ ...CONFIG, timeoutMs: 5_000 }, { fetch: hang }), logger: createSilentLogger() }).generate(request({ limits: { timeoutMs: 30 } }));
    expect(gatewayFirst).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });

  it('reports an unmappable answer as invalid_provider_response', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: '<html>gateway</html>' }));
    const result = await new DefaultModelGateway({ provider: new OpenAICompatibleModelProvider(CONFIG, { fetch }), logger: createSilentLogger() }).generate(request());
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_provider_response', retryable: false } });
  });

  it('never writes the key, the prompt or the answer to telemetry', async () => {
    const logs = captureLogs();
    const { fetch } = fakeFetch(() => ({ status: 200, body: completion('{"type":"respond","content":"secret-answer-marker"}') }));
    await new DefaultModelGateway({ provider: new OpenAICompatibleModelProvider(CONFIG, { fetch }), logger: logs.logger }).generate(request({ messages: [{ role: 'system', content: 'secret-prompt-marker' }] }));
    const raw = logs.raw();
    expect(logs.events('model.call.completed')[0]).toMatchObject({ providerId: 'openai-compatible.test', modelId: 'some-model-2026', inputTokens: 120, outputTokens: 30, finishReason: 'stop' });
    for (const secret of [KEY, 'secret-prompt-marker', 'secret-answer-marker']) expect(raw).not.toContain(secret);
  });
});
