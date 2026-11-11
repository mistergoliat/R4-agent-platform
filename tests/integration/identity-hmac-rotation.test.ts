import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversationKey } from '@r4/live-ops';
import { CANARY_PHONE_ID, IDENTITY_KEY, LiveOpsTestbed, keyOf } from '../support/live-ops.js';

/**
 * Identity HMAC rotation (R4_PROD_IDENTITY_HASH_KEY) through the operator CLI (ops/r4-identity-rotation/rotate.mjs),
 * against a database that a real gateway wrote. What must hold: every conversation keeps its binding (same task) under
 * the new key, the allowlist is recomputed only from verifiable identities, nothing unverifiable is reassigned, the
 * blockers stop it, it can be rolled back the same way, and the CLI prints no key, wa_id or derived key.
 */

const run = promisify(execFile);
const CLI = join(process.cwd(), 'ops', 'r4-identity-rotation', 'rotate.mjs');
const A = '56911110001';
const B = '56911110002';
const C = '56922220003';
const NEVER_WROTE = '56933330004';

let bed: LiveOpsTestbed;
let dir: string;
const newKey = randomBytes(32).toString('hex');

async function raw(args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { ...process.env, R4_ROTATION_DATABASE_URL: bed.db.url } });
    return { code: 0, stdout, stderr, out: JSON.parse(stdout) as Record<string, unknown> };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr, out: e.stdout ? (JSON.parse(e.stdout) as Record<string, unknown>) : { stderr: e.stderr } };
  }
}
const cli = (mode: 'plan' | 'apply' | 'verify', envFile: string, keyFile: string, extra: string[] = []) => raw([mode, '--env-file', envFile, '--new-key-file', keyFile, ...extra]);
const newKeyOf = (n: string) => conversationKey(newKey, 'whatsapp', CANARY_PHONE_ID, n);

function envFile(name: string, values: Record<string, string>): string {
  const path = join(dir, name);
  writeFileSync(path, Object.entries(values).map(([k, v]) => `${k}='${v}'`).join('\n'));
  return path;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'r4-rotation-'));
  writeFileSync(join(dir, 'new.key'), newKey);
  writeFileSync(join(dir, 'old.key'), IDENTITY_KEY);
  bed = await LiveOpsTestbed.start({ allowlist: [A, B], autonomy: true });
  await bed.customer(A, 'wamid.rot.1', 'hola');
  await bed.customer(B, 'wamid.rot.2', 'hola');
  await bed.customer(C, 'wamid.rot.3', 'hola');
});
afterAll(() => bed.close());

