// R4 identity HMAC rotation (R4_PROD_IDENTITY_HASH_KEY). Pure logic over a `pg` client; the CLI is rotate.mjs.
//
// conversationKey = HMAC-SHA256(key as UTF-8, channel \0 accountRef \0 conversationRef) as 64 lowercase hex
// (packages/live-ops/src/rollout.ts). Every channel_conversation_bindings row keeps the inputs of its own key
// (channel, account_ref, recipient_ref), so each stored key can be VERIFIED under the old key and recomputed under the
// new one. A row is rewritten only when it verifies; nothing is ever reassigned by guesswork.
//
// Never prints, logs or returns a key, a wa_id or a derived key value: results are counts and reasons.

import { createHmac } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

export const BINDING_TRIGGER = 'channel_conversation_bindings_identity_immutable';

export function conversationKeyOf(key, channel, accountRef, conversationRef) {
  return createHmac('sha256', key).update(`${channel}\u0000${accountRef}\u0000${conversationRef}`, 'utf8').digest('hex');
}

function assertKeys(oldKey, newKey) {
  if (typeof oldKey !== 'string' || oldKey.length < 32) throw new Error('the old key must be the configured key (>= 32 characters)');
  if (typeof newKey !== 'string' || newKey.length < 32) throw new Error('the new key must be >= 32 characters');
  if (oldKey === newKey) throw new Error('the new key equals the old key');
}

/** The variables a rotation rewrites in the deployment env files. */
export const MANAGED_VARS = Object.freeze(['R4_PROD_IDENTITY_HASH_KEY', 'R4_PROD_ROLLOUT_ALLOWLIST', 'R4_PROD_ROLLOUT_DENYLIST', 'R4_PROD_LANE_ALLOWLIST']);

/**
 * Shape problems that would make the env rewrite unsafe: a managed variable defined more than once (in one file or
 * across files), with `export`, or indented. `files` is [{ name, text }]. Returns problem strings (no values).
 */
export function envShapeProblems(files) {
  const problems = [];
  const seen = new Map();
  for (const { name, text } of files) {
    for (const line of text.split('\n')) {
      for (const v of MANAGED_VARS) {
        if (!new RegExp(`(^|\\s)(export\\s+)?${v}=`).test(line)) continue;
        if (!line.startsWith(`${v}=`)) problems.push(`${name}: ${v} is not a plain unindented assignment`);
        seen.set(v, [...(seen.get(v) ?? []), name]);
      }
    }
  }
  for (const [v, where] of seen) if (where.length > 1) problems.push(`${v} is defined ${where.length} times (${where.join(', ')})`);
  return problems;
}

/**
 * Installs the new values (`next`: { VAR: value }) in place in each env file that defines them: written to a temporary
 * file and renamed (atomic, same mode), then re-read and checked. Refuses on any shape problem; throws if a file does
 * not end up with exactly the new values or still contains any of `forbidden` (old key, old list entries). Counts only.
 */
export function installEnv(paths, next, forbidden) {
  const files = paths.map((p) => ({ name: p, text: readFileSync(p, 'utf8') }));
  const problems = envShapeProblems(files);
  if (problems.length > 0) throw new Error(`refusing to rewrite the env files: ${problems.join('; ')}`);
  const report = [];
  for (const { name, text } of files) {
    let updated = 0;
    const out = text.split('\n').map((line) => {
      const v = /^([A-Z0-9_]+)=/.exec(line)?.[1];
      if (v && Object.prototype.hasOwnProperty.call(next, v)) {
        updated += 1;
        return `${v}='${next[v]}'`;
      }
      return line;
    }).join('\n');
    if (updated > 0) {
      const tmp = `${name}.rotation-tmp`;
      writeFileSync(tmp, out, { mode: statSync(name).mode & 0o777 });
      renameSync(tmp, name);
    }
    report.push({ file: name.split('/').pop(), updated });
  }
  // Postcondition: every managed value present is the new one, and no forbidden value survives anywhere.
  const merged = Object.assign({}, ...paths.map((p) => parseEnvFile(readFileSync(p, 'utf8'))));
  for (const [v, value] of Object.entries(next)) if (merged[v] !== value) throw new Error(`after the rewrite ${v} does not hold the new value`);
  for (const p of paths) {
    const text = readFileSync(p, 'utf8');
    const left = forbidden.filter((f) => f.length >= 32 && text.includes(f)).length;
    if (left > 0) throw new Error(`after the rewrite ${p.split('/').pop()} still contains ${left} old value(s)`);
  }
  return report;
}

