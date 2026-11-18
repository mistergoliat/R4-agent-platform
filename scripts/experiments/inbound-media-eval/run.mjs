#!/usr/bin/env node
// Inbound multimodal v1 — isolated evaluation with REAL WhatsApp files (PR #70 code, real providers, no production).
//
//   node scripts/experiments/inbound-media-eval/run.mjs <media-dir> [--env <env file>] [--runs 1]
//
// <media-dir> holds files exported from WhatsApp (voice notes .opus/.ogg, photos .jpg/.png, audio .mp3/.m4a) and an
// `expected.json`: { "<file>": { "kind": "image|audio", "voice": true|false, "expected": "<what it says / shows>" } }.
// Each file goes through the SAME code the gateway composes: SalesMediaPerceiver + ChatCompletionsImageDescriber
// (DeepSeek deepseek-flash) / OpenAISpeechTranscriber (OpenAI gpt-transcribe), with a local downloader in place of
// Meta's. Records per file: outcome, framed text, provider-reported model, latency, token usage and estimated cost.
// Credentials come from the env file (R4_PERCEPTION_VISION_API_KEY, else R4_MODEL_API_KEY; R4_PERCEPTION_STT_API_KEY)
// and are never printed. Results go to <media-dir>/results.json and results.md (they contain the files' content:
// keep them out of the repository).

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ChatCompletionsImageDescriber, OpenAISpeechTranscriber } from '@r4-adapters/openai-compatible';
import { SALES_IMAGE_PERCEPTION_INSTRUCTIONS, SALES_TRANSCRIPTION_PROMPT, SalesMediaPerceiver } from '@r4-sales/agent/production';
import { URL } from 'node:url';

const { fetch } = globalThis;

