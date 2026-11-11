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

async function cli(mode: 'plan' | 'apply' | 'verify', envFile: string, keyFile: string, extra: string[] = []) {
  try {
    const { stdout } = await run(process.execPath, [CLI, mode, '--env-file', envFile, '--new-key-file', keyFile, ...extra], { env: { ...process.env, R4_ROTATION_DATABASE_URL: bed.db.url } });
    return { code: 0, stdout, out: JSON.parse(stdout) as Record<string, unknown> };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, out: e.stdout ? (JSON.parse(e.stdout) as Record<string, unknown>) : { stderr: e.stderr } };
  }
}

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

  it('rotates: same bindings and tasks under the new key, recomputed lists, an unverifiable closed row left untouched; prints no secret', async () => {
    const before = await bed.rows<{ binding_id: string; task_id: string; recipient_ref: string }>(`select binding_id, task_id, recipient_ref from channel_conversation_bindings order by recipient_ref`);
    // A historical row whose stored key does not verify under the old key: kept as is, never reassigned.
    await bed.pool.query(`insert into channel_conversation_bindings (binding_id, channel, conversation_key, account_ref, recipient_ref, status, autonomy, eligibility_reason, rollout_fingerprint, profile, profile_fingerprint, closed_at, closed_reason)
      values ($1, 'whatsapp', $2, $3, '56944440005', 'closed', 'excluded', 'not_in_cohort', 'x', 'sales-production@1', 'x', clock_timestamp(), 'test')`, [crypto.randomUUID(), 'ab'.repeat(32), CANARY_PHONE_ID]);
    await bed.gateway.close();
    const env = envFile('prod.env', { R4_PROD_IDENTITY_HASH_KEY: IDENTITY_KEY, R4_PROD_ROLLOUT_ALLOWLIST: [A, B].map(keyOf).join(',') });
    const out = join(dir, 'new-lists.env');
    const applied = await cli('apply', env, join(dir, 'new.key'), ['--out', out]);
    expect(applied.out).toMatchObject({ rewritten: 3, summary: { bindings: { total: 4, verified: 3, unverifiedClosed: 1 } } });
    for (const secret of [IDENTITY_KEY, newKey, A, B, C, keyOf(A), conversationKey(newKey, 'whatsapp', CANARY_PHONE_ID, A)]) expect(applied.stdout).not.toContain(secret);
    expect(readFileSync(out, 'utf8').trim()).toBe(`R4_PROD_ROLLOUT_ALLOWLIST=${[A, B].map((n) => conversationKey(newKey, 'whatsapp', CANARY_PHONE_ID, n)).join(',')}`);
    expect((await cli('verify', env, join(dir, 'new.key'))).out).toMatchObject({ ok: true, rewrittenVerified: 3, unverifiedOpen: 0, unverifiedClosed: 1, duplicateOpen: 0 });

    // The gateway restarts with the new key and the recomputed lists: every conversation continues on its own task.
    await bed.redeployGatewayEnv({ R4_PROD_IDENTITY_HASH_KEY: newKey, R4_PROD_ROLLOUT_ALLOWLIST: readFileSync(out, 'utf8').trim().split('=')[1]! });
    for (const [n, id] of [[A, 'wamid.rot.4'], [C, 'wamid.rot.5']] as const) await bed.customer(n, id, 'sigo aquí');
    const after = await bed.rows<{ binding_id: string; task_id: string; recipient_ref: string; autonomy: string }>(`select binding_id, task_id, recipient_ref, autonomy from channel_conversation_bindings where recipient_ref = any($1) order by recipient_ref`, [[A, B, C]]);
    expect(after.map((r) => [r.binding_id, r.task_id])).toEqual(before.map((r) => [r.binding_id, r.task_id]));
    expect(after.map((r) => r.autonomy)).toEqual(['autonomous', 'autonomous', 'excluded']);
    const inputs = await bed.rows<{ task_id: string }>(`select task_id from task_inputs where external_key in ('wamid.rot.4', 'wamid.rot.5') order by external_key`);
    expect(inputs.map((i) => i.task_id)).toEqual([before.find((r) => r.recipient_ref === A)!.task_id, before.find((r) => r.recipient_ref === C)!.task_id]);
  });

  it('rolls back the same way (keys swapped): the original keys verify again', async () => {
    await bed.gateway.close();
    const rotatedEnv = envFile('rotated.env', { R4_PROD_IDENTITY_HASH_KEY: newKey, R4_PROD_ROLLOUT_ALLOWLIST: [A, B].map((n) => conversationKey(newKey, 'whatsapp', CANARY_PHONE_ID, n)).join(',') });
    const back = await cli('apply', rotatedEnv, join(dir, 'old.key'), ['--out', join(dir, 'back.env')]);
    expect(back.out).toMatchObject({ rewritten: 3 });
    expect(readFileSync(join(dir, 'back.env'), 'utf8').trim()).toBe(`R4_PROD_ROLLOUT_ALLOWLIST=${[A, B].map(keyOf).join(',')}`);
    const keys = await bed.rows<{ recipient_ref: string; conversation_key: string }>(`select recipient_ref, conversation_key from channel_conversation_bindings where recipient_ref = any($1)`, [[A, B, C]]);
    for (const k of keys) expect(k.conversation_key).toBe(keyOf(k.recipient_ref));
    // The binding identity trigger is back in force: a key can no longer be changed by an ordinary update.
    await expect(bed.pool.query(`update channel_conversation_bindings set conversation_key = $1 where recipient_ref = $2`, ['cd'.repeat(32), A])).rejects.toThrow(/identity is immutable/);
  });
});
