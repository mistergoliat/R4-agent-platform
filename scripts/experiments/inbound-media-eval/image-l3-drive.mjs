#!/usr/bin/env node
// Image L3, phase 1 (no production change): a REAL image goes through Meta's real media store and the isolated evaluator.
//   cd ~/r4-eval-pr70 && node scripts/experiments/inbound-media-eval/image-l3-drive.mjs <image> [<image> …]
// For each image: upload it to the business number's own media store (Meta; nothing is sent to anyone), then deliver to
// the EVALUATOR gateway (127.0.0.1:8093) a webhook signed exactly like Meta's, as an image message from a lane-allowlisted
// identity (chosen by HMAC from production's bindings, never printed). The evaluator downloads it from Meta, perceives it
// with deepseek-flash, and its lane worker (@19, write budget 0) answers. Collects the evidence; the reply is NOT sent
// unless the evaluator was started with dispatch. Prints no number, token, URL or key.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const { fetch, FormData, Blob } = globalThis;
const say = (line) => process.stdout.write(`${line}\n`);
const parse = (f) => Object.fromEntries(readFileSync(f, 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=['"]?(.*?)['"]?$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const prod = parse(`${homedir()}/.config/r4/production.env`);
const evalGw = parse(`${homedir()}/.config/r4-eval/gateway.env`);
const graph = `${(prod.R4_WHATSAPP_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, '')}/${prod.R4_WHATSAPP_GRAPH_VERSION || 'v25.0'}`;
const phone = prod.R4_WHATSAPP_PHONE_NUMBER_ID;
const key = (waId) => createHmac('sha256', prod.R4_PROD_IDENTITY_HASH_KEY).update(`whatsapp\u0000${phone}\u0000${waId}`, 'utf8').digest('hex');
const laneKeys = new Set((prod.R4_PROD_LANE_ALLOWLIST ?? '').split(/[\s,]+/).filter(Boolean));
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const sleep = (ms) => delay(ms);
const logLines = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const prodDb = new pg.Client({ connectionString: prod.R4_DATABASE_URL, application_name: 'r4-image-l3-drive-ro' });
await prodDb.connect();
const from = (await prodDb.query('select distinct recipient_ref from channel_conversation_bindings')).rows.map((r) => r.recipient_ref).find((n) => laneKeys.has(key(n)));
await prodDb.end();
if (!from) throw new Error('no lane-allowlisted identity found');
const evalDb = new pg.Client({ connectionString: evalGw.R4_DATABASE_URL, application_name: 'r4-image-l3-drive' });
await evalDb.connect();
const q = async (sql, params = []) => (await evalDb.query(sql, params)).rows;

for (const file of process.argv.slice(2)) {
  const bytes = readFileSync(file);
  const type = MIME[extname(file).toLowerCase()];
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', type);
  form.append('file', new Blob([bytes], { type }), basename(file));
  const up = await fetch(`${graph}/${phone}/media`, { method: 'POST', headers: { authorization: `Bearer ${prod.R4_WHATSAPP_ACCESS_TOKEN}` }, body: form });
  const mediaId = (await up.json()).id;
  if (!mediaId) { say(JSON.stringify({ file: basename(file), metaUpload: up.status })); continue; }
  const wamid = `wamid.r4-image-l3-eval.${createHash('sha256').update(`${file}${Date.now()}`).digest('hex').slice(0, 24)}`;
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'eval', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: 'eval', phone_number_id: phone },
    messages: [{ from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: mediaId, mime_type: type, sha256: createHash('sha256').update(bytes).digest('base64') } }] } }] }] });
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${evalGw.R4_GATEWAY_PORT}/v1/channels/whatsapp/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', prod.R4_WHATSAPP_APP_SECRET).update(body, 'utf8').digest('hex')}` }, body });
  const ack = await res.json();
  const ackMs = Date.now() - t0;
  let inbound = null;
  for (let i = 0; i < 120 && !inbound; i += 1) { [inbound] = await q(`select inbound_id, task_id, input_id, disposition, status from inbound_events where provider_event_id = $1 and status <> 'received'`, [wamid]); if (!inbound) await sleep(500); }
  const settledMs = Date.now() - t0;
  let reply = null;
  for (let i = 0; i < 240 && inbound?.task_id && !reply; i += 1) {
    [reply] = await q(`select body, status, created_at from outbound_messages where task_id = $1 and created_at > (select received_at from inbound_events where provider_event_id = $2) order by created_at limit 1`, [inbound.task_id, wamid]);
    if (!reply) await sleep(500);
  }
  const replyMs = Date.now() - t0;
  await sleep(1500);
  const [input] = inbound?.input_id ? await q(`select m.content #>> '{text}' as text from task_inputs i join memory_entries m on m.entry_id = i.memory_entry_id where i.input_id = $1`, [inbound.input_id]) : [];
  const perceived = logLines(`${homedir()}/r4-eval-pr70/eval-logs/gateway.log`).filter((l) => l.event === 'inbound.media.perceived' && l.inboundId === inbound?.inbound_id).at(-1);
  const workerLines = logLines(`${homedir()}/r4-eval-pr70/eval-logs/lane.log`).filter((l) => l.taskId === inbound?.task_id || l.task_id === inbound?.task_id);
  const capabilities = workerLines.filter((l) => l.event === 'capability.invoked' || l.event === 'capability.invocation.completed').map((l) => l.capabilityId ?? l.capability).filter(Boolean);
  const modelCalls = workerLines.filter((l) => l.event === 'model.call.completed').map((l) => ({ model: l.model ?? l.modelId ?? null, ms: l.latencyMs ?? l.durationMs ?? null, in: l.inputTokens ?? l.usage?.inputTokens ?? null, out: l.outputTokens ?? l.usage?.outputTokens ?? null }));
  const writes = (await q(`select count(*)::int as n from action_executions where task_id = $1`, [inbound?.task_id ?? '00000000-0000-0000-0000-000000000000']))[0].n;
  say(JSON.stringify({
    file: basename(file), bytes: bytes.length, metaUpload: up.status, webhookAck: { status: res.status, ...ack, ms: ackMs },
    inbound: inbound && { disposition: inbound.disposition, settledMs }, perception: perceived && { outcome: perceived.outcome, reason: perceived.reason, model: perceived.model, format: perceived.format, byteLength: perceived.byteLength, sha256MatchesFile: perceived.sha256 === createHash('sha256').update(bytes).digest('hex'), downloadMs: perceived.downloadMs, perceptionMs: perceived.perceptionMs, containsInstructions: perceived.containsInstructions },
    interpretation: input?.text ?? null, capabilities, modelCalls, commercialWrites: writes, reply: reply ? { status: reply.status, text: reply.body, ms: replyMs } : null,
  }, null, 1));
}
await evalDb.end();
