#!/usr/bin/env node
// R4 identity HMAC rotation: conversation continuity, proven with the DEPLOYED code's own lineage queries.
//
//   continuity.mjs snapshot --env-file F [--env-file F] --out SNAP [--repo DIR] [--window-days 30]
//   continuity.mjs check    --env-file F [--env-file F] --snapshot SNAP [--repo DIR] [--require-message]
//
// `snapshot` (before the rotation, production stopped) records, for every conversation identity whose bindings verify
// under the key the env files hold: its bindings, its open binding and task, the earlier tasks of its newest task
// (ProductionStore.earlierConversationTasks: quote recovery's lineage), the quotes quote recovery finds there
// (PostgresSalesStore.conversationQuotes), the earlier turns carried to it (ProductionStore.earlierConversationTurns),
// and the key lists it is in. Subjects are identified by binding id only: the snapshot holds no key, wa_id or derived
// key (0600 anyway).
// `check` (after the rotation, or after a rollback: it works under whatever key the env files hold) recomputes each
// subject's key from its own binding inputs and proves: every snapshot binding is still in the conversation; nothing
// was opened for the same contact under another key; the same lineage, quotes and turns are found; the subject is in
// exactly the same lists; and any newer binding (a case opened after the snapshot, e.g. after an idle close) carries the
// earlier tasks and quotes. It also reports per subject whether a message reached the conversation after the snapshot and
// where it landed (input counts, no clock); --require-message fails unless at least one listed subject (a tester) wrote.
// Prints indexes, labels and counts only. Exit 0 = continuity proven, 1 = a failure (named), 2 = usage.

import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { keyListsOf, parseEnvFile } from './rotation.mjs';

const MAX_TASKS = 50;
const out = (v) => process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);
const usage = (m) => {
  process.stderr.write(`${m}\n`);
  process.exit(2);
};

const [mode, ...rest] = process.argv.slice(2);
const args = { envFiles: [], out: null, snapshot: null, repo: process.env.R4_REPO ?? join(homedir(), 'R4-agent-platform'), windowDays: 30, requireMessage: false };
for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i];
  if (a === '--env-file') args.envFiles.push(rest[++i]);
  else if (a === '--out') args.out = rest[++i];
  else if (a === '--snapshot') args.snapshot = rest[++i];
  else if (a === '--repo') args.repo = rest[++i];
  else if (a === '--window-days') args.windowDays = Number(rest[++i]);
  else if (a === '--require-message') args.requireMessage = true;
  else usage(`unknown argument ${a}`);
}
if (!['snapshot', 'check'].includes(mode) || args.envFiles.length === 0) usage('usage: see the header of continuity.mjs');
if (mode === 'snapshot' && !args.out) usage('snapshot needs --out');
if (mode === 'check' && !args.snapshot) usage('check needs --snapshot');

const env = Object.assign({}, ...args.envFiles.map((f) => parseEnvFile(readFileSync(f, 'utf8'))));
const key = env.R4_PROD_IDENTITY_HASH_KEY ?? '';
if (key.length < 32) usage('the env files hold no R4_PROD_IDENTITY_HASH_KEY');
const lists = keyListsOf(env);
const keyOf = (b) => createHmac('sha256', key).update(`${b.channel}\u0000${b.account_ref}\u0000${b.recipient_ref}`, 'utf8').digest('hex');
const listsOf = (k) => Object.keys(lists).filter((name) => lists[name].includes(k));

// pg and the lineage queries come from the deployed repository, never a copy of their SQL (the tool may run from a backup copy).
const pg = createRequire(join(args.repo, 'package.json'))('pg');
const { PostgresProductionStore } = await import(pathToFileURL(join(args.repo, 'packages/persistence-postgres/dist/index.js')).href);
const { PostgresSalesStore } = await import(pathToFileURL(join(args.repo, 'agents/sales/dist/workspace/store.js')).href);
const pool = new pg.Pool({ connectionString: process.env.R4_ROTATION_DATABASE_URL || env.R4_DATABASE_URL, max: 2, application_name: 'r4-identity-continuity' });
const store = new PostgresProductionStore(pool);
const sales = new PostgresSalesStore(pool);

