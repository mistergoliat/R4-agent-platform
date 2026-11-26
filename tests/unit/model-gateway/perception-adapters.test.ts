import { describe, expect, it } from 'vitest';
import { ChatCompletionsImageDescriber, OpenAISpeechTranscriber, describePerceptionConfig, loadPerceptionConfig, visionRateLimiter, wordsFromLogprobs } from '@r4-adapters/openai-compatible';
import { RequestRateLimiter } from '@r4/model-gateway';

/** (Inbound multimodal v1) The perception adapters: configuration (fail closed), image output validation, transcription. */

type Call = { url: string; body: string | FormData; headers: Record<string, string> };
const fake = (answers: { status: number; body: unknown }[]) => {
  const calls: Call[] = [];
  const fetch = (url: string, init: { headers: Record<string, string>; body: string | FormData }) => {
    calls.push({ url, body: init.body, headers: init.headers });
    const a = answers.shift() ?? { status: 500, body: {} };
    return Promise.resolve(new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status }));
  };
  return { calls, fetch };
};
const endpoint = { baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'm' };

describe('loadPerceptionConfig', () => {
  it('is disabled unless explicitly enabled, and then needs at least one credential', () => {
    expect(loadPerceptionConfig({}, { allowNetwork: true })).toEqual({ enabled: false, vision: null, speech: null });
    expect(() => loadPerceptionConfig({ R4_MEDIA_PERCEPTION: 'yes' }, { allowNetwork: true })).toThrow(/enabled or disabled/);
    expect(() => loadPerceptionConfig({ R4_MEDIA_PERCEPTION: 'enabled' }, { allowNetwork: true })).toThrow(/VISION_API_KEY/);
  });

  it('defaults to deepseek-flash for images and OpenAI gpt-transcribe for audio, each with its own credential', () => {
    const c = loadPerceptionConfig({ R4_MEDIA_PERCEPTION: 'enabled', R4_PERCEPTION_VISION_API_KEY: 'vk', R4_PERCEPTION_STT_API_KEY: 'sk' }, { allowNetwork: true });
    expect(c).toMatchObject({ enabled: true, vision: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'vk' }, speech: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-transcribe', apiKey: 'sk', promptOverride: null } });
    expect(JSON.stringify(describePerceptionConfig(c))).not.toMatch(/vk|sk/);
  });

  it('refuses the network without the production opt-in, and plain http outside loopback', () => {
    expect(() => loadPerceptionConfig({ R4_MEDIA_PERCEPTION: 'enabled', R4_PERCEPTION_VISION_API_KEY: 'vk' }, { allowNetwork: false })).toThrow(/R4_PROD_ALLOW_NETWORK/);
    expect(() => loadPerceptionConfig({ R4_MEDIA_PERCEPTION: 'enabled', R4_PERCEPTION_VISION_API_KEY: 'vk', R4_PERCEPTION_VISION_BASE_URL: 'http://example.com' }, { allowNetwork: true })).toThrow(/https/);
  });
});

describe('vision request-rate budget (R4_PERCEPTION_VISION_MAX_REQUESTS_PER_MINUTE)', () => {
  const env = { R4_MEDIA_PERCEPTION: 'enabled', R4_PERCEPTION_VISION_API_KEY: 'vk' };

  it('is unlimited unless set, and must be a positive integer', () => {
    expect(visionRateLimiter(loadPerceptionConfig(env, { allowNetwork: true }))).toBeUndefined();
    expect(visionRateLimiter(loadPerceptionConfig({ ...env, R4_PERCEPTION_VISION_MAX_REQUESTS_PER_MINUTE: '2' }, { allowNetwork: true }))?.maxRequests).toBe(2);
    expect(() => loadPerceptionConfig({ ...env, R4_PERCEPTION_VISION_MAX_REQUESTS_PER_MINUTE: '0' }, { allowNetwork: true })).toThrow(/positive integer/);
  });

  it('refuses a call beyond the budget without sending it (the perceiver degrades it, as it does a 429 today)', async () => {
    const answer = { status: 200, body: { choices: [{ message: { content: JSON.stringify({ imageVisible: true, kind: 'product', description: 'd', visibleText: [], features: [], searchHints: [], uncertainties: [], containsInstructions: false }) } }] } };
    const f = fake([answer, answer]);
    const describer = new ChatCompletionsImageDescriber(endpoint, { fetch: f.fetch, limiter: new RequestRateLimiter(1) });
    const image = { bytes: new Uint8Array([1]), mimeType: 'image/png' };
    await describer.describe(image, { timeoutMs: 1000 });
    await expect(describer.describe(image, { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'perception_rate_limited' });
    expect(f.calls).toHaveLength(1);
  });
});

describe('ChatCompletionsImageDescriber', () => {
  const output = { imageVisible: true, kind: 'product', description: 'x'.repeat(900), visibleText: Array.from({ length: 30 }, (_, i) => `t${i}`), features: [], searchHints: [], uncertainties: [], containsInstructions: false };

  it('sends the image as a data URL with the perception instructions and clamps the validated output', async () => {
    const f = fake([{ status: 200, body: { choices: [{ message: { content: JSON.stringify(output) } }] } }]);
    const p = await new ChatCompletionsImageDescriber(endpoint, { fetch: f.fetch }).describe({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }, { timeoutMs: 1000 });
    expect(p.description).toHaveLength(600);
    expect(p.visibleText).toHaveLength(20);
    const sent = JSON.parse(f.calls[0]!.body as string);
    expect(sent.messages[1].content[0].image_url.url).toBe('data:image/png;base64,AQID');
    expect(sent.response_format).toEqual({ type: 'json_object' });
    expect(sent.max_tokens).toBe(1500);
    expect(f.calls[0]!.url).toBe('http://127.0.0.1:9/chat/completions');
  });

  it('sends the ceiling as max_completion_tokens when R4_PERCEPTION_VISION_OUTPUT_LIMIT_PARAM says so (OpenAI direct refuses max_tokens)', async () => {
    const env = { R4_MEDIA_PERCEPTION: 'enabled', R4_PERCEPTION_VISION_API_KEY: 'vk', R4_PERCEPTION_VISION_BASE_URL: 'http://127.0.0.1:9' };
    expect(loadPerceptionConfig(env, { allowNetwork: true }).vision).not.toHaveProperty('outputLimitParam');
    expect(() => loadPerceptionConfig({ ...env, R4_PERCEPTION_VISION_OUTPUT_LIMIT_PARAM: 'max_output_tokens' }, { allowNetwork: true })).toThrow(/OUTPUT_LIMIT_PARAM/);
    const vision = loadPerceptionConfig({ ...env, R4_PERCEPTION_VISION_OUTPUT_LIMIT_PARAM: 'max_completion_tokens' }, { allowNetwork: true }).vision!;
    const f = fake([{ status: 200, body: { choices: [{ message: { content: JSON.stringify(output) } }] } }]);
    await new ChatCompletionsImageDescriber(vision, { fetch: f.fetch }).describe({ bytes: new Uint8Array([1]), mimeType: 'image/png' }, { timeoutMs: 1000 });
    const sent = JSON.parse(f.calls[0]!.body as string);
    expect(sent.max_completion_tokens).toBe(1500);
    expect(sent).not.toHaveProperty('max_tokens');
  });

  it('fails on anything but the perception object', async () => {
    for (const answer of [{ status: 500, body: {} }, { status: 200, body: { choices: [{ message: { content: 'not json' } }] } }, { status: 200, body: { choices: [{ message: { content: '{"kind":"product"}' } }] } }]) {
      const f = fake([answer]);
      await expect(new ChatCompletionsImageDescriber(endpoint, { fetch: f.fetch }).describe({ bytes: new Uint8Array([1]), mimeType: 'image/png' }, { timeoutMs: 1000 })).rejects.toThrow();
    }
  });
});

describe('OpenAISpeechTranscriber', () => {
  it('turns token log-probabilities into per-word confidence (a word is as sure as its least sure token)', () => {
    expect(wordsFromLogprobs([{ token: ' man', logprob: Math.log(0.9) }, { token: 'cuerna', logprob: Math.log(0.5) }, { token: ',', logprob: 0 }, { token: ' sí', logprob: Math.log(0.99) }])).toEqual([
      { text: 'mancuerna,', confidence: 0.5 }, { text: 'sí', confidence: expect.closeTo(0.99, 5) },
    ]);
  });

  it('asks for Spanish with the vocabulary prompt and log-probabilities; retries without them when the model refuses `include`', async () => {
    const f = fake([{ status: 400, body: { error: { message: 'logprobs are not supported with this model' } } }, { status: 200, body: { text: ' hola ' } }]);
    const t = await new OpenAISpeechTranscriber(endpoint, { fetch: f.fetch }).transcribe({ bytes: new Uint8Array([1]), mimeType: 'audio/ogg; codecs=opus', filename: 'voice.ogg' }, { timeoutMs: 1000, prompt: 'Pesas Chile' });
    expect(t).toEqual({ text: 'hola', words: null });
    const first = f.calls[0]!.body as FormData;
    expect([first.get('model'), first.get('language'), first.get('prompt'), first.get('include[]')]).toEqual(['m', 'es', 'Pesas Chile', 'logprobs']);
    expect((first.get('file') as File).type).toBe('audio/ogg');
    expect((f.calls[1]!.body as FormData).get('include[]')).toBeNull();
    expect(f.calls[0]!.headers.authorization).toBe('Bearer k');
  });
});
