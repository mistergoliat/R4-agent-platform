#!/usr/bin/env node
// Inbound multimodal v1 — what Meta's real media endpoints do (run on the host that holds the WhatsApp token).
//   node meta-roundtrip.mjs <env file with R4_WHATSAPP_*> <file> [<file> …]
// For each file: upload it to the business number's OWN media store (POST /{phone}/media; nothing is sent to anyone),
// retrieve its URL (GET /{media-id}?phone_number_id=), and download it exactly as WhatsAppMediaDownloader does (Bearer,
// redirect: manual). Reports host, status, redirects, declared size and mime, the format of the stated hash and whether
// it equals the SHA-256 of the bytes downloaded and of the file uploaded. Never prints the token, the URL or bytes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

const [envFile, ...files] = process.argv.slice(2);
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=['"]?(.*?)['"]?$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const base = `${(env.R4_WHATSAPP_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, '')}/${env.R4_WHATSAPP_GRAPH_VERSION || 'v25.0'}`;
const phone = env.R4_WHATSAPP_PHONE_NUMBER_ID;
const auth = { authorization: `Bearer ${env.R4_WHATSAPP_ACCESS_TOKEN}` };
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const hashForm = (h) => (typeof h !== 'string' ? 'absent' : /^[0-9a-f]{64}$/i.test(h) ? 'hex' : /^[A-Za-z0-9+/]{43}=$/.test(h) ? 'base64' : 'other');
const asHex = (h) => (hashForm(h) === 'hex' ? h.toLowerCase() : hashForm(h) === 'base64' ? Buffer.from(h, 'base64').toString('hex') : null);

for (const file of files) {
  const bytes = readFileSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', type);
  form.append('file', new Blob([bytes], { type }), basename(file));
  const up = await fetch(`${base}/${phone}/media`, { method: 'POST', headers: auth, body: form });
  const upBody = await up.json().catch(() => ({}));
  if (up.status !== 200 || !upBody.id) { console.log(JSON.stringify({ file: basename(file), upload: up.status, error: upBody?.error?.code ?? null })); continue; }
  const meta = await fetch(`${base}/${encodeURIComponent(upBody.id)}?phone_number_id=${encodeURIComponent(phone)}`, { headers: { ...auth, accept: 'application/json' }, redirect: 'manual' });
  const m = await meta.json().catch(() => ({}));
  let host = null; let fileStatus = null; let location = null; let got = null; let ms = null;
  if (typeof m.url === 'string') {
    const u = new URL(m.url);
    host = u.hostname;
    const t0 = Date.now();
    const res = await fetch(m.url, { headers: { ...auth, accept: '*/*', 'user-agent': 'r4-agent-platform' }, redirect: 'manual' });
    fileStatus = res.status;
    location = res.headers.get('location') ? new URL(res.headers.get('location')).hostname : null;
    if (res.status === 200) got = Buffer.from(await res.arrayBuffer());
    ms = Date.now() - t0;
  }
  console.log(JSON.stringify({
    file: basename(file), bytes: bytes.length, upload: up.status, meta: meta.status, declaredMime: m.mime_type ?? null, declaredSize: m.file_size ?? null,
    statedHashForm: hashForm(m.sha256), statedHashEqualsUploaded: asHex(m.sha256) === sha(bytes), fileHost: host, fileStatus, redirectTo: location,
    downloadMs: ms, downloadedEqualsUploaded: got ? sha(got) === sha(bytes) : null, statedHashEqualsDownloaded: got ? asHex(m.sha256) === sha(got) : null,
  }));
}