describe('identity HMAC rotation (operator CLI)', { timeout: 120_000 }, () => {
  it('the plan refuses an allowlisted number with no verifiable identity, and unsettled inbound', async () => {
    const withUnknown = envFile('unknown.env', { R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY, R4_PROD_ROLLOUT_ALLOWLIST: [A, B, NEVER_WROTE].map(keyOf).join(',') });
    const plan = await cli('plan', withUnknown, join(dir, 'new.key'));
    expect(plan.code).toBe(1);
    expect(plan.out).toMatchObject({ ready: false, summary: { bindings: { total: 3, open: 3, verified: 3, unverifiedOpen: 0 }, lists: { R4_PROD_ROLLOUT_ALLOWLIST: { entries: 3, mapped: 2, unmapped: 1 } } } });
    await bed.store.recordInbound({ inboundId: crypto.randomUUID(), channel: 'whatsapp', providerEventId: 'wamid.rot.pending', contentKind: 'text', contentType: 'text', content: 'x', contentSha256: null, conversationKey: keyOf(A), accountRef: CANARY_PHONE_ID, conversationRef: A, occurredAt: new Date().toISOString(), status: 'received', failureCode: null, correlationId: 't' });
    const blocked = await cli('plan', envFile('ok.env', { R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY, R4_PROD_ROLLOUT_ALLOWLIST: [A, B].map(keyOf).join(',') }), join(dir, 'new.key'));
    expect(blocked.out.blockers).toEqual(['1 inbound event(s) not settled (drain them first)']);
    await bed.gateway.ingress.resumeUnsettled(0);
  });

  it('refuses an open binding that does not verify: nothing changes, the trigger stays on, no secret is printed', async () => {
    const rogue = crypto.randomUUID();
    await bed.pool.query(`insert into channel_conversation_bindings (binding_id, channel, conversation_key, account_ref, recipient_ref, status, autonomy, eligibility_reason, rollout_fingerprint, profile, profile_fingerprint)
      values ($1, 'whatsapp', $2, $3, '56955550006', 'open', 'excluded', 'not_in_cohort', 'x', 'sales-production@1', 'x')`, [rogue, 'cd'.repeat(32), CANARY_PHONE_ID]);
    const env = envFile('rogue.env', { R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY, R4_PROD_ROLLOUT_ALLOWLIST: [A, B].map(keyOf).join(',') });
    const before = await bed.rows('select binding_id, conversation_key from channel_conversation_bindings order by binding_id');
    const plan = await cli('plan', env, join(dir, 'new.key'));
    expect(plan.out.blockers).toEqual(['1 open binding(s) do not verify under the old key (routing would break)']);
    const refused = await cli('apply', env, join(dir, 'new.key'), ['--out', join(dir, 'refused.env')]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/^apply failed: refusing to rotate: 1 open binding/);
    for (const out of [plan.stdout, refused.stdout, refused.stderr]) for (const secret of [IDENTITY_KEY, newKey, A, B, keyOf(A), 'cd'.repeat(32)]) expect(out).not.toContain(secret);
    expect(await bed.rows('select binding_id, conversation_key from channel_conversation_bindings order by binding_id')).toEqual(before);
    expect((await bed.rows<{ tgenabled: string }>(`select tgenabled from pg_trigger where tgname = 'channel_conversation_bindings_identity_immutable'`))[0]!.tgenabled).toBe('O');
    await bed.pool.query(`update channel_conversation_bindings set status = 'closed', closed_at = clock_timestamp(), closed_reason = 'test' where binding_id = $1`, [rogue]);
  });

  it('refuses env files a rewrite could get wrong: export, indentation, the same variable twice, a rollout above 0 %', async () => {
    const key = `R4_PROD_IDENTITY_HASH_KEY='${IDENTITY_KEY}'`;
    const cases: [string, string, RegExp][] = [
      ['export.env', `${key}\nexport R4_PROD_LANE_ALLOWLIST=${keyOf(A)}`, /R4_PROD_LANE_ALLOWLIST is not a plain unindented assignment/],
      ['indent.env', `${key}\n  R4_PROD_ROLLOUT_ALLOWLIST=${keyOf(A)}`, /R4_PROD_ROLLOUT_ALLOWLIST is not a plain unindented assignment/],
      ['twice.env', `${key}\nR4_PROD_ROLLOUT_ALLOWLIST=${keyOf(A)}\nR4_PROD_ROLLOUT_ALLOWLIST=${keyOf(B)}`, /R4_PROD_ROLLOUT_ALLOWLIST is defined 2 times/],
      ['percent.env', `${key}\nR4_PROD_ROLLOUT_PERCENT=5`, /R4_PROD_ROLLOUT_PERCENT is not 0/],
    ];
    for (const [name, text, problem] of cases) {
      writeFileSync(join(dir, name), text);
      const plan = await cli('plan', join(dir, name), join(dir, 'new.key'));
      expect(plan.code, name).toBe(1);
      expect((plan.out.blockers as string[]).join('; '), name).toMatch(problem);
    }
  });

  it('rotates: same bindings and tasks under the new key, recomputed lists, an unverifiable closed row left untouched; prints no secret', async () => {
    const before = await bed.rows<{ binding_id: string; task_id: string; recipient_ref: string }>(`select binding_id, task_id, recipient_ref from channel_conversation_bindings where recipient_ref = any($1) order by recipient_ref`, [[A, B, C]]);
    // A historical row whose stored key does not verify under the old key: kept as is, never reassigned.
    await bed.pool.query(`insert into channel_conversation_bindings (binding_id, channel, conversation_key, account_ref, recipient_ref, status, autonomy, eligibility_reason, rollout_fingerprint, profile, profile_fingerprint, closed_at, closed_reason)
      values ($1, 'whatsapp', $2, $3, '56944440005', 'closed', 'excluded', 'not_in_cohort', 'x', 'sales-production@1', 'x', clock_timestamp(), 'test')`, [crypto.randomUUID(), 'ab'.repeat(32), CANARY_PHONE_ID]);
    await bed.gateway.close();
    // The deployment's two env files: the main one (key, allowlist, denylist) and the lane worker's (lane list).
    const env = envFile('prod.env', { R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY, R4_PROD_ROLLOUT_ALLOWLIST: [A, B].map(keyOf).join(','), R4_PROD_ROLLOUT_DENYLIST: keyOf(C), R4_PROD_ROLLOUT_PERCENT: '0', OTHER_SETTING: 'kept' });
    const lane = envFile('lane.env', { R4_PROD_LANE_ALLOWLIST: keyOf(A), R4_PROD_POLICY_PROFILE: 'sales-production@1' });
    const both = ['--env-file', env, '--env-file', lane];
    const original = readFileSync(env, 'utf8');
    writeFileSync(join(dir, 'prod.env.backup'), original);
    const out = join(dir, 'new-lists.env');
    const applied = await raw(['apply', ...both, '--new-key-file', join(dir, 'new.key'), '--out', out]);
    expect(applied.out).toMatchObject({ rewritten: 3, summary: { bindings: { total: 5, verified: 3, unverifiedClosed: 2 }, lists: { R4_PROD_ROLLOUT_DENYLIST: { mapped: 1 }, R4_PROD_LANE_ALLOWLIST: { mapped: 1 } } } });
    for (const secret of [IDENTITY_KEY, newKey, A, B, C, keyOf(A), newKeyOf(A)]) expect(applied.stdout + applied.stderr).not.toContain(secret);
    expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual([
      `R4_PROD_ROLLOUT_ALLOWLIST=${[A, B].map(newKeyOf).join(',')}`, `R4_PROD_ROLLOUT_DENYLIST=${newKeyOf(C)}`, `R4_PROD_LANE_ALLOWLIST=${newKeyOf(A)}`,
    ]);

    // install: the new key and lists into the env files, in place; every other line untouched; no old value survives.
    const installed = await raw(['install', ...both, '--new-key-file', join(dir, 'new.key'), '--lists', out, '--old-env-file', join(dir, 'prod.env.backup')]);
    expect(installed.out).toMatchObject({ files: [{ updated: 3 }, { updated: 1 }] });
    const after = readFileSync(env, 'utf8') + readFileSync(lane, 'utf8');
    for (const old of [IDENTITY_KEY, keyOf(A), keyOf(B), keyOf(C)]) expect(after).not.toContain(old);
    expect(after).toContain(`OTHER_SETTING='kept'`);
    expect(after).toContain(`R4_PROD_POLICY_PROFILE='sales-production@1'`);
    expect((await raw(['verify', ...both, '--key-from-env'])).out).toMatchObject({ ok: true, rewrittenVerified: 3, unverifiedOpen: 0, unverifiedClosed: 2, duplicateOpen: 0 });

    // The gateway restarts with the new key and the recomputed lists: every conversation continues on its own task.
    await bed.redeployGatewayEnv({ R4_PROD_IDENTITY_HASH_KEY: newKey, R4_PROD_ROLLOUT_ALLOWLIST: [A, B].map(newKeyOf).join(',') });
    for (const [n, id] of [[A, 'wamid.rot.4'], [C, 'wamid.rot.5']] as const) await bed.customer(n, id, 'sigo aquí');
    const rows = await bed.rows<{ binding_id: string; task_id: string; recipient_ref: string; autonomy: string }>(`select binding_id, task_id, recipient_ref, autonomy from channel_conversation_bindings where recipient_ref = any($1) order by recipient_ref`, [[A, B, C]]);
    expect(rows.map((r) => [r.binding_id, r.task_id])).toEqual(before.map((r) => [r.binding_id, r.task_id]));
    expect(rows.map((r) => r.autonomy)).toEqual(['autonomous', 'autonomous', 'excluded']);
    const inputs = await bed.rows<{ task_id: string }>(`select task_id from task_inputs where external_key in ('wamid.rot.4', 'wamid.rot.5') order by external_key`);
    expect(inputs.map((i) => i.task_id)).toEqual([before.find((r) => r.recipient_ref === A)!.task_id, before.find((r) => r.recipient_ref === C)!.task_id]);
  });

  it('rolls back the same way (keys swapped): the original keys verify again', async () => {
    await bed.gateway.close();
    const rotatedEnv = envFile('rotated.env', { R4_PROD_IDENTITY_HASH_KEY: newKey, R4_PROD_ROLLOUT_ALLOWLIST: [A, B].map(newKeyOf).join(',') });
    const back = await cli('apply', rotatedEnv, join(dir, 'old.key'), ['--out', join(dir, 'back.env')]);
    expect(back.out).toMatchObject({ rewritten: 3 });
    expect(readFileSync(join(dir, 'back.env'), 'utf8').trim()).toBe(`R4_PROD_ROLLOUT_ALLOWLIST=${[A, B].map(keyOf).join(',')}`);
    const keys = await bed.rows<{ recipient_ref: string; conversation_key: string }>(`select recipient_ref, conversation_key from channel_conversation_bindings where recipient_ref = any($1)`, [[A, B, C]]);
    for (const k of keys) expect(k.conversation_key).toBe(keyOf(k.recipient_ref));
    // The binding identity trigger is back in force: a key can no longer be changed by an ordinary update.
    await expect(bed.pool.query(`update channel_conversation_bindings set conversation_key = $1 where recipient_ref = $2`, ['cd'.repeat(32), A])).rejects.toThrow(/identity is immutable/);
  });
});