/** What the deployed code finds for one task: its earlier tasks, the quotes recovery shows, the turns carried. */
async function seen(taskId, since) {
  const lineage = await store.earlierConversationTasks(taskId, MAX_TASKS);
  const quotes = (await sales.conversationQuotes([taskId, ...lineage], { since, limit: 500 })).map((q) => q.quoteId).sort();
  const t = await store.earlierConversationTurns(taskId, { since, limit: 1000, maxTasks: MAX_TASKS });
  const turns = { count: t.turns.length, earlierTasks: t.earlierTasks, digest: createHash('sha256').update(t.turns.map((x) => x.cursor ?? JSON.stringify(x)).join('|')).digest('hex').slice(0, 16) };
  return { lineage, quotes, turns };
}
const rowsOf = async (sql, params) => (await pool.query(sql, params)).rows;
const newest = (group) => [...group].reverse().find((b) => b.task_id) ?? null;
const inputsOf = async (group) => Number((await rowsOf('select count(*) as n from task_inputs where task_id = any($1::uuid[])', [group.map((b) => b.task_id).filter(Boolean)]))[0].n);

try {
  const all = await rowsOf('select binding_id, channel, conversation_key, account_ref, recipient_ref, status, task_id, created_at from channel_conversation_bindings order by created_at, binding_id');
  if (mode === 'snapshot') {
    const takenAt = new Date().toISOString();
    const since = new Date(Date.now() - args.windowDays * 86_400_000).toISOString();
    const groups = new Map();
    let unverified = 0;
    for (const b of all) {
      if (keyOf(b) !== b.conversation_key) {
        unverified += 1;
        continue;
      }
      const g = `${b.channel}\u0000${b.conversation_key}`;
      groups.set(g, [...(groups.get(g) ?? []), b]);
    }
    const subjects = [];
    for (const group of groups.values()) {
      const rep = newest(group);
      const open = group.find((b) => b.status === 'open') ?? null;
      subjects.push({
        rep: (rep ?? group.at(-1)).binding_id,
        repTask: rep?.task_id ?? null,
        group: group.map((b) => b.binding_id),
        open: open ? { bindingId: open.binding_id, taskId: open.task_id } : null,
        lists: listsOf(group[0].conversation_key),
        inputs: await inputsOf(group),
        ...(rep ? await seen(rep.task_id, since) : { lineage: [], quotes: [], turns: null }),
      });
    }
    const listed = Object.fromEntries(Object.entries(lists).map(([n, ks]) => [n, ks.length]));
    const covered = Object.fromEntries(Object.keys(lists).map((n) => [n, subjects.filter((s) => s.lists.includes(n)).length]));
    writeFileSync(args.out, JSON.stringify({ version: 1, takenAt, since, listed, subjects }), { mode: 0o600 });
    out({ mode, subjects: subjects.length, open: subjects.filter((s) => s.open).length, withEarlierTasks: subjects.filter((s) => s.lineage.length > 0).length, withQuotes: subjects.filter((s) => s.quotes.length > 0).length, unverifiedBindings: unverified, lists: listed, listedSubjects: covered, written: args.out });
  } else {
    const snap = JSON.parse(readFileSync(args.snapshot, 'utf8'));
    const byId = new Map(all.map((b) => [b.binding_id, b]));
    const failures = [];
    const lines = [];
    let testersWrote = 0;
    let messages = 0;
    for (const [i, s] of snap.subjects.entries()) {
      const label = `#${i + 1}${s.lists.length ? ` [${s.lists.map((n) => n.replace('R4_PROD_', '').toLowerCase()).join(',')}]` : ''}`;
      const fail = (why) => failures.push(`${label}: ${why}`);
      const rep = byId.get(s.rep);
      if (!rep) {
        fail('its binding is gone');
        continue;
      }
      const k = keyOf(rep);
      if (rep.conversation_key !== k) {
        fail('its binding does not verify under the configured key');
        continue;
      }
      const group = all.filter((b) => b.channel === rep.channel && b.conversation_key === k);
      const ids = new Set(group.map((b) => b.binding_id));
      const lost = s.group.filter((id) => !ids.has(id)).length;
      if (lost > 0) fail(`${lost} of its bindings left the conversation (lineage cut)`);
      const stale = all.filter((b) => b.channel === rep.channel && b.account_ref === rep.account_ref && b.recipient_ref === rep.recipient_ref && b.conversation_key !== k && b.created_at.toISOString() > snap.takenAt).length;
      if (stale > 0) fail(`${stale} binding(s) opened for this contact under another key (a process still runs with the old key)`);
      const now = sameLists(listsOf(k), s.lists);
      if (!now) fail(`its list membership changed (was ${s.lists.join(',') || 'none'}, now ${listsOf(k).join(',') || 'none'})`);
      if (s.repTask) {
        const again = await seen(s.repTask, snap.since);
        if (JSON.stringify(again.lineage) !== JSON.stringify(s.lineage)) fail(`earlier tasks differ (${s.lineage.length} → ${again.lineage.length})`);
        if (JSON.stringify(again.quotes) !== JSON.stringify(s.quotes)) fail(`recovered quotes differ (${s.quotes.length} → ${again.quotes.length})`);
        if (JSON.stringify(again.turns) !== JSON.stringify(s.turns)) fail(`carried turns differ (${s.turns.count} → ${again.turns.count})`);
      }
      const newer = group.filter((b) => !s.group.includes(b.binding_id));
      const latest = newest(newer);
      if (latest && s.repTask) {
        const next = await seen(latest.task_id, snap.since);
        if (!next.lineage.includes(s.repTask)) fail('a newer case does not see the earlier tasks');
        const missing = s.quotes.filter((q) => !next.quotes.includes(q)).length;
        if (missing > 0) fail(`a newer case does not recover ${missing} earlier quote(s)`);
        if (next.turns.count < s.turns.count) fail('a newer case carries fewer earlier turns');
      }
      const stillOpen = s.open && group.some((b) => b.binding_id === s.open.bindingId && b.status === 'open');
      const where = stillOpen ? 'same open binding and task' : latest ? 'new case with lineage' : s.open ? 'case closed since (the next message opens a new case with lineage)' : 'no open case';
      // Messages after the snapshot: counted, not timed (the temporal clock of task inputs is not the wall clock).
      const inputs = (await inputsOf(group)) - s.inputs;
      const arrived = Number((await rowsOf('select count(*) as n from inbound_events where channel = $1 and conversation_key = $2 and received_at > $3', [rep.channel, k, snap.takenAt]))[0].n);
      messages += inputs;
      if (arrived > 0 && inputs === 0) fail(`${arrived} message(s) arrived after the snapshot but none reached the conversation's tasks (held or refused)`);
      if (inputs > 0 && s.lists.length > 0) testersWrote += 1;
      const on = inputs === 0 ? 'none' : stillOpen && newer.length === 0 ? 'landed on the same binding and task' : 'landed on a new case with lineage';
      lines.push(`${label} ${where}; earlier tasks ${s.lineage.length}; quotes ${s.quotes.length}; turns ${s.turns?.count ?? 0}; message after the snapshot: ${on}`);
    }
    for (const [name, n] of Object.entries(snap.listed)) if ((lists[name]?.length ?? 0) !== n) failures.push(`${name} has ${lists[name]?.length ?? 0} entries (was ${n})`);
    if (args.requireMessage && testersWrote === 0) failures.push('no listed subject (tester) wrote after the snapshot: ask one to send a message, then rerun');
    for (const l of lines) out(l);
    out({ mode, subjects: snap.subjects.length, testersWrote, inputsSinceSnapshot: messages, failures, ok: failures.length === 0 });
    process.exitCode = failures.length === 0 ? 0 : 1;
  }
} catch (error) {
  process.stderr.write(`${mode} failed: ${error?.code ? `[${error.code}] ` : ''}${String(error?.message ?? error).replace(/[0-9a-f]{32,}/g, '<hex>')}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

function sameLists(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}
