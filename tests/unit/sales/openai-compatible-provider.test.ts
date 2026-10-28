import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '@r4/model-gateway';
import { DefaultModelGateway } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { ONE_DOCUMENT_REMINDER, ONE_DOCUMENT_RULE, OpenAICompatibleModelProvider, describeModelConfig, estimateTokens, loadOpenAICompatibleConfig, renderMessages, type FetchLike, type OpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
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
  extraBody: {},
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
    expect(loadOpenAICompatibleConfig(env)).toMatchObject({ profile: 'local', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: null, model: 'local-70b', contextWindowTokens: 32_768, maxOutputTokens: null, responseFormat: 'json_object', extraBody: {} });
    expect(() => loadOpenAICompatibleConfig({ ...env, R4_MODEL_BASE_URL: 'ftp://nope', R4_MODEL_API_KEY: KEY })).toThrow(/R4_MODEL_BASE_URL/);
    try {
      loadOpenAICompatibleConfig({ ...env, R4_MODEL_CONTEXT_WINDOW_TOKENS: 'x', R4_MODEL_API_KEY: KEY });
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
    }
    expect(JSON.stringify(describeModelConfig({ ...CONFIG }))).not.toContain(KEY);
  });
});

describe('OpenAI-compatible extra request fields (R4_MODEL_EXTRA_BODY)', () => {
  const env = { R4_MODEL_PROVIDER: 'openai_compatible', R4_MODEL_BASE_URL: 'https://llm.example.test', R4_MODEL_NAME: 'reasoning-model', R4_MODEL_CONTEXT_WINDOW_TOKENS: '64000' };

  it('loads an explicit reasoning switch as opaque deployment configuration and reports it', () => {
    const config = loadOpenAICompatibleConfig({ ...env, R4_MODEL_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' });
    expect(config?.extraBody).toEqual({ thinking: { type: 'disabled' } });
    expect(describeModelConfig(config!)).toMatchObject({ extraBody: { thinking: { type: 'disabled' } } });
  });

  it.each([
    ['not JSON', '{thinking: off}'],
    ['not an object', '["thinking"]'],
    ['an adapter-owned field', '{"max_tokens":999999}'],
    ['the model', '{"model":"other"}'],
    ['native tools', '{"tools":[]}'],
  ])('refuses %s', (_, value) => {
    expect(() => loadOpenAICompatibleConfig({ ...env, R4_MODEL_EXTRA_BODY: value })).toThrow(/R4_MODEL_EXTRA_BODY/);
  });

  it('sends the extra fields without letting them replace what the adapter owns', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: completion('{"type":"respond","content":"hola"}') }));
    const provider = new OpenAICompatibleModelProvider({ ...CONFIG, extraBody: { thinking: { type: 'disabled' }, max_tokens: 1 } }, { fetch });
    await new DefaultModelGateway({ provider, logger: createSilentLogger() }).generate(request());
    const body = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
    expect(body).toMatchObject({ thinking: { type: 'disabled' }, model: 'some-model', max_tokens: 1_000, response_format: { type: 'json_object' } });
  });

  it('sends no extra field when none is configured (the server default applies)', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: completion('{"type":"respond","content":"hola"}') }));
    await new DefaultModelGateway({ provider: new OpenAICompatibleModelProvider(CONFIG, { fetch }), logger: createSilentLogger() }).generate(request());
    expect(Object.keys(JSON.parse(calls[0]!.init.body) as object).sort()).toEqual(['max_tokens', 'messages', 'model', 'response_format', 'stream', 'temperature']);
  });
});

