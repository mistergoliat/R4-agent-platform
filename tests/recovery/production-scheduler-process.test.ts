import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LiveOpsTestbed, say } from '../support/live-ops.js';
import { freezeTemporalClock } from '../support/temporal.js';

/**
 * R4-J1E-R2.1 — the production scheduler is the real OS process started by
 * `npm run start:scheduler` (apps/scheduler/dist/main.js), next to the real
 * production gateway and worker compositions (in-process, same database):
 *
 *   1. without the reconciliation policy the process refuses to start,
 *      naming what is missing (no silent default);
 *   2. a scheduler process SIGKILLed before the agent's WAIT_UNTIL is due
 *      holds no claim; a new scheduler process claims the durable timer and
 *      wakes the task exactly once; the woken run replies once (temporal time
 *      frozen: "not yet due" never depends on CI speed).
 *
 * Requires `npm run build`. The children run in an empty directory, so the
 * repository's local `.env` (which `main.ts` loads from the cwd) is never read.
 */
const SCHEDULER_MAIN = fileURLToPath(new URL('../../apps/scheduler/dist/main.js', import.meta.url));
const CUSTOMER = '56933334444';
const REPLY = 'Hola de nuevo: ¿pudiste revisar las medidas de tu espacio?';
const POLICY = { R4_RECONCILIATION_MAX_ATTEMPTS: '3', R4_RECONCILIATION_INITIAL_BACKOFF_MS: '0', R4_RECONCILIATION_MAX_BACKOFF_MS: '0', R4_RECONCILIATION_DEADLINE_MS: '86400000' };

let bed: LiveOpsTestbed | null = null;
const children: ChildProcess[] = [];
const cwd = mkdtempSync(join(tmpdir(), 'r4-scheduler-'));

beforeAll(() => {
  if (!existsSync(SCHEDULER_MAIN)) throw new Error(`${SCHEDULER_MAIN} is missing: run "npm run build" before "npm run test:recovery"`);
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await bed?.close();
  bed = null;
});
process.once('exit', () => rmSync(cwd, { recursive: true, force: true }));

interface Child {
  readonly process: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function scheduler(env: Record<string, string>): Child {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('R4_')));
  const child = spawn(process.execPath, [SCHEDULER_MAIN], { cwd, env: { ...base, R4_LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { process: child, output: () => output, exited };
}

async function until<T>(probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('R4-J1E-R2.1 production scheduler process (real entry point)', () => {
  it('1. refuses to start without the reconciliation policy, naming the missing variables', async () => {
    const child = scheduler({ R4_DATABASE_URL: 'postgres://r4:unused@127.0.0.1:1/none' });
    expect(await child.exited).toEqual({ code: 1, signal: null });
    expect(child.output()).toContain('service.boot_failed');
    for (const name of Object.keys(POLICY)) expect(child.output()).toContain(name);
    expect(child.output()).not.toContain('unused@'); // the connection string is never echoed
  });

  it('2. SIGKILL before dueAt → a new scheduler process claims the durable timer → one wake → one reply', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    const env = { R4_DATABASE_URL: bed.db.url, R4_SCHEDULER_POLL_MS: '25', ...POLICY };
    const a = scheduler({ ...env, R4_SCHEDULER_ID: 'scheduler-process-a' });
    await until(() => a.output().includes('service.started'), 'scheduler A to start');

    const worker = await bed.worker('worker-1');
    await bed.customer(CUSTOMER, 'wamid.in.1', 'Lo veo y te aviso.');
    const t0 = await freezeTemporalClock(bed.pool);
    bed.next({ type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_UNTIL', until: new Date(t0.getTime() + 1_000).toISOString() }, reason: 'follow up later' } }, say(REPLY));
    await worker.worker.runOnce();
    const taskId = await bed.taskOf(CUSTOMER);
    a.process.kill('SIGKILL'); // dies while the timer is not due (frozen clock)
    expect((await a.exited).signal).toBe('SIGKILL');
    expect(await bed.rows('select kind, status, owner from schedules where task_id = $1', [taskId])).toEqual([{ kind: 'wake', status: 'pending', owner: null }]);

    await freezeTemporalClock(bed.pool, new Date(t0.getTime() + 1_001));
    scheduler({ ...env, R4_SCHEDULER_ID: 'scheduler-process-b' });
    await until(async () => (await bed!.rows<{ status: string }>('select status from agent_tasks where task_id = $1', [taskId]))[0]!.status === 'running', 'scheduler B to wake the task');
    const events = await bed.rows<{ event_type: string; actor_ref: string | null }>(
      `select event_type, actor_ref from temporal_events where task_id = $1 and event_type in ('schedule.claimed', 'schedule.fired', 'task.woken') order by occurred_at, event_id`,
      [taskId],
    );
    expect(events).toEqual([
      { event_type: 'schedule.claimed', actor_ref: 'scheduler-process-b' },
      { event_type: 'schedule.fired', actor_ref: 'scheduler-process-b' },
      { event_type: 'task.woken', actor_ref: 'temporal-runtime' },
    ]);

    await worker.worker.runOnce();
    await bed.deliver();
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual([REPLY]);
  });
});