/** `KEY=value` lines of an env file (quotes stripped); comments and blanks ignored. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const splitKeys = (raw) => [...new Set((raw ?? '').split(/[\s,]+/).map((k) => k.trim().toLowerCase()).filter(Boolean))];

/** The key lists of a deployment env that hold derived values. */
export function keyListsOf(env) {
  return { R4_PROD_ROLLOUT_ALLOWLIST: splitKeys(env.R4_PROD_ROLLOUT_ALLOWLIST), R4_PROD_ROLLOUT_DENYLIST: splitKeys(env.R4_PROD_ROLLOUT_DENYLIST), R4_PROD_LANE_ALLOWLIST: splitKeys(env.R4_PROD_LANE_ALLOWLIST) };
}

async function schemaHasExpectations(client) {
  const r = await client.query(`select to_regclass('identity_verification.expectations') is not null as present`);
  return r.rows[0].present === true;
}

/**
 * Read-only. What a rotation would do, and what blocks it. `lists` are the deployment's key lists (keyListsOf).
 * Returns { summary (counts only), blockers, mapping (old→new, internal), newLists (internal) }.
 */
export async function planRotation(client, { oldKey, newKey, lists, rolloutPercent }) {
  assertKeys(oldKey, newKey);
  const rows = (await client.query('select binding_id, channel, conversation_key, account_ref, recipient_ref, status from channel_conversation_bindings')).rows;
  const mapping = new Map();
  const identityOf = new Map();
  const rewrites = [];
  let unverifiedOpen = 0;
  let unverifiedClosed = 0;
  let collisions = 0;
  for (const r of rows) {
    const verified = conversationKeyOf(oldKey, r.channel, r.account_ref, r.recipient_ref) === r.conversation_key;
    if (!verified) {
      if (r.status === 'open') unverifiedOpen += 1;
      else unverifiedClosed += 1;
      continue;
    }
    const identity = `${r.channel}\u0000${r.account_ref}\u0000${r.recipient_ref}`;
    const next = conversationKeyOf(newKey, r.channel, r.account_ref, r.recipient_ref);
    // Two different identities under one old key (an HMAC collision) or one old key mapping to two new keys: never guess.
    if ((identityOf.has(r.conversation_key) && identityOf.get(r.conversation_key) !== identity) || (mapping.has(r.conversation_key) && mapping.get(r.conversation_key) !== next)) collisions += 1;
    identityOf.set(r.conversation_key, identity);
    mapping.set(r.conversation_key, next);
    rewrites.push({ bindingId: r.binding_id, from: r.conversation_key, to: next });
  }
  const reverse = new Map();
  for (const [from, to] of mapping) {
    if (reverse.has(to) && reverse.get(to) !== from) collisions += 1;
    reverse.set(to, from);
  }
  const received = Number((await client.query(`select count(*) as n from inbound_events where status = 'received'`)).rows[0].n);
  const hasExpectations = await schemaHasExpectations(client);
  const protectedExpectations = hasExpectations
    ? Number((await client.query(`select count(*) as n from identity_verification.expectations where state in ('created', 'awaiting_code', 'processing') or protect_until > clock_timestamp()`)).rows[0].n)
    : 0;
  const listSummary = {};
  const newLists = {};
  for (const [name, keys] of Object.entries(lists)) {
    const mapped = keys.filter((k) => mapping.has(k));
    listSummary[name] = { entries: keys.length, mapped: mapped.length, unmapped: keys.length - mapped.length };
    newLists[name] = mapped.map((k) => mapping.get(k));
  }
  const blockers = [];
  const role = (await client.query(`select (select tableowner from pg_tables where schemaname = 'public' and tablename = 'channel_conversation_bindings') = current_user or (select rolsuper from pg_roles where rolname = current_user) as ok`)).rows[0];
  if (!role.ok) blockers.push('the connected role cannot disable the binding identity trigger (neither owner nor superuser)');
  if (rolloutPercent !== undefined && rolloutPercent !== '0') blockers.push('R4_PROD_ROLLOUT_PERCENT is not 0 (the cohort would reshuffle)');
  if (unverifiedOpen > 0) blockers.push(`${unverifiedOpen} open binding(s) do not verify under the old key (routing would break)`);
  if (collisions > 0) blockers.push(`${collisions} key collision(s)`);
  if (received > 0) blockers.push(`${received} inbound event(s) not settled (drain them first)`);
  if (protectedExpectations > 0) blockers.push(`${protectedExpectations} identity-verification expectation(s) live or protected (wait until none)`);
  for (const [name, s] of Object.entries(listSummary)) if (s.unmapped > 0) blockers.push(`${name}: ${s.unmapped} entr(y/ies) without a verifiable identity (the owner must provide those numbers)`);
  const summary = {
    bindings: { total: rows.length, open: rows.filter((r) => r.status === 'open').length, verified: rewrites.length, unverifiedOpen, unverifiedClosed },
    distinctIdentities: mapping.size,
    collisions,
    inboundUnsettled: received,
    identityVerification: hasExpectations ? { protectedOrLive: protectedExpectations } : 'schema_absent',
    lists: listSummary,
  };
  return { summary, blockers, mapping, rewrites, newLists };
}

