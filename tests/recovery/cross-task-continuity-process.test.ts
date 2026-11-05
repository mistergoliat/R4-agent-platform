import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { LiveOpsTestbed, complete, say } from '../support/live-ops.js';

/**
 * R4-J4-R7-4 under a real process restart. Requires `npm run build`: the children run dist code.
 *
 * An earlier task of the conversation ends (its reply delivered and confirmed by the provider). Process A — the
 * real production worker in a child process — serves the first turn of the new task and is SIGKILLed. Process B,
 * started afresh and sharing no memory with A, serves the next turn: its context carries the same earlier turns,
 * recovered from PostgreSQL, in causal order, once each, with their delivery state.
 */
const WORKER_CHILD = fileURLToPath(new URL('./fixtures/continuity-production-worker.mjs', import.meta.url));
const DIST = fileURLToPath(new URL('../../agents/sales/dist/production/index.js', import.meta.url));
const CUSTOMER = '56911113333';
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

interface Prior { readonly itemId: string; readonly kind: string; readonly authority: string; readonly content: { text?: string; delivery?: string; actor?: { role: string } } }
interface Line { readonly event: string; readonly pid?: number; readonly index?: number; readonly prior?: Prior[] }

function start(env: Record<string, string>, steps: unknown[]): { lines: Line[]; process: ChildProcess } {
  const lines: Line[] = [];
  const proc = spawn(process.execPath, [WORKER_CHILD], { env: { ...process.env, ...env, CHILD_STEPS: JSON.stringify(steps) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try {
        lines.push(JSON.parse(line) as Line);
      } catch {
        // not a protocol line
      }
    }
  });
  return { lines, process: proc };
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const killed = (proc: ChildProcess) => new Promise<void>((resolve) => (proc.exitCode !== null || proc.signalCode !== null ? resolve() : proc.once('exit', () => resolve())));
const suspended = (b: LiveOpsTestbed, n: number) => async () => {
  const task = await b.taskOf(CUSTOMER).catch(() => null);
  if (!task) return false;
  const runs = await b.rows<{ status: string }>(`select status from agent_runs where task_id = $1 and status = 'suspended'`, [task]);
  return runs.length >= n;
};

it('R74-5b: a new process recovers the earlier conversation from PostgreSQL — same turns, causal order, no duplicates, delivery state', async () => {
  const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true }));
  // The earlier task: a reply the provider confirms as delivered, then a closing.
  await b.customer(CUSTOMER, 'wamid.r745b-1', 'Hola, busco un banco regulable');
  b.next(say('Tenemos el banco regulable Atlas a $89.990.'));
  await b.runAgent();
  await b.deliver();
  await b.status([{ id: b.provider.sends[0]!.providerMessageId!, status: 'delivered', recipientId: CUSTOMER }]);
  await b.customer(CUSTOMER, 'wamid.r745b-2', 'Ok, gracias');
  b.next(complete(), complete());
  await b.runAgent();
  const [earlier] = await b.rows<{ task_id: string; status: string }>('select task_id, status from agent_tasks order by created_at');
  expect(earlier!.status).toBe('completed');
  const earlierCounts = () => b.rows('select (select count(*) from outbound_messages where task_id = $1)::int as outbound, (select count(*) from agent_run_steps where task_id = $1)::int as steps, (select count(*) from task_inputs where task_id = $1)::int as inputs', [earlier!.task_id]);
  const before = await earlierCounts();

  const env = {
    ...b.env,
    R4_WORKER_LEASE_MS: '1500', R4_WORKER_HEARTBEAT_MS: '250', R4_WORKER_POLL_MS: '20',
    R4_EXEC_MODEL_CALL_TIMEOUT_MS: '600000', R4_EXEC_MAX_WRITE_ACTIONS: '10', R4_LOG_LEVEL: 'silent',
  };

  // Process A serves the first turn of the new task, then dies.
  await b.customer(CUSTOMER, 'wamid.r745b-3', 'Hola otra vez');
  const a = start({ ...env, R4_WORKER_ID: 'worker-a' }, [say('Hola, ¿qué necesitas?')]);
  child = a.process;
  await until(suspended(b, 1));
  a.process.kill('SIGKILL');
  await killed(a.process);
  const seenByA = a.lines.find((l) => l.event === 'child.model.call')!;

  // Process B: a fresh process, no memory shared with A.
  await b.customer(CUSTOMER, 'wamid.r745b-4', '¿Me recuerdas el banco?');
  const bProc = start({ ...env, R4_WORKER_ID: 'worker-b' }, [say('El banco regulable Atlas.')]);
  child = bProc.process;
  await until(suspended(b, 2));
  bProc.process.kill('SIGKILL');
  await killed(bProc.process);
  const seenByB = bProc.lines.find((l) => l.event === 'child.model.call')!;

  // Two different processes, the first one dead before the second started.
  expect(seenByA.pid).toBeDefined();
  expect(seenByB.pid).not.toBe(seenByA.pid);
  expect(a.process.signalCode ?? a.process.exitCode).not.toBeNull();

  // B recovered the earlier conversation: same items as A, causal order, each once, with the delivery truth.
  const turns = (seen: Line) => seen.prior!.filter((p) => p.itemId.startsWith('prior_turn:'));
  expect(seenByB.prior).toEqual(seenByA.prior);
  expect(turns(seenByB).map((t) => t.content.text)).toEqual(['Hola, busco un banco regulable', 'Tenemos el banco regulable Atlas a $89.990.', 'Ok, gracias']);
  expect(new Set(turns(seenByB).map((t) => t.itemId)).size).toBe(3);
  expect(turns(seenByB).every((t) => t.kind === 'conversation_turn' && t.authority === 'CONVERSATIONAL')).toBe(true);
  expect(turns(seenByB)[1]!.content).toMatchObject({ actor: { role: 'agent' }, delivery: 'the contact received it' });
  expect(seenByB.prior!.filter((p) => p.itemId.startsWith('prior_conversation:'))).toHaveLength(1);

  // Nothing of the earlier task was re-run or re-sent by either process.
  expect(await earlierCounts()).toEqual(before);
  expect(b.provider.sends).toHaveLength(1);
}, 120_000);
