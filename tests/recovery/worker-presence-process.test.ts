import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LiveOpsTestbed } from '../support/live-ops.js';

/**
 * R4-I worker readiness under real process death (SIGKILL): no shutdown
 * callback, no cleanup. Two real production worker processes publish
 * presence; killing one leaves execution ready through the other; killing
 * the last makes `/ready/r4` NOT ready once its presence expires on the DB
 * clock — while `/ready` (channel) stays ready. Requires `npm run build`.
 */
const WORKER_CHILD = fileURLToPath(new URL('./fixtures/idle-production-worker.mjs', import.meta.url));
const DIST = fileURLToPath(new URL('../../apps/worker/dist/presence.js', import.meta.url));
const LEASE_MS = 1500;

let bed: LiveOpsTestbed | null = null;
const children: ChildProcess[] = [];

beforeAll(() => {
  if (!existsSync(DIST)) throw new Error('apps/worker/dist is stale or missing: run "npm run build" before "npm run test:recovery"');
});

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await bed?.close();
  bed = null;
});

function startWorker(workerId: string, extra: Record<string, string> = {}): ChildProcess {
  const proc = spawn(process.execPath, [WORKER_CHILD], {
    env: { ...process.env, ...bed!.env, ...extra, R4_WORKER_ID: workerId, R4_WORKER_LEASE_MS: String(LEASE_MS), R4_WORKER_HEARTBEAT_MS: '250', R4_WORKER_POLL_MS: '20', R4_LOG_LEVEL: 'silent' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  return proc;
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const killed = (proc: ChildProcess) => new Promise<void>((resolve) => (proc.exitCode !== null || proc.signalCode !== null ? resolve() : proc.once('exit', () => resolve())));

async function r4() {
  const res = await bed!.gateway.app.inject({ method: 'GET', url: '/ready/r4' });
  return { code: res.statusCode, execution: res.json<{ checks: { execution: { status: string; workers: Record<string, number> } } }>().checks.execution };
}

describe('worker process SIGKILL', () => {
  it('a killed worker expires without cleanup; readiness survives through another worker and fails when none is left', async () => {
    bed = await LiveOpsTestbed.start();
    const a = startWorker('proc-a', { R4_BUILD_REF: '0337a34b712b1bf9e758b8335ee532d6cf29ab05' });
    const b = startWorker('proc-b', { R4_BUILD_REF: '' });
    await until(async () => (await r4()).execution.workers.ready === 2);
    expect((await r4()).code).toBe(200);
    // R4_BUILD_REF from the process environment lands verbatim; blank ⇒ NULL; the contract is the same for both.
    expect(await bed.rows(`select worker_id, build_ref, compatibility from worker_presence order by worker_id`)).toEqual([
      { worker_id: 'proc-a', build_ref: '0337a34b712b1bf9e758b8335ee532d6cf29ab05', compatibility: '0010_platform_step_decisions:sales-production@1' },
      { worker_id: 'proc-b', build_ref: null, compatibility: '0010_platform_step_decisions:sales-production@1' },
    ]);

    a.kill('SIGKILL');
    await killed(a);
    const killedAt = Date.now();
    await until(async () => (await r4()).execution.workers.stale === 1, LEASE_MS * 4);
    expect(Date.now() - killedAt).toBeLessThan(LEASE_MS * 4);
    expect(await r4()).toMatchObject({ code: 200, execution: { status: 'ready', workers: { ready: 1, stale: 1 } } });
    // Nothing ran on death: the row still says ready — only the DB clock retired it.
    expect(await bed.rows(`select state, expires_at > clock_timestamp() as fresh from worker_presence where worker_id = 'proc-a'`)).toEqual([{ state: 'ready', fresh: false }]);

    b.kill('SIGKILL');
    await killed(b);
    await until(async () => (await r4()).code === 503, LEASE_MS * 4);
    expect(await r4()).toMatchObject({ code: 503, execution: { status: 'stale', workers: { ready: 0, stale: 2 } } });
    expect((await bed.gateway.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    expect(bed.model.callCount).toBe(0);

    const c = startWorker('proc-c');
    await until(async () => (await r4()).code === 200);
    c.kill('SIGKILL');
  });
});