describe('OpenAI-compatible output limit (R4-J1E-R2.3: fixed vs provider-managed)', () => {
  const env = { R4_MODEL_PROVIDER: 'openai_compatible', R4_MODEL_BASE_URL: 'https://llm.example.test', R4_MODEL_NAME: 'reasoning-model', R4_MODEL_CONTEXT_WINDOW_TOKENS: '64000' };
  const MANAGED: OpenAICompatibleConfig = { ...CONFIG, maxOutputTokens: null };
  const send = async (config: OpenAICompatibleConfig, req: ModelRequest = request()) => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: completion('{"type":"respond","content":"hola"}') }));
    const result = await new DefaultModelGateway({ provider: new OpenAICompatibleModelProvider(config, { fetch }), logger: createSilentLogger() }).generate(req);
    return { result, calls, body: calls[0] ? (JSON.parse(calls[0].init.body) as Record<string, unknown>) : null };
  };

  it('treats an absent or empty R4_MODEL_MAX_OUTPUT_TOKENS as provider-managed, with no numeric default', () => {
    for (const config of [loadOpenAICompatibleConfig(env), loadOpenAICompatibleConfig({ ...env, R4_MODEL_MAX_OUTPUT_TOKENS: '' })]) {
      expect(config?.maxOutputTokens).toBeNull();
      expect(describeModelConfig(config!)).toMatchObject({ maxOutputTokens: null, outputLimitMode: 'provider_managed' });
    }
  });

  it('keeps an explicit R4_MODEL_MAX_OUTPUT_TOKENS as a fixed ceiling, still validated against the window', () => {
    const config = loadOpenAICompatibleConfig({ ...env, R4_MODEL_MAX_OUTPUT_TOKENS: '8192' });
    expect(describeModelConfig(config!)).toMatchObject({ maxOutputTokens: 8_192, outputLimitMode: 'fixed' });
    expect(() => loadOpenAICompatibleConfig({ ...env, R4_MODEL_MAX_OUTPUT_TOKENS: '64000' })).toThrow(/R4_MODEL_MAX_OUTPUT_TOKENS/);
    expect(() => loadOpenAICompatibleConfig({ ...env, R4_MODEL_MAX_OUTPUT_TOKENS: '10' })).toThrow(/R4_MODEL_MAX_OUTPUT_TOKENS/);
  });

  it('A. provider-managed: the request carries no max_tokens nor max_completion_tokens, and is otherwise unchanged', async () => {
    const managed = await send(MANAGED);
    const fixed = await send(CONFIG);
    expect(managed.result.ok).toBe(true);
    expect(managed.body).not.toHaveProperty('max_tokens');
    expect(managed.body).not.toHaveProperty('max_completion_tokens');
    const { max_tokens: _omitted, ...rest } = fixed.body!;
    expect(managed.body).toEqual(rest);
  });

  it('B. fixed: the request carries the configured max_tokens', async () => {
    expect((await send(CONFIG)).body).toMatchObject({ max_tokens: 1_000 });
    // A request may only lower a fixed ceiling.
    expect((await send(CONFIG, request({ limits: { timeoutMs: 10_000, maxOutputTokens: 300 } }))).body).toMatchObject({ max_tokens: 300 });
    expect((await send(CONFIG, request({ limits: { timeoutMs: 10_000, maxOutputTokens: 5_000 } }))).body).toMatchObject({ max_tokens: 1_000 });
  });

  it("sends a caller's explicit per-request limit under a provider-managed profile (no default substituted otherwise)", async () => {
    expect((await send(MANAGED, request({ limits: { timeoutMs: 10_000, maxOutputTokens: 300 } }))).body).toMatchObject({ max_tokens: 300 });
  });

  it('C. provider-managed envelope: a prompt under the window passes without an artificial output allowance', async () => {
    const prompt = request({ messages: [{ role: 'system', content: 'x'.repeat(3_000) }] });
    const estimated = estimateTokens(renderMessages(prompt));
    // The same prompt is refused by a fixed profile (prompt + reserved output > window) and accepted when provider-managed.
    const window = estimated + 10;
    expect((await send({ ...CONFIG, contextWindowTokens: window }, prompt)).result).toMatchObject({ ok: false, error: { kind: 'provider_error' } });
    const managed = await send({ ...MANAGED, contextWindowTokens: window }, prompt);
    expect(managed.result.ok).toBe(true);
    expect(managed.body).not.toHaveProperty('max_tokens');
  });

  it('D. provider-managed envelope: a prompt over the window is still refused before any call', async () => {
    const prompt = request({ messages: [{ role: 'system', content: 'x'.repeat(3_000) }] });
    const estimated = estimateTokens(renderMessages(prompt));
    const { result, calls } = await send({ ...MANAGED, contextWindowTokens: estimated - 1 }, prompt);
    expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error', retryable: false } });
    if (!result.ok) expect(result.error.message).toMatch(/^model_envelope_exceeded: estimated \d+ input tokens exceed/);
    expect(calls).toHaveLength(0);
  });

  it('E. DeepSeek production profile: 1M-token envelope, provider-managed output, thinking and json_object unchanged', async () => {
    // The production worker's R4_MODEL_* (pm2 env on the host), with R4_MODEL_MAX_OUTPUT_TOKENS unset.
    const production = {
      R4_MODEL_PROVIDER: 'openai_compatible',
      R4_MODEL_BASE_URL: 'https://api.deepseek.com',
      R4_MODEL_API_KEY: KEY,
      R4_MODEL_NAME: 'deepseek-flash',
      R4_MODEL_PROFILE: 'deepseek-v4-flash',
      R4_MODEL_CONTEXT_WINDOW_TOKENS: '1000000',
      R4_MODEL_RESPONSE_FORMAT: 'json_object',
      R4_MODEL_EXTRA_BODY: '{"thinking":{"type":"enabled"}}',
    };
    const config = loadOpenAICompatibleConfig(production)!;
    expect(config.contextWindowTokens).toBe(1_000_000);
    expect(config.maxOutputTokens).toBeNull();
    expect(describeModelConfig(config)).toMatchObject({ model: 'deepseek-flash', contextWindowTokens: 1_000_000, maxOutputTokens: null, outputLimitMode: 'provider_managed', responseFormat: 'json_object', extraBody: { thinking: { type: 'enabled' } } });
    const { body } = await send(config);
    expect(body).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'enabled' }, response_format: { type: 'json_object' }, stream: false });
    expect(Object.keys(body!).sort()).toEqual(['messages', 'model', 'response_format', 'stream', 'thinking']);
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

  it('F-1: with a JSON contract, states the one-document rule before the schema and closes the context with the reminder', () => {
    // Only the fields the renderer reads; a real CompiledContext comes from the Context Compiler.
    const context = { schemaVersion: 1, asOf: '2026-10-27T12:00:00.000Z', scope: { iteration: 1 }, sections: {}, conflicts: [], omissions: {} } as unknown as NonNullable<ModelRequest['context']>;
    const messages = renderMessages(request({ context }));
    const output = messages.find((m) => m.role === 'system' && m.content.startsWith('Output:'))!;
    expect(output.content).toContain(ONE_DOCUMENT_RULE);
    expect(output.content).toMatch(/never two or more/);
    expect(output.content).toMatch(/return only the first one now/);
    expect(output.content).toMatch(/nothing before or after the document/);
    const last = messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content.endsWith(`\n${ONE_DOCUMENT_REMINDER}`)).toBe(true);
    // Agent-neutral: the adapter never names a decision type of the R4 protocol.
    expect(`${ONE_DOCUMENT_RULE} ${ONE_DOCUMENT_REMINDER}`).not.toMatch(/read_capability|respond|propose_action/);
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
