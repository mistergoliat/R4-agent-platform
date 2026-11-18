// Real DeepSeek judgment of reactions (owner decision: semantic confirmation), frozen-context replay.
// Base: a sales-production@19 context in which a 👍 to the presented offer led to quote.create. Each case replaces the
// reaction input (and, for the non-offer contexts, the tail of the conversation) using the branch's frameReaction; the
// model decides once; then the deterministic layer is applied: the guard (frame) and the reaction → offer binding.
// The base context is a production snapshot exported read-only by the operator (it holds a real conversation): it is
// never committed. Results go to a local file. Only R4_MODEL_* lines of the env file are read; the key is never printed.
//   npm run build
//   node scripts/experiments/reaction-semantics/run.mjs <base.json> <out.jsonl> [reps] [env-file]
// base.json: one line {"offerStep": <respond step id of the offer>, "ctx": <compiled context whose last conversation
// turn is the reaction and the one before it the offer>}.
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { fetch, performance, AbortSignal } = globalThis;
const WT = resolve(import.meta.dirname, '../../..');
const imp = (p) => import(pathToFileURL(`${WT}/${p}`).href);
const { renderMessages, jsonDocumentOf } = await imp('adapters/models/openai-compatible/dist/render.js');
const { PROTOCOL_INSTRUCTIONS, AGENT_DECISION_JSON_SCHEMA } = await imp('packages/agent-kernel/dist/request.js');
const { agentDecisionSchema, CONTEXT_SECTIONS } = await imp('packages/contracts/dist/index.js');
const { frameReaction } = await imp('agents/sales/dist/production/media-perception.js');
const { guardIntentReply } = await imp('agents/sales/dist/capabilities/confirmation-grammar.js');

const env = Object.fromEntries(readFileSync(process.argv[5] ?? resolve(WT, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^R4_MODEL_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^'(.*)'$/, '$1')]));
const [, , baseFile, outFile, reps = '2'] = process.argv;
const base = JSON.parse(readFileSync(baseFile, 'utf8').split('\n').find((l) => l.startsWith('{')));
writeFileSync(outFile, '');
const nonce = randomUUID().slice(0, 8);

const conv = base.ctx.sections.conversation;
const reactionItem = conv.at(-1);
const offerItem = conv.at(-2);
const customerItem = conv.at(-3);
const OFFER_TEXT = offerItem.content.text;
const INFO_STEP = randomUUID();
const QUESTION = '¿y esa banda sirve para dominadas asistidas?';
const INFO = 'Sí, la Medium de 80 lbs sirve para dominadas asistidas: se engancha en la barra y apoya la rodilla o el pie. Si estás partiendo, es una buena intensidad. ¿Te ayudo con algo más?';
const turn = (from, text) => ({ ...from, itemId: `${from.itemId}-${randomUUID().slice(0, 6)}`, content: { ...from.content, text } });

function contextFor(kind, emoji) {
  const sections = { ...base.ctx.sections };
  const head = conv.slice(0, -1);
  let reaction;
  if (kind === 'offer') reaction = frameReaction({ emoji, target: { text: OFFER_TEXT, latest: true, stepId: base.offerStep } });
  if (kind === 'info') reaction = frameReaction({ emoji, target: { text: INFO, latest: true, stepId: INFO_STEP } });
  if (kind === 'earlier_offer') reaction = frameReaction({ emoji, target: { text: OFFER_TEXT, latest: false, stepId: base.offerStep } });
  if (kind === 'unknown') reaction = frameReaction({ emoji, target: null }); // a PDF, a platform notice or a photo
  const tail = kind === 'info' || kind === 'earlier_offer' ? [turn(customerItem, QUESTION), turn(offerItem, INFO)] : [];
  sections.conversation = [...head, ...tail, turn(reactionItem, reaction)];
  return { ctx: { ...base.ctx, sections: Object.fromEntries(CONTEXT_SECTIONS.map((s) => [s, sections[s] ?? []])) }, reaction };
}

const CASES = [
  ...['👍', '✅', '👌', '❤️', '🔥', '😍', '🙏', '😮', '🫶', '👎', '🤔', '😂'].map((e) => ['offer', e]),
  ...['👍', '❤️', '🔥'].map((e) => ['info', e]),
  ...['👍', '❤️'].map((e) => ['earlier_offer', e]),
  ...['👍', '✅'].map((e) => ['unknown', e]),
];

let usd = 0;
for (let rep = 1; rep <= Number(reps); rep += 1) {
  for (const [kind, emoji] of CASES) {
    if (usd > 0.8) throw new Error('budget');
    const { ctx, reaction } = contextFor(kind, emoji);
    const request = { messages: [{ role: 'system', content: PROTOCOL_INSTRUCTIONS }], context: ctx, outputContract: { kind: 'json', name: 'agent_decision', schema: AGENT_DECISION_JSON_SCHEMA } };
    const body = { model: env.R4_MODEL_NAME, thinking: { type: 'enabled' }, response_format: { type: 'json_object' }, stream: false, messages: [{ role: 'system', content: `Session ${nonce}-${rep}.` }, ...renderMessages(request)] };
    const t0 = performance.now();
    const res = await fetch(`${env.R4_MODEL_BASE_URL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.R4_MODEL_API_KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const json = await res.json();
    const u = json.usage ?? {}; const hit = u.prompt_cache_hit_tokens ?? 0;
    usd += (hit * 0.006 + ((u.prompt_tokens ?? 0) - hit) * 0.3 + (u.completion_tokens ?? 0) * 1.2) / 1e6;
    const doc = jsonDocumentOf(json.choices?.[0]?.message?.content ?? null);
    const parsed = agentDecisionSchema.safeParse(doc);
    const d = parsed.success ? parsed.data : null;
    const proposesIssue = d?.type === 'propose_action' && d.capabilityId === 'quote.create';
    const guard = guardIntentReply(reaction);
    // The binding: the reacted step must be the offer quote.create issues (only the 'offer' context reacts to it).
    const bound = guard.confirmed && guard.reactedStepId === base.offerStep;
    const issued = proposesIssue && guard.confirmed && bound;
    const row = { rep, kind, emoji, decision: d ? (d.type === 'respond' ? 'respond' : `${d.type}:${d.capabilityId}`) : 'INVALID', reply: d?.type === 'respond' ? d.content.slice(0, 220) : null, guard: guard.confirmed, bound, issued, ms: Math.round(performance.now() - t0) };
    appendFileSync(outFile, `${JSON.stringify(row)}\n`);
    process.stdout.write(`${rep} ${kind.padEnd(13)} ${emoji} ${row.decision.padEnd(28)} guard=${guard.confirmed} bound=${bound} → ${issued ? 'ISSUED' : 'not issued'}${row.reply ? ` | ${row.reply.slice(0, 90).replace(/\n/g, ' ')}` : ''}\n`);
  }
}
process.stdout.write(`spent ~US$${usd.toFixed(3)} (peak prices)\n`);