/**
 * One transaction: lock, re-plan inside it (nothing may have moved), disable the binding identity trigger, rewrite
 * every verified key, re-enable the trigger, verify every rewritten row under the new key, commit. Any mismatch aborts
 * (rollback) and nothing changes. Only bindings change: settled inbound events, task inputs, memory and snapshots keep
 * the old derived values as history (they are never compared across keys).
 */
export async function applyRotation(client, { oldKey, newKey, lists, rolloutPercent }) {
  await client.query('begin');
  try {
    // A leftover idle-in-transaction session must make this fail fast, not hang with production stopped.
    await client.query(`set local lock_timeout = '5s'`);
    await client.query('lock table channel_conversation_bindings in access exclusive mode');
    await client.query('lock table inbound_events in share mode');
    const plan = await planRotation(client, { oldKey, newKey, lists, rolloutPercent });
    if (plan.blockers.length > 0) throw new Error(`refusing to rotate: ${plan.blockers.join('; ')}`);
    await client.query(`alter table channel_conversation_bindings disable trigger ${BINDING_TRIGGER}`);
    let updated = 0;
    for (const w of plan.rewrites) updated += (await client.query('update channel_conversation_bindings set conversation_key = $2 where binding_id = $1 and conversation_key = $3', [w.bindingId, w.to, w.from])).rowCount;
    await client.query(`alter table channel_conversation_bindings enable trigger ${BINDING_TRIGGER}`);
    if (updated !== plan.rewrites.length) throw new Error(`rewrote ${updated} of ${plan.rewrites.length} bindings`);
    const check = await verifyRotation(client, { newKey });
    if (check.rewrittenVerified !== plan.rewrites.length || check.unverifiedOpen !== 0) throw new Error('post-rotation verification failed');
    const trigger = (await client.query(`select tgenabled from pg_trigger where tgname = $1`, [BINDING_TRIGGER])).rows[0];
    if (!trigger || trigger.tgenabled !== 'O') throw new Error('the binding identity trigger is not enabled');
    await client.query('commit');
    return { summary: plan.summary, rewritten: updated, newLists: plan.newLists };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/** Read-only, after a rotation: how many bindings verify under the new key. */
export async function verifyRotation(client, { newKey }) {
  const rows = (await client.query('select channel, conversation_key, account_ref, recipient_ref, status from channel_conversation_bindings')).rows;
  let rewrittenVerified = 0;
  let unverifiedOpen = 0;
  let unverifiedClosed = 0;
  for (const r of rows) {
    if (conversationKeyOf(newKey, r.channel, r.account_ref, r.recipient_ref) === r.conversation_key) rewrittenVerified += 1;
    else if (r.status === 'open') unverifiedOpen += 1;
    else unverifiedClosed += 1;
  }
  const duplicateOpen = Number((await client.query(`select count(*) as n from (select channel, conversation_key from channel_conversation_bindings where status = 'open' group by 1, 2 having count(*) > 1) d`)).rows[0].n);
  return { total: rows.length, rewrittenVerified, unverifiedOpen, unverifiedClosed, duplicateOpen };
}
