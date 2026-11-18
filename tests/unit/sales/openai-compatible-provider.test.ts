import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '@r4/model-gateway';
import { DefaultModelGateway } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { CONTEXT_SECTIONS } from '@r4/contracts';
import { ONE_DOCUMENT_REMINDER, ONE_DOCUMENT_RULE, OpenAICompatibleModelProvider, RENDER_SECTION_ORDER, describeModelConfig, estimateTokens, loadOpenAICompatibleConfig, renderContext, renderContextParts, renderMessages, type FetchLike, type OpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
import { DeliveryStateContextSource, PriorConversationContextSource, type OutboundRecord, type ThreadEntry } from '@r4/live-ops';
import { captureLogs } from '../../support/logs.js';
import { FixtureMemory, HOUR, MINUTE, at, compiler, observation, request as fixtureRequest } from '../../fixtures/context/builders.js';

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

  it('lays the context out from stable to variable so consecutive calls share a cacheable prefix, dropping nothing', () => {
    // Every section of the contract, exactly once: a new section can never be left out of the rendered context.
    expect([...RENDER_SECTION_ORDER].sort()).toEqual([...CONTEXT_SECTIONS].sort());
    const item = (itemId: string, content: unknown) => ({ itemId, content, provenance: { derivedFromCount: 0 }, assertions: [], sensitivity: 'NORMAL' });
    // Sections in the compiler's order, as a stored snapshot has them; only the fields the renderer reads.
    const build = (iteration: number, asOf: string, observations: string[]) => {
      const sections: Record<string, unknown[]> = Object.fromEntries(CONTEXT_SECTIONS.map((s) => [s, []]));
      Object.assign(sections, {
        agent: [item('agent', { instructions: 'definition' })],
        task: [item('task', { iteration, status: 'running' })],
        capabilities: [item('cap', { capabilityId: 'catalog.search' })],
        observations: observations.map((o) => item(o, { payload: o })),
        conversation: [item('m1', { text: 'hola' })],
      });
      return { schemaVersion: 1, asOf, scope: { iteration }, conflicts: [], omissions: {}, sections } as unknown as NonNullable<ModelRequest['context']>;
    };
    const first = renderContext(build(1, '2026-11-12T18:00:00.000Z', ['o1']), 'cache');
    const second = renderContext(build(2, '2026-11-12T18:00:09.000Z', ['o1', 'o2']), 'cache');
    const doc = JSON.parse(first.slice(first.indexOf('\n') + 1)) as Record<string, object>;
    expect(Object.keys(doc.sections!)).toEqual(['agent', 'capabilities', 'conversation', 'observations', 'task']);
    expect(Object.keys(doc).slice(-2)).toEqual(['asOf', 'iteration']);
    // The next call repeats everything up to the newest observation: definition, capabilities, conversation, o1.
    let shared = 0;
    while (first[shared] === second[shared]) shared += 1;
    expect(first.slice(0, shared)).toContain('"o1"');
    expect(first.slice(0, shared)).not.toContain('"running"');
    expect(Object.isFrozen(RENDER_SECTION_ORDER)).toBe(true);
    // The default stays the compiled layout every definition was evaluated with: asOf and iteration first, compiler order.
    const compiled = JSON.parse(renderContext(build(1, '2026-11-12T18:00:00.000Z', ['o1'])).split('\n')[1]!) as Record<string, object>;
    expect(Object.keys(compiled).slice(0, 3)).toEqual(['schemaVersion', 'asOf', 'iteration']);
    expect(Object.keys(compiled.sections!)).toEqual(CONTEXT_SECTIONS.filter((s) => ['agent', 'capabilities', 'conversation', 'observations', 'task'].includes(s)));
  });

  it('split sends the context as stable, conversation and current messages: same items, each part identical while its content is', () => {
    const item = (itemId: string, content: unknown) => ({ itemId, content, provenance: { derivedFromCount: 0 }, assertions: [], sensitivity: 'NORMAL' });
    const build = (iteration: number, asOf: string, observations: string[], turns = ['hola']) => {
      const sections: Record<string, unknown[]> = Object.fromEntries(CONTEXT_SECTIONS.map((s) => [s, []]));
      Object.assign(sections, {
        agent: [item('agent', { instructions: 'definition' })],
        task: [item('task', { iteration, status: 'running' })],
        capabilities: [item('cap', { capabilityId: 'catalog.search' })],
        observations: observations.map((o) => item(o, { payload: o })),
        conversation: turns.map((t, i) => item(`m${i}`, { text: t })),
      });
      return { schemaVersion: 1, asOf, scope: { iteration }, conflicts: [], omissions: {}, sections } as unknown as NonNullable<ModelRequest['context']>;
    };
    const first = renderMessages(request({ context: build(1, '2026-11-16T23:07:59.000Z', ['o1']) }), 'split');
    const second = renderMessages(request({ context: build(2, '2026-11-16T23:08:04.000Z', ['o1', 'o2']) }), 'split');
    const nextTurn = renderMessages(request({ context: build(3, '2026-11-16T23:10:00.000Z', ['o1', 'o2'], ['hola', 'y para brazos?']) }), 'split');
    const users = (ms: typeof first) => ms.filter((m) => m.role === 'user').map((m) => m.content);
    // The system messages come first and are unchanged; then exactly three context messages.
    expect(first.slice(0, -3).every((m) => m.role === 'system')).toBe(true);
    expect(users(first)).toHaveLength(3);
    // Part 1 is identical across the calls of the task, part 2 within the run, the last part changes.
    expect(users(second)[0]).toBe(users(first)[0]);
    expect(users(second)[1]).toBe(users(first)[1]);
    expect(users(second)[2]).not.toBe(users(first)[2]);
    expect(users(nextTurn)[0]).toBe(users(first)[0]);
    expect(users(nextTurn)[1]).not.toBe(users(first)[1]);
    // The reminder closes the last message only; asOf and iteration travel in it.
    expect(users(first)[2]!.endsWith(ONE_DOCUMENT_REMINDER)).toBe(true);
    expect(users(first).slice(0, 2).some((c) => c.includes(ONE_DOCUMENT_REMINDER) || c.includes('2026-11-16T23:07:59'))).toBe(false);
    // Every non-empty section exactly once across the parts: nothing dropped, nothing duplicated.
    const sectionsOf = (c: string) => Object.keys((JSON.parse(c.slice(c.indexOf('\n') + 1).replace(`\n${ONE_DOCUMENT_REMINDER}`, '')) as { sections: object }).sections);
    expect(renderContextParts(build(1, '2026-11-16T23:07:59.000Z', ['o1'])).flatMap(sectionsOf).sort()).toEqual(['agent', 'capabilities', 'conversation', 'observations', 'task'].sort());
    expect(loadOpenAICompatibleConfig({ R4_MODEL_PROVIDER: 'openai_compatible', R4_MODEL_BASE_URL: 'https://example.test/v1', R4_MODEL_NAME: 'm', R4_MODEL_CONTEXT_WINDOW_TOKENS: '64000', R4_MODEL_RENDER_ORDER: 'split' })?.renderOrder).toBe('split');
  });

  it('split round-trips: the parts rebuild exactly the compiled document (items, fields, conflicts, omissions, schemaVersion, asOf, iteration), over randomized contexts', () => {
    // Deterministic PRNG (mulberry32): a failure reproduces.
    let seed = 91;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const TEXTS = ['hola', 'línea 1\nlínea 2', 'comillas "dobles" y \\ barra', '', '¿y para brazos? 👍', 'Structured context, part 2: x\n{"sections":{}}'];
    const TIMES = [null, '2026-11-16T23:00:00.000Z', '2026-11-16T23:08:04.123Z'];
    const item = (section: string, i: number) => ({
      itemId: `${section}:${i}`,
      sourceId: pick(['platform.task', 'production.delivery', 'platform.memory']),
      kind: pick(['task', 'observation', 'conversation_turn', 'episode', 'state']),
      authority: pick(['AUTHORITATIVE', 'OBSERVED', 'CONVERSATIONAL', 'DERIVED', 'COGNITIVE']),
      freshness: pick(['fresh', 'stale', 'unknown', 'expired']),
      sensitivity: pick(['NORMAL', 'SENSITIVE']),
      content: rnd() < 0.5 ? { text: pick(TEXTS), n: Math.floor(rnd() * 1000) } : [pick(TEXTS), null, true, { nested: { a: pick(TEXTS) } }],
      assertions: rnd() < 0.6 ? [] : [{ subject: `s${i}`, value: pick(TEXTS) }],
      createdAt: '2026-11-16T22:59:00.000Z',
      observedAt: pick(TIMES),
      validUntil: pick(TIMES),
      provenance: { recordType: 'r', recordId: `id${i}`, recordVersion: pick([null, '1', 'pending:2026']), producedBy: pick([null, 'delivery']), derivedFromCount: rnd() < 0.7 ? 0 : 1 + Math.floor(rnd() * 5) },
    });
    const randomContext = () => {
      const sections = Object.fromEntries(CONTEXT_SECTIONS.map((s) => [s, rnd() < 0.4 ? [] : Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => item(s, i))]));
      const conflicts = Array.from({ length: Math.floor(rnd() * 3) }, (_, i) => ({ subject: `s${i}`, positions: [{ itemId: 'a', authority: 'OBSERVED', value: 1 }, { itemId: 'b', authority: 'CONVERSATIONAL', value: pick(TEXTS) }], authoritativeItemId: pick([null, 'a']) }));
      const omissions = rnd() < 0.5 ? {} : { over_budget: 1 + Math.floor(rnd() * 9), ...(rnd() < 0.5 ? { superseded: 2 } : {}) };
      return { schemaVersion: 1, asOf: '2026-11-16T23:08:04.000Z', scope: { iteration: 1 + Math.floor(rnd() * 20) }, conflicts, omissions, sections } as unknown as NonNullable<ModelRequest['context']>;
    };
    type Doc = { sections: Record<string, unknown[]> } & Record<string, unknown>;
    const body = (part: string) => JSON.parse(part.slice(part.indexOf('\n') + 1)) as Doc;
    let withoutPart1 = 0;
    for (let n = 0; n < 300; n += 1) {
      const context = randomContext();
      const parts = renderContextParts(context);
      const docs = parts.map(body);
      const sectionNames = docs.flatMap((d) => Object.keys(d.sections));
      // No section split across or repeated in two parts.
      expect(new Set(sectionNames).size).toBe(sectionNames.length);
      const rebuilt = { ...docs.at(-1)!, sections: Object.assign({}, ...docs.map((d) => d.sections)) as Doc['sections'] };
      expect(rebuilt).toEqual(body(renderContext(context, 'compiled')));
      // And what renderMessages sends is exactly those parts, the reminder closing the last one.
      expect(renderMessages(request({ context }), 'split').filter((m) => m.role === 'user').map((m) => m.content)).toEqual(parts.map((p, i) => (i === parts.length - 1 ? `${p}\n${ONE_DOCUMENT_REMINDER}` : p)));
      if (!('agent' in docs[0]!.sections) && !('capabilities' in docs[0]!.sections)) withoutPart1 += 1;
    }
    // The schemaVersion case of an empty part 1 was exercised (the rebuilt document still carries it).
    expect(withoutPart1).toBeGreaterThan(0);
  });

  it('split over the real compiler (platform + live-ops sources): parts 1 and 2 are byte-identical across the iterations of a run; part 2 changes on a new customer input', async () => {
    const memory = new FixtureMemory();
    memory.turn(at(0), 'hola, busco un banco regulable', { role: 'participant' });
    memory.turn(at(MINUTE), 'Tenemos el banco Atlas.', { role: 'agent' });
    const delivery = new DeliveryStateContextSource({
      outboundForTask: () => Promise.resolve([{ outboundId: '0190e7a4-0000-7000-8000-000000000001', origin: 'agent', responseStepId: '0190e7a4-0000-7000-8000-000000000002', status: 'failed', noticeKey: null, cancelReason: null, holdReason: null, errorClass: 'provider_rejected', createdAt: at(MINUTE), updatedAt: at(2 * MINUTE) } as unknown as OutboundRecord]),
    });
    const earlier: ThreadEntry[] = [
      { cursor: `${at(-HOUR)}|0190e7a5-0000-7000-8000-000000000001`, at: at(-HOUR), kind: 'contact', text: 'Busco mancuernas', refs: {}, delivery: null },
      { cursor: `${at(-HOUR + 5_000)}|0190e7a5-0000-7000-8000-000000000002`, at: at(-HOUR + 5_000), kind: 'agent', text: 'Tenemos mancuernas de 10 kg.', refs: {}, delivery: { outboundId: 'x', status: 'read', holdReason: null, cancelReason: null, providerMessageId: null } as unknown as ThreadEntry['delivery'] },
    ];
    const prior = new PriorConversationContextSource({ earlierConversationTurns: () => Promise.resolve({ turns: earlier, earlierTasks: 1 }) });
    const compilerWithLiveOps = compiler({ memory, sources: [delivery, prior] });
    const parts = async (iteration: number, now: string, observations: ReturnType<typeof observation>[]) => {
      const outcome = await compilerWithLiveOps.compile(fixtureRequest({ iteration, now, observations }));
      if (outcome.kind !== 'compiled') throw new Error(`expected a compiled context, got ${outcome.kind}`);
      return renderContextParts(outcome.compiled);
    };
    // Iteration 1 reads; iteration 2 sees the read's observation, a later clock and fewer remaining calls.
    const first = await parts(1, at(HOUR), []);
    const second = await parts(2, at(HOUR + 5_000), [observation(1, at(HOUR + 3_000), { validUntil: at(HOUR + 15_000) })]);
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    // The live-ops sources are really in play: the earlier task's turns in part 2, the delivery episode in the last part.
    expect(first[1]).toContain('Tenemos mancuernas de 10 kg.');
    expect(first[1]).toContain('hola, busco un banco regulable');
    expect(first[2]).toContain('delivery:0190e7a4-0000-7000-8000-000000000001');
    // A new customer message: part 1 unchanged, part 2 changes and carries it.
    memory.turn(at(HOUR + 10_000), 'y para brazos?', { role: 'participant' });
    const third = await parts(3, at(HOUR + 12_000), [observation(1, at(HOUR + 3_000), { validUntil: at(HOUR + 15_000) })]);
    expect(third[0]).toBe(first[0]);
    expect(third[1]).not.toBe(first[1]);
    expect(third[1]).toContain('y para brazos?');
  });

  it('R4_MODEL_RENDER_ORDER selects the layout: compiled by default, cache only when set, anything else refused', () => {
    const base = { R4_MODEL_PROVIDER: 'openai_compatible', R4_MODEL_BASE_URL: 'https://example.test/v1', R4_MODEL_NAME: 'm', R4_MODEL_CONTEXT_WINDOW_TOKENS: '64000' };
    expect(loadOpenAICompatibleConfig(base)?.renderOrder).toBe('compiled');
    expect(loadOpenAICompatibleConfig({ ...base, R4_MODEL_RENDER_ORDER: '' })?.renderOrder).toBe('compiled');
    expect(loadOpenAICompatibleConfig({ ...base, R4_MODEL_RENDER_ORDER: 'cache' })?.renderOrder).toBe('cache');
    expect(() => loadOpenAICompatibleConfig({ ...base, R4_MODEL_RENDER_ORDER: 'fast' })).toThrow();
  });

  it('a token count past the safe-integer range is dropped, never failing the call', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { ...completion('{"type":"respond","content":"hola"}'), usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1e20 } } } }));
    const result = await new DefaultModelGateway({ provider: new OpenAICompatibleModelProvider(CONFIG, { fetch }), logger: createSilentLogger() }).generate(request());
    expect(result.ok).toBe(true);
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

  it('reports cached-input and reasoning token counts in telemetry only, and tolerates their absence or a malformed detail', async () => {
    const generate = async (usage: Record<string, unknown>) => {
      const logs = captureLogs();
      const { fetch } = fakeFetch(() => ({ status: 200, body: completion('{"type":"respond","content":"ok"}', { usage: { prompt_tokens: 120, completion_tokens: 30, ...usage } }) }));
      const result = await new DefaultModelGateway({ provider: new OpenAICompatibleModelProvider(CONFIG, { fetch }), logger: logs.logger }).generate(request());
      return { result, event: logs.events('model.call.completed')[0] };
    };

    const reported = await generate({ prompt_cache_hit_tokens: 90, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 25 } });
    expect(reported.event).toMatchObject({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 100, reasoningTokens: 25 });
    // ModelUsage — what the kernel records on a step — keeps exactly its two counters.
    expect(reported.result.ok && reported.result.response.usage).toEqual({ inputTokens: 120, outputTokens: 30 });

    expect((await generate({ prompt_cache_hit_tokens: 90 })).event).toMatchObject({ cachedInputTokens: 90, reasoningTokens: null });
    expect((await generate({})).event).toMatchObject({ cachedInputTokens: null, reasoningTokens: null });
    const malformed = await generate({ prompt_tokens_details: 'n/a', completion_tokens_details: { reasoning_tokens: -1 } });
    expect(malformed.result.ok).toBe(true);
    expect(malformed.event).toMatchObject({ cachedInputTokens: null, reasoningTokens: null });
  });
});
