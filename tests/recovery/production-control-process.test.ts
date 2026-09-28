import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PRODUCTION_CONTROL_ACTOR } from '@r4/live-ops';
import { LiveOpsTestbed, say, waitInput } from '../support/live-ops.js';

/**
 * R4-I D-5/D-6 through the real built command (`production:sales:control`),
 * one OS process per invocation: every decision is read from the database
 * of the deployment, none from memory. Requires `npm run build`.
 */
const CLI = fileURLToPath(new URL('../../agents/sales/dist/cli/production-control.js', import.meta.url));
/** What the command prints (JSON). */
type ControlOutput = { readonly holds?: readonly { readonly taskId: string }[] } & Record<string, unknown>;
const CUSTOMER = '56911112222';

let bed: LiveOpsTestbed | null = null;

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('agents/sales/dist is missing: run "npm run build" before "npm run test:recovery"');
});

afterEach(async () => {
  await bed?.close();
  bed = null;
});

/** A fresh process; only the production environment of the bed (no .env, no channel or model credentials). */
function run(...argv: string[]): { code: number | null; json: ControlOutput | null; stderr: string } {
  const env = Object.fromEntries(Object.entries({ ...process.env, ...bed!.env }).filter(([k]) => !k.startsWith('R4_WHATSAPP_') && !k.startsWith('R4_MODEL_')));
  const r = spawnSync(process.execPath, [CLI, ...argv], { env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, json: r.stdout.trim() ? (JSON.parse(r.stdout) as ControlOutput) : null, stderr: r.stderr };
}

describe('production control across process restarts', () => {
  it('kill switch, platform hold and explicit release are durable across independent processes', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    expect(run('autonomy', 'off', '--reason', 'incident drill')).toMatchObject({ code: 0, json: { autonomy: 'disabled', by: PRODUCTION_CONTROL_ACTOR } });
    expect(run('autonomy', 'status').json).toMatchObject({ autonomy: 'disabled', lastChange: { reason: 'incident drill', by: PRODUCTION_CONTROL_ACTOR } });

    await bed.customer(CUSTOMER, 'wamid.in.1', 'Hola');
    const taskId = await bed.taskOf(CUSTOMER);
    expect(await bed.runAgent()).toEqual([]);
    expect(run('holds', 'list').json!.holds!.map((h: { taskId: string }) => h.taskId)).toEqual([taskId]);

    const refused = run('holds', 'release', '--task', taskId, '--reason', 'too early');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/autonomy_disabled/);
    expect(run('autonomy', 'on', '--reason', 'drill over')).toMatchObject({ code: 0, json: { autonomy: 'enabled' } });
    // A new process still sees the hold: turning autonomy on released nothing.
    expect(run('holds', 'list').json!.holds!.map((h: { taskId: string }) => h.taskId)).toEqual([taskId]);
    expect(run('holds', 'release', '--task', taskId, '--reason', 'resume after drill')).toMatchObject({ code: 0, json: { released: { taskId, status: 'cancelled' }, taskStatus: 'running' } });
    expect(run('holds', 'list').json!.holds).toEqual([]);
    expect(run('holds', 'release', '--task', taskId, '--reason', 'resume after drill').code).toBe(1);

    // The deployment's worker resumes it normally.
    bed.next(say('Hola, ¿en qué te ayudo?'), waitInput());
    await bed.runAgent();
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual(['Hola, ¿en qué te ayudo?']);
    expect(await bed.rows("select changed_by, reason from autonomy_control_events where changed_by = $1 order by occurred_at", [PRODUCTION_CONTROL_ACTOR])).toEqual([
      { changed_by: PRODUCTION_CONTROL_ACTOR, reason: 'incident drill' },
      { changed_by: PRODUCTION_CONTROL_ACTOR, reason: 'drill over' },
    ]);
  });
});
