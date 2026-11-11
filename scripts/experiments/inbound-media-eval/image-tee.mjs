#!/usr/bin/env node
// Image L3, phase 2 router ("tee") — installed ONLY with the owner's authorization (nginx proxies the webhook here).
//   node image-tee.mjs <production.env>            listens on 127.0.0.1:8095
// Routes each WhatsApp notification, unchanged (raw body and signature), to exactly ONE gateway:
//   - the isolated EVALUATOR (127.0.0.1:8093) only when it carries nothing but image messages, all from conversations in
//     the production lane allowlist (decided by HMAC with the production key: no number is configured or logged);
//   - PRODUCTION (127.0.0.1:8090) for everything else: text, other media, other senders, statuses, verification.
// If the evaluator does not answer, the notification goes to production (which holds the image for a person, as today).
// Logs one line per decision with counts only. Never logs bodies, numbers, signatures or keys.
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';

const PROD = { host: '127.0.0.1', port: 8090 };
const EVAL = { host: '127.0.0.1', port: 8093 };
const WEBHOOK = '/v1/channels/whatsapp/webhook';
const say = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

export function routeFor(rawBody, { identityKey, phoneNumberId, laneKeys }) {
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return 'production'; }
  const values = (payload?.entry ?? []).flatMap((e) => (e?.changes ?? []).map((c) => c?.value ?? {}));
  const messages = values.flatMap((v) => v.messages ?? []);
  const statuses = values.flatMap((v) => v.statuses ?? []);
  if (messages.length === 0 || statuses.length > 0) return 'production';
  const keyOf = (from) => createHmac('sha256', identityKey).update(`whatsapp\u0000${phoneNumberId}\u0000${String(from).replace(/[\s()+-]/g, '')}`, 'utf8').digest('hex');
  const allImagesFromLane = values.every((v) => v?.metadata?.phone_number_id === phoneNumberId) && messages.every((m) => m?.type === 'image' && laneKeys.has(keyOf(m.from)));
  return allImagesFromLane ? 'evaluator' : 'production';
}

function forward(target, req, body) {
  return new Promise((resolve, reject) => {
    const up = request({ ...target, method: req.method, path: req.url, headers: { ...req.headers, host: `${target.host}:${target.port}` }, timeout: 15_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    up.on('error', reject);
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.end(body);
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const env = Object.fromEntries(readFileSync(process.argv[2], 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=['"]?(.*?)['"]?$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
  const config = { identityKey: env.R4_PROD_IDENTITY_HASH_KEY, phoneNumberId: env.R4_WHATSAPP_PHONE_NUMBER_ID, laneKeys: new Set((env.R4_PROD_LANE_ALLOWLIST ?? '').split(/[\s,]+/).filter(Boolean)) };
  createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const route = req.method === 'POST' && req.url === WEBHOOK ? routeFor(body.toString('utf8'), config) : 'production';
      let out;
      try {
        out = await forward(route === 'evaluator' ? EVAL : PROD, req, body);
      } catch {
        // The evaluator is down: production takes it (the image is held for a person, exactly as today).
        out = route === 'evaluator' ? await forward(PROD, req, body).catch(() => ({ status: 502, headers: {}, body: Buffer.alloc(0) })) : { status: 502, headers: {}, body: Buffer.alloc(0) };
        say(`route=${route} fallback=production status=${out.status}`);
      }
      say(`route=${route} status=${out.status} bytes=${body.length}`);
      res.writeHead(out.status, { 'content-type': out.headers['content-type'] ?? 'application/json' }).end(out.body);
    });
  }).listen(8095, '127.0.0.1', () => say('image tee listening on 127.0.0.1:8095'));
}
