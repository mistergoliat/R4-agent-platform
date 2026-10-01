import { afterEach, describe, expect, it } from 'vitest';
import type { ScheduleToken } from '@r4/contracts';
import { createSilentLogger } from '@r4/observability';
import { createSchedulerPlatform, type SchedulerPlatform } from '@r4/scheduler';
import type { WorkerPlatform } from '@r4/worker';
import { LiveOpsTestbed, say } from '../support/live-ops.js';
import { RECONCILIATION_POLICY, freezeTemporalClock } from '../support/temporal.js';

/**
 * R4-J1E-R2.1 production composition (scheduler as the third process), over
 * the REAL production compositions: the Sales production worker, the channel
 * gateway and the scheduler composition root of apps/scheduler
 * (`createSchedulerPlatform`, its own polling loop). Nothing fires a wake by
 * hand: the scheduler does.
 *
 * Since R4-J1E-R2.2 the platform no longer defers responses; the durable timer
 * here is the agent's own WAIT_UNTIL (real temporal semantics). Temporal time
 * is frozen (`r4_now()`), so "not yet due" never depends on CI speed:
 *
 *   model WAIT_UNTIL → schedule.created → scheduler claim → schedule.fired →
 *   task.wait.completed → task.woken → new run → respond → the turn ends → one outbound.
 */

const CUSTOMER = '56911112222';
const REPLY = 'Hola de nuevo: ¿pudiste revisar las medidas de tu espacio?';
const DUE_IN_MS = 1_000;
const waitUntil = (until: string) => ({ type: 'structured' as const, data: { type: 'wait', condition: { kind: 'WAIT_UNTIL', until }, reason: 'follow up later' } });

let bed: LiveOpsTestbed | null = null;
const schedulers: SchedulerPlatform[] = [];
afterEach(async () => {
  for (const s of schedulers.splice(0)) await s.close().catch(() => undefined);
  await bed?.close();
  bed = null;
});

async function start(): Promise<LiveOpsTestbed> {
  bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
  return bed;
}

/** The scheduler process's composition root (apps/scheduler), not started unless asked. */
async function scheduler(owner: string, options: { start?: boolean; leaseMs?: number } = {}): Promise<SchedulerPlatform> {
  const platform = await createSchedulerPlatform(
    { databaseUrl: bed!.db.url, logLevel: 'silent', dbPoolMax: 2, owner, leaseMs: options.leaseMs ?? 30_000, pollMs: 25, reconciliationPolicy: RECONCILIATION_POLICY },
    { logger: createSilentLogger() },
  );
  schedulers.push(platform);
  if (options.start ?? true) platform.scheduler.start();
  return platform;
}

