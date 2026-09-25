import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LiveOpsTestbed, say, waitInput } from '../support/live-ops.js';

/**
 * R4-I under real process death (SIGKILL). Requires `npm run build`: the
 * children run dist code.
 *
 * 1. The delivery process dies DURING the provider call: nothing is assumed —
 *    the lease expires into `unknown` and the message is never sent again.
 * 2. The worker dies AFTER an accepted `respond` has been materialized as an
 *    OutboundMessage and before delivery: restart reuses that row and sends it
 *    once; takeover of the same run creates no second response step.
 */
const GATEWAY_CHILD = fileURLToPath(new URL('./fixtures/dispatching-gateway.mjs', import.meta.url));
const WORKER_CHILD = fileURLToPath(new URL('./fixtures/crashing-production-worker.mjs', import.meta.url));
const DIST = fileURLToPath(new URL('../../agents/sales/dist/production/index.js', import.meta.url));
const CUSTOMER = '56911112222';

let bed: LiveOpsTestbed | null = null;
let child: ChildProcess | null = null;

beforeAll(() => {
  if (!existsSync(DIST)) throw new Error('agents/sales/dist is missing: run "npm run build" before "npm run test:recovery"');
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = null;
  await bed?.close();
  bed = null;
});

function start(script: string, env: Record<string, string>): { lines: Record<string, unknown>[]; process: ChildProcess } {
  const lines: Record<string, unknown>[] = [];
  const proc = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // not a protocol line
      }
    }
  });
  return { lines, process: proc };
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const killed = (proc: ChildProcess) => new Promise<void>((resolve) => (proc.exitCode !== null || proc.signalCode !== null ? resolve() : proc.once('exit', () => resolve())));

describe('delivery process SIGKILL during the provider call', () => {
  it('the in-flight message becomes UNKNOWN after lease expiry and is never re-sent', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, leaseMs: 1500, providerTimeoutMs: 1000 });
    bed.next(say('mensaje en vuelo al morir'), waitInput());
    await bed.customer(CUSTOMER, 'wamid.in.1', 'Hola');
    await bed.runAgent();
    bed.provider.script({ kind: 'hang', ms: 120_000 });
    const gateway = start(GATEWAY_CHILD, { ...bed.env });
    child = gateway.process;
    await until(() => bed!.provider.sends.length === 1);
    gateway.process.kill('SIGKILL');
    await killed(gateway.process);
    const taskId = await bed.taskOf(CUSTOMER);
    expect((await bed.store.outboundForTask(taskId))[0]).toMatchObject({ status: 'dispatching', leaseOwner: 'gateway-child' });

    await new Promise((r) => setTimeout(r, 1700));
    for (let i = 0; i < 3; i += 1) await bed.deliver();
    const [o] = await bed.store.outboundForTask(taskId);
    expect(o).toMatchObject({ status: 'unknown', errorClass: 'lease_expired_during_dispatch', attempts: 1 });
    expect(bed.provider.sends).toHaveLength(1);
    expect((await bed.api.production.attention()).production.unknownOutbound.map((x) => x.outboundId)).toEqual([o!.outboundId]);
  });
});

describe('worker SIGKILL after an accepted respond, before delivery', () => {
  it('exactly one durable message, delivered once; the run takeover adds no second response', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    await bed.customer(CUSTOMER, 'wamid.in.1', 'Hola');
    const worker = start(WORKER_CHILD, {
      ...bed.env,
      CHILD_RESPONSE: 'respuesta aceptada antes del crash',
      R4_WORKER_ID: 'worker-child', R4_WORKER_LEASE_MS: '1500', R4_WORKER_HEARTBEAT_MS: '250', R4_WORKER_POLL_MS: '20',
      R4_EXEC_MODEL_CALL_TIMEOUT_MS: '600000', R4_EXEC_MAX_WRITE_ACTIONS: '10', R4_LOG_LEVEL: 'silent',
    });
    child = worker.process;
    await until(() => worker.lines.some((l) => l.event === 'child.model.second_call'));
    expect(await bed.gateway.delivery.materialize()).toHaveLength(1);
    const taskId = await bed.taskOf(CUSTOMER);
    expect(await bed.store.outboundForTask(taskId)).toHaveLength(1);
    worker.process.kill('SIGKILL');
    await killed(worker.process);

    // Another worker takes over THE SAME run after the lease expires; it continues from the durable step log.
    await new Promise((r) => setTimeout(r, 1700));
    bed.next(waitInput());
    await bed.runAgent();
    await bed.gateway.delivery.materialize();
    await bed.deliver();
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual(['respuesta aceptada antes del crash']);
    const runs = await bed.rows<{ status: string; recoveries: number }>('select status, recoveries from agent_runs where task_id = $1', [taskId]);
    expect(runs).toEqual([{ status: 'suspended', recoveries: 1 }]);
    expect(await bed.rows(`select count(*)::int as n from agent_run_steps where task_id = $1 and decision_type = 'respond'`, [taskId])).toEqual([{ n: 1 }]);
    expect(await bed.store.outboundForTask(taskId)).toHaveLength(1);
    expect(bed.provider.sends).toHaveLength(1);
  });
});