const [dir, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
if (!dir) { process.stderr.write('usage: run.mjs <media-dir> [--env <file>] [--runs N]\n'); process.exit(2); }
const envText = readFileSync(opt('--env', '.env'), 'utf8');
const env = Object.fromEntries(envText.split('\n').map((l) => /^([A-Z0-9_]+)=['"]?(.*?)['"]?$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const runs = Number(opt('--runs', '1'));

// Prices (USD per million tokens / per minute) — published rates change: override with env when they do.
const PRICE = {
  visionIn: Number(env.EVAL_PRICE_DEEPSEEK_IN_PER_M ?? 0.44), visionOut: Number(env.EVAL_PRICE_DEEPSEEK_OUT_PER_M ?? 1.32),
  sttPerMin: Number(env.EVAL_PRICE_STT_PER_MIN ?? 0.006), sttAudioInPerM: Number(env.EVAL_PRICE_STT_AUDIO_IN_PER_M ?? 0), sttTextOutPerM: Number(env.EVAL_PRICE_STT_TEXT_OUT_PER_M ?? 0),
};

/** Wraps fetch to observe what the provider reports (model, usage, status, timing) — never the credentials. */
function observingFetch(log) {
  return async (url, init) => {
    const t0 = Date.now();
    const res = await fetch(url, init);
    const text = await res.clone().text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    log.push({ endpoint: new URL(url).pathname, status: res.status, ms: Date.now() - t0, model: body?.model ?? null, usage: body?.usage ?? null, error: res.status === 200 ? null : (body?.error?.message ?? text).slice(0, 200) });
    return res;
  };
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.opus': 'audio/ogg; codecs=opus', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac' };
const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
const files = readdirSync(dir).filter((f) => MIME[extname(f).toLowerCase()]).sort();
const visionKey = env.R4_PERCEPTION_VISION_API_KEY || env.R4_MODEL_API_KEY;
const sttKey = env.R4_PERCEPTION_STT_API_KEY;
const results = [];

for (const file of files) {
  const mimeType = MIME[extname(file).toLowerCase()];
  const kind = mimeType.startsWith('image/') ? 'image' : 'audio';
  const exp = expected[file] ?? {};
  for (let run = 1; run <= runs; run += 1) {
    const log = [];
    const fetchImpl = observingFetch(log);
    const perceiver = new SalesMediaPerceiver({
      downloader: { download: async () => ({ ok: true, bytes: new Uint8Array(readFileSync(join(dir, file))), mimeType }) },
      ...(visionKey ? { describer: new ChatCompletionsImageDescriber({ baseUrl: env.R4_PERCEPTION_VISION_BASE_URL || 'https://api.deepseek.com', apiKey: visionKey, model: env.R4_PERCEPTION_VISION_MODEL || 'deepseek-flash' }, { fetch: fetchImpl, instructions: SALES_IMAGE_PERCEPTION_INSTRUCTIONS }) } : {}),
      ...(sttKey ? { transcriber: new OpenAISpeechTranscriber({ baseUrl: env.R4_PERCEPTION_STT_BASE_URL || 'https://api.openai.com/v1', apiKey: sttKey, model: env.R4_PERCEPTION_STT_MODEL || 'gpt-transcribe' }, { fetch: fetchImpl }) } : {}),
      transcriptionPrompt: SALES_TRANSCRIPTION_PROMPT,
    });
    const t0 = Date.now();
    const r = await perceiver.perceive({ kind, mediaId: file, mimeType, sha256: null, caption: null, voice: exp.voice ?? (kind === 'audio' && /\.(opus|ogg)$/i.test(file)) }, { accountRef: 'eval' });
    const totalMs = Date.now() - t0;
    const call = log.at(-1) ?? null;
    let cost = null;
    if (call?.usage && kind === 'image') cost = (call.usage.prompt_tokens * PRICE.visionIn + call.usage.completion_tokens * PRICE.visionOut) / 1e6;
    else if (kind === 'audio' && r.evidence.durationSeconds !== null) cost = (r.evidence.durationSeconds / 60) * PRICE.sttPerMin;
    if (kind === 'audio' && call?.usage?.input_token_details?.audio_tokens !== undefined && PRICE.sttAudioInPerM > 0) cost = (call.usage.input_token_details.audio_tokens * PRICE.sttAudioInPerM + (call.usage.output_tokens ?? 0) * PRICE.sttTextOutPerM) / 1e6;
    results.push({ file, run, kind, bytes: r.evidence.byteLength, durationSeconds: r.evidence.durationSeconds, outcome: r.outcome, reason: r.reason, requestedModel: r.evidence.model, providerModel: call?.model ?? null, providerCalls: log.map(({ endpoint, status, ms, error }) => ({ endpoint, status, ms, error })), perceptionMs: r.evidence.perceptionMs, totalMs, usage: call?.usage ?? null, estimatedCostUsd: cost, uncertainWords: r.evidence.uncertainWords, containsInstructions: r.evidence.containsInstructions, expected: exp.expected ?? null, text: r.text });
    process.stdout.write(`${file} #${run}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''} ${totalMs} ms ${call?.model ?? ''}\n`);
  }
}
writeFileSync(join(dir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), prices: PRICE, results }, null, 2));
const md = ['| File | Run | Outcome | Model (provider) | ms | Cost USD | Doubtful words |', '|---|---|---|---|---|---|---|',
  ...results.map((x) => `| ${x.file} | ${x.run} | ${x.outcome}${x.reason ? ` (${x.reason})` : ''} | ${x.providerModel ?? x.requestedModel ?? '-'} | ${x.totalMs} | ${x.estimatedCostUsd === null ? '-' : x.estimatedCostUsd.toFixed(5)} | ${x.uncertainWords ?? '-'} |`),
  '', ...results.map((x) => `### ${x.file} (#${x.run})\n\n**Expected:** ${x.expected ?? '-'}\n\n\`\`\`\n${x.text}\n\`\`\`\n`)];
writeFileSync(join(dir, 'results.md'), md.join('\n'));
process.stdout.write(`results: ${join(dir, 'results.md')}\n`);