async function until<T>(probe: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const taskStatus = async (taskId: string) => (await bed!.rows<{ status: string }>('select status from agent_tasks where task_id = $1', [taskId]))[0]!.status;
const runsOf = (taskId: string) => bed!.rows<{ run_id: string; status: string }>('select run_id, status from agent_runs where task_id = $1 order by sequence', [taskId]);
const stepsOf = (runId: string) =>
  bed!.rows<{ decision_type: string | null; outcome: string; origin: string; code: string | null; condition: string | null }>(
    `select decision_type, outcome, origin, error_code as code, decision->'condition'->>'kind' as condition from agent_run_steps where run_id = $1 order by iteration`,
    [runId],
  );
const shape = (steps: Awaited<ReturnType<typeof stepsOf>>) => steps.map((s) => [s.decision_type, s.outcome, s.origin, s.code ?? s.condition]);
const temporalEvents = (taskId: string) =>
  bed!.rows<{ event_type: string; actor_ref: string | null; data: Record<string, unknown> }>('select event_type, actor_ref, data from temporal_events where task_id = $1 order by occurred_at, event_id', [taskId]);
const schedulesOf = (taskId: string) => bed!.rows<{ kind: string; status: string; owner: string | null; generation: number }>('select kind, status, owner, generation from schedules where task_id = $1', [taskId]);

/** Turn 1: the agent decides to follow up later (WAIT_UNTIL T0 + 1 s on the frozen temporal clock). */
async function waitingTurn(worker: WorkerPlatform): Promise<{ taskId: string; t0: Date }> {
  await bed!.customer(CUSTOMER, 'wamid.in.1', 'Lo veo y te aviso.');
  const t0 = await freezeTemporalClock(bed!.pool);
  bed!.next(waitUntil(new Date(t0.getTime() + DUE_IN_MS).toISOString()), say(REPLY));
  expect((await worker.worker.runOnce()).kind).not.toBe('idle');
  const taskId = await bed!.taskOf(CUSTOMER);
  expect(await taskStatus(taskId)).toBe('waiting');
  expect(await schedulesOf(taskId)).toEqual([{ kind: 'wake', status: 'pending', owner: null, generation: 0 }]);
  return { taskId, t0 };
}

/** The woken run: the agent replies, the reply is terminal for the turn (platform WAIT_FOR_INPUT). */
async function expectWokenReply(taskId: string): Promise<void> {
  const runs = await runsOf(taskId);
  expect(runs).toHaveLength(2);
  expect(shape(await stepsOf(runs[1]!.run_id))).toEqual([
    ['respond', 'recorded', 'model', null],
    ['wait', 'recorded', 'platform', 'WAIT_FOR_INPUT'],
  ]);
}

describe('R4-J1E-R2.1 the scheduler process wakes a durable WAIT_UNTIL (production compositions)', () => {
  it('2. WAIT_UNTIL → scheduler claim → fired → woken → new run → respond → turn ends → one outbound', async () => {
    await start();
    const worker = await bed!.worker('worker-1');
    const { taskId, t0 } = await waitingTurn(worker);
    await scheduler('scheduler-a');
    await new Promise((r) => setTimeout(r, 200)); // the scheduler polls; the frozen clock says "not due"
    expect((await schedulesOf(taskId))[0]).toMatchObject({ status: 'pending' });

    await freezeTemporalClock(bed!.pool, new Date(t0.getTime() + DUE_IN_MS + 1));
    await until(async () => (await taskStatus(taskId)) === 'running', 'the scheduler to wake the task');
    const types = (await temporalEvents(taskId)).map((e) => e.event_type);
    const from = types.indexOf('schedule.created');
    expect(types.slice(from).filter((t) => ['schedule.created', 'schedule.claimed', 'schedule.fired', 'task.wait.completed', 'task.woken'].includes(t))).toEqual([
      'schedule.created', 'schedule.claimed', 'schedule.fired', 'task.wait.completed', 'task.woken',
    ]);
    expect((await temporalEvents(taskId)).find((e) => e.event_type === 'schedule.fired')!.actor_ref).toBe('scheduler-a');
    expect((await schedulesOf(taskId))[0]).toMatchObject({ status: 'fired', generation: 1 });

    expect((await worker.worker.runOnce()).kind).not.toBe('idle');
    await expectWokenReply(taskId);
    await bed!.deliver();
    await bed!.deliver();
    expect(bed!.provider.sends.map((s) => s.text)).toEqual([REPLY]);
  });

  it('3. the scheduler stops before dueAt: a new scheduler claims the durable timer, exactly one wake', async () => {
    await start();
    const worker = await bed!.worker('worker-1');
    const first = await scheduler('scheduler-a');
    const { taskId, t0 } = await waitingTurn(worker);
    await first.close(); // stopped while the timer was not due: it held no claim
    schedulers.splice(schedulers.indexOf(first), 1);
    expect((await schedulesOf(taskId))[0]).toMatchObject({ status: 'pending', owner: null });

    await freezeTemporalClock(bed!.pool, new Date(t0.getTime() + DUE_IN_MS + 1));
    await scheduler('scheduler-b');
    await until(async () => (await taskStatus(taskId)) === 'running', 'the new scheduler to wake the task');
    const events = await temporalEvents(taskId);
    expect(events.filter((e) => e.event_type === 'schedule.claimed').map((e) => e.actor_ref)).toEqual(['scheduler-b']);
    expect(events.filter((e) => e.event_type === 'schedule.fired')).toHaveLength(1);
    expect(events.filter((e) => e.event_type === 'task.woken')).toHaveLength(1);

    expect((await worker.worker.runOnce()).kind).not.toBe('idle');
    await expectWokenReply(taskId);
    await bed!.deliver();
    expect(bed!.provider.sends.map((s) => s.text)).toEqual([REPLY]);
  });

  it('4. the worker process is gone during WAIT_UNTIL: the scheduler wakes the task and a NEW worker continues (no loss, no duplicate)', async () => {
    await start();
    const first = await bed!.worker('worker-1');
    const { taskId, t0 } = await waitingTurn(first);
    await first.close();

    await freezeTemporalClock(bed!.pool, new Date(t0.getTime() + DUE_IN_MS + 1));
    await scheduler('scheduler-a');
    await until(async () => (await taskStatus(taskId)) === 'running', 'the scheduler to wake the task');
    const second = await bed!.worker('worker-2');
    expect((await second.worker.runOnce()).kind).not.toBe('idle');
    await expectWokenReply(taskId);
    await bed!.deliver();
    await bed!.deliver();
    expect(bed!.provider.sends.map((s) => s.text)).toEqual([REPLY]);
  });

  it('5. duplicate schedulers and a stale token: one claim fires, the stale firing is refused, one wake, one run, one outbound', async () => {
    await start();
    const worker = await bed!.worker('worker-1');
    const { taskId, t0 } = await waitingTurn(worker);
    await freezeTemporalClock(bed!.pool, new Date(t0.getTime() + DUE_IN_MS + 1));

    // Scheduler A claims the due timer and dies before firing (a lease never renewed).
    const a = await scheduler('scheduler-a', { start: false, leaseMs: 200 });
    const claimed = (await a.temporal.claimSchedule('scheduler-a', 200))!;
    expect(claimed).not.toBeNull();
    const stale: ScheduleToken = { scheduleId: claimed.scheduleId, taskId: claimed.taskId, owner: 'scheduler-a', generation: claimed.generation };
    // Two live schedulers race for it once A's lease has expired on the temporal clock.
    await Promise.all([scheduler('scheduler-b'), scheduler('scheduler-c')]);
    await freezeTemporalClock(bed!.pool, new Date(t0.getTime() + DUE_IN_MS + 1_000));
    await until(async () => (await taskStatus(taskId)) === 'running', 'a live scheduler to reclaim and fire');
    await expect(a.temporal.fireSchedule(stale)).rejects.toMatchObject({ code: 'schedule_lease_lost' });

    const events = await temporalEvents(taskId);
    const claims = events.filter((e) => e.event_type === 'schedule.claimed');
    expect(claims.map((c) => c.actor_ref)[0]).toBe('scheduler-a');
    expect(claims).toHaveLength(2); // A, then exactly one of B/C after A's lease expired
    expect(['scheduler-b', 'scheduler-c']).toContain(claims[1]!.actor_ref);
    expect(events.filter((e) => e.event_type === 'schedule.fired')).toHaveLength(1);
    expect(events.filter((e) => e.event_type === 'task.woken')).toHaveLength(1);
    expect((await schedulesOf(taskId))[0]).toMatchObject({ status: 'fired', generation: 2 });

    expect((await worker.worker.runOnce()).kind).not.toBe('idle');
    expect((await worker.worker.runOnce()).kind).toBe('idle');
    expect(await runsOf(taskId)).toHaveLength(2);
    await bed!.deliver();
    await bed!.deliver();
    expect(bed!.provider.sends.map((s) => s.text)).toEqual([REPLY]);
  });
});
