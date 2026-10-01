import { afterEach, describe, expect, it } from 'vitest';
import type { ScheduleToken } from '@r4/contracts';
import { createSilentLogger } from '@r4/observability';
import { createSchedulerPlatform, type SchedulerPlatform } from '@r4/scheduler';
import type { WorkerPlatform } from '@r4/worker';
import { LiveOpsTestbed, say, waitInput } from '../support/live-ops.js';
import { OwnerWindowCatalog } from '../support/owner-window-catalog.js';
import { RECONCILIATION_POLICY } from '../support/temporal.js';

/**
 * R4-J1E-R2.1 — production composition correction, over the REAL production
 * compositions: the Sales production worker (profile sales-production@2,
 * Catalog REAL through a local stand-in of catalog-service, the Sales
 * commercial evidence validator), the channel gateway, and the scheduler
 * composition root of apps/scheduler (`createSchedulerPlatform`, its own
 * polling loop). Nothing fires the wake by hand: the scheduler does.
 *
 *   fresh Catalog evidence with < 3 s left → response_authority_deferred →
 *   platform WAIT_UNTIL → schedule.created → scheduler claim → schedule.fired
 *   → task.wait.completed → task.woken → new run → platform Catalog READ →
 *   same draft revalidated → recorded → one outbound.
 */

const CUSTOMER = '56911112222';
const PRICE_REPLY = 'El Power Rack PR-200 está a $289.990.';
const SAFE_REPLY = 'Perdón, no pude confirmar el precio ni la disponibilidad actual en este momento. ¿Quieres que lo revise de nuevo?';
const search = (query: string) => ({ type: 'structured' as const, data: { type: 'read_capability', capabilityId: 'catalog.search', arguments: { query } } });

let bed: LiveOpsTestbed | null = null;
const schedulers: SchedulerPlatform[] = [];
afterEach(async () => {
  for (const s of schedulers.splice(0)) await s.close().catch(() => undefined);
  await bed?.close();
  bed = null;
});

async function start(windowMs: number): Promise<{ bed: LiveOpsTestbed; catalog: OwnerWindowCatalog }> {
  const catalog = new OwnerWindowCatalog(windowMs);
  bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, env: { R4_PROD_POLICY_PROFILE: 'sales-production@2' }, catalog });
  return { bed, catalog };
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
  bed!.rows<{ decision_type: string | null; outcome: string; origin: string; code: string | null; capability: string | null; content: string | null }>(
    `select decision_type, outcome, origin, error_code as code, decision->>'capabilityId' as capability, decision->>'content' as content from agent_run_steps where run_id = $1 order by iteration, created_at, step_id`,
    [runId],
  );
const shape = (steps: Awaited<ReturnType<typeof stepsOf>>) => steps.map((s) => [s.decision_type, s.outcome, s.origin, s.code ?? s.capability]);
const temporalEvents = (taskId: string) =>
  bed!.rows<{ event_type: string; actor_ref: string | null; data: Record<string, unknown>; occurred_at: Date }>('select event_type, actor_ref, data, occurred_at from temporal_events where task_id = $1 order by occurred_at, event_id', [taskId]);
const schedulesOf = (taskId: string) => bed!.rows<{ schedule_id: string; kind: string; status: string; due_at: Date; owner: string | null; generation: number }>('select schedule_id, kind, status, due_at, owner, generation from schedules where task_id = $1', [taskId]);
const recordedResponses = (taskId: string) => bed!.rows<{ content: string }>(`select decision->>'content' as content from agent_run_steps where task_id = $1 and decision_type = 'respond' and outcome = 'recorded' order by created_at`, [taskId]);

/** Turn 1: the model searches and drafts the price while the owner evidence has < 3 s left → the draft is deferred. */
async function deferredTurn(worker: WorkerPlatform): Promise<string> {
  bed!.next(search('power rack'), say(PRICE_REPLY), waitInput());
  await bed!.customer(CUSTOMER, 'wamid.in.1', '¿Cuánto cuesta el power rack?');
  expect((await worker.worker.runOnce()).kind).not.toBe('idle');
  const taskId = await bed!.taskOf(CUSTOMER);
  expect(await taskStatus(taskId)).toBe('waiting');
  const [run1] = await runsOf(taskId);
  expect(shape(await stepsOf(run1!.run_id))).toEqual([
    ['read_capability', 'observed', 'model', 'catalog.search'],
    ['respond', 'refused', 'model', 'response_authority_deferred'],
    ['wait', 'recorded', 'platform', null],
  ]);
  const [wake] = await schedulesOf(taskId);
  expect(wake).toMatchObject({ kind: 'wake', status: 'pending' });
  return taskId;
}

/** The woken run: platform READ of the product, the SAME draft recorded by the platform, then the model's next decision. */
async function expectRevalidatedRun(taskId: string, catalog: OwnerWindowCatalog, firedAt: number): Promise<void> {
  const runs = await runsOf(taskId);
  expect(runs).toHaveLength(2);
  expect(shape(await stepsOf(runs[1]!.run_id))).toEqual([
    ['read_capability', 'observed', 'platform', 'catalog.get_product_context'],
    ['respond', 'recorded', 'platform', null],
    ['wait', 'recorded', 'model', null],
  ]);
  const refresh = catalog.calls.filter((c) => c.operation === 'product_context');
  expect(refresh).toHaveLength(1);
  expect(refresh[0]!.key).toBe('RACK-PR200');
  expect(refresh[0]!.at).toBeGreaterThanOrEqual(firedAt); // a NEW Catalog observation, after the wake
  expect(await recordedResponses(taskId)).toEqual([{ content: PRICE_REPLY }]);
}

describe('R4-J1E-R2.1 the scheduler process wakes a deferred response (production compositions)', () => {
  it('2/7. near-expiry → deferred → WAIT_UNTIL → scheduler claim → fired → woken → new run → Catalog refresh → same draft recorded → one outbound', async () => {
    const { bed, catalog } = await start(2_000);
    const worker = await bed.worker('worker-1');
    const taskId = await deferredTurn(worker);
    expect(bed.provider.sends).toHaveLength(0); // nothing reaches the customer while the draft waits
    await bed.deliver();
    expect(bed.provider.sends).toHaveLength(0);

    catalog.windowMs = 15_000; // the owner's window after its cache expired
    await scheduler('scheduler-a');
    await until(async () => (await taskStatus(taskId)) === 'running', 'the scheduler to wake the task');

    const events = await temporalEvents(taskId);
    const types = events.map((e) => e.event_type);
    const from = types.indexOf('schedule.created');
    expect(types.slice(from).filter((t) => ['schedule.created', 'schedule.claimed', 'schedule.fired', 'task.wait.completed', 'task.woken'].includes(t))).toEqual([
      'schedule.created', 'schedule.claimed', 'schedule.fired', 'task.wait.completed', 'task.woken',
    ]);
    const fired = events.find((e) => e.event_type === 'schedule.fired')!;
    expect(fired.actor_ref).toBe('scheduler-a');
    expect(events.find((e) => e.event_type === 'task.wait.completed')!.data).toMatchObject({ kind: 'WAIT_UNTIL', resolution: 'timer' });
    expect((await schedulesOf(taskId))[0]).toMatchObject({ status: 'fired', generation: 1 });

    expect((await worker.worker.runOnce()).kind).not.toBe('idle');
    await expectRevalidatedRun(taskId, catalog, fired.occurred_at.getTime());
    await bed.deliver();
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual([PRICE_REPLY]);
  });

  it('3. the scheduler stops before dueAt: a new scheduler claims the durable timer, exactly one wake', async () => {
    const { bed, catalog } = await start(2_000);
    const worker = await bed.worker('worker-1');
    const first = await scheduler('scheduler-a');
    const taskId = await deferredTurn(worker);
    await first.close(); // stopped before the timer was due: it held no claim
    schedulers.splice(schedulers.indexOf(first), 1);
    expect((await schedulesOf(taskId))[0]).toMatchObject({ status: 'pending', owner: null });

    catalog.windowMs = 15_000;
    await scheduler('scheduler-b');
    await until(async () => (await taskStatus(taskId)) === 'running', 'the new scheduler to wake the task');
    const events = await temporalEvents(taskId);
    expect(events.filter((e) => e.event_type === 'schedule.claimed').map((e) => e.actor_ref)).toEqual(['scheduler-b']);
    expect(events.filter((e) => e.event_type === 'schedule.fired')).toHaveLength(1);
    expect(events.filter((e) => e.event_type === 'task.woken')).toHaveLength(1);

    expect((await worker.worker.runOnce()).kind).not.toBe('idle');
    await expectRevalidatedRun(taskId, catalog, events.find((e) => e.event_type === 'schedule.fired')!.occurred_at.getTime());
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual([PRICE_REPLY]);
  });

  it('4. the worker process is gone during WAIT_UNTIL: the scheduler wakes the task and a NEW worker continues the same draft (no loss, no duplicate)', async () => {
    const { bed, catalog } = await start(2_000);
    const first = await bed.worker('worker-1');
    const taskId = await deferredTurn(first);
    await first.close(); // releases nothing it holds: the run already suspended and released its lease

    catalog.windowMs = 15_000;
    await scheduler('scheduler-a');
    await until(async () => (await taskStatus(taskId)) === 'running', 'the scheduler to wake the task');
    const second = await bed.worker('worker-2');
    expect((await second.worker.runOnce()).kind).not.toBe('idle');
    const fired = (await temporalEvents(taskId)).find((e) => e.event_type === 'schedule.fired')!;
    await expectRevalidatedRun(taskId, catalog, fired.occurred_at.getTime());
    expect(catalog.calls.filter((c) => c.operation === 'search')).toHaveLength(1); // the draft was not re-drafted
    await bed.deliver();
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual([PRICE_REPLY]);
  });

  it('5. duplicate schedulers and a stale token: one claim fires, the stale firing is refused, one wake, one run, one outbound', async () => {
    const { bed, catalog } = await start(2_000);
    const worker = await bed.worker('worker-1');
    const taskId = await deferredTurn(worker);
    catalog.windowMs = 15_000;

    // Scheduler A claims the due timer and dies before firing (a short lease, never renewed).
    const a = await scheduler('scheduler-a', { start: false, leaseMs: 200 });
    const claimed = await until(() => a.temporal.claimSchedule('scheduler-a', 200), 'the timer to become due');
    const stale: ScheduleToken = { scheduleId: claimed.scheduleId, taskId: claimed.taskId, owner: 'scheduler-a', generation: claimed.generation };
    // Two live schedulers race for it once A's lease expires.
    await Promise.all([scheduler('scheduler-b'), scheduler('scheduler-c')]);
    await until(async () => (await taskStatus(taskId)) === 'running', 'a live scheduler to reclaim and fire');
    await expect(a.temporal.fireSchedule(stale)).rejects.toMatchObject({ code: 'schedule_lease_lost' });

    const events = await temporalEvents(taskId);
    const claims = events.filter((e) => e.event_type === 'schedule.claimed');
    expect(claims[0]!.actor_ref).toBe('scheduler-a');
    expect(claims).toHaveLength(2); // A, then exactly one of B/C after A's lease expired
    expect(['scheduler-b', 'scheduler-c']).toContain(claims[1]!.actor_ref);
    expect(events.filter((e) => e.event_type === 'schedule.fired')).toHaveLength(1);
    expect(events.filter((e) => e.event_type === 'task.woken')).toHaveLength(1);
    expect((await schedulesOf(taskId))[0]).toMatchObject({ status: 'fired', generation: 2 });

    expect((await worker.worker.runOnce()).kind).not.toBe('idle');
    expect((await worker.worker.runOnce()).kind).toBe('idle');
    expect(await runsOf(taskId)).toHaveLength(2);
    await bed.deliver();
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual([PRICE_REPLY]);
  });

  it('6. a run that already sent its safe degradation opens no new recovery: no deferral, no WAIT_UNTIL, no platform READ, no second outbound', async () => {
    const { bed, catalog } = await start(2_000);
    const worker = await bed.worker('worker-1');
    // Two contradicted drafts (prices Catalog does not have), then a correct price on near-expiry evidence.
    bed.next(search('power rack'), say('El Power Rack PR-200 está a $123.457.'), say('Está a $1.'), say(PRICE_REPLY), waitInput());
    await bed.customer(CUSTOMER, 'wamid.in.1', '¿Cuánto cuesta el power rack?');
    expect((await worker.worker.runOnce()).kind).not.toBe('idle');
    const taskId = await bed.taskOf(CUSTOMER);

    const [run] = await runsOf(taskId);
    expect(shape(await stepsOf(run!.run_id))).toEqual([
      ['read_capability', 'observed', 'model', 'catalog.search'],
      ['respond', 'refused', 'model', 'response_authority_contradiction'],
      ['respond', 'refused', 'model', 'response_authority_degraded'],
      ['respond', 'recorded', 'platform', null],
      ['respond', 'refused', 'model', 'response_authority_unverifiable'],
      ['wait', 'recorded', 'model', null],
    ]);
    expect(await schedulesOf(taskId)).toEqual([]); // no WAIT_UNTIL timer was ever created
    expect(await bed.rows(`select kind from task_waits where task_id = $1`, [taskId])).toEqual([{ kind: 'WAIT_FOR_INPUT' }]);
    expect(catalog.calls.map((c) => c.operation)).toEqual(['search']); // no platform READ
    expect(await recordedResponses(taskId)).toEqual([{ content: SAFE_REPLY }]);

    await scheduler('scheduler-a'); // a running scheduler has nothing to wake
    await bed.deliver();
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual([SAFE_REPLY]);
    expect(await taskStatus(taskId)).toBe('waiting');
  });

  it('6b. after the degradation, a correct price on CURRENT evidence (Sales ALLOW, claims > 0) is suppressed; a claim-free reply still goes out', async () => {
    const { bed, catalog } = await start(15_000); // evidence comfortably valid: the validator allows the price
    const worker = await bed.worker('worker-1');
    const FOLLOW_UP = '¿Quieres que lo revise de nuevo en un momento?';
    bed.next(search('power rack'), say('El Power Rack PR-200 está a $123.457.'), say('Está a $1.'), say(PRICE_REPLY), say(FOLLOW_UP), waitInput());
    await bed.customer(CUSTOMER, 'wamid.in.1', '¿Cuánto cuesta el power rack?');
    expect((await worker.worker.runOnce()).kind).not.toBe('idle');
    const taskId = await bed.taskOf(CUSTOMER);

    const [run] = await runsOf(taskId);
    expect(shape(await stepsOf(run!.run_id))).toEqual([
      ['read_capability', 'observed', 'model', 'catalog.search'],
      ['respond', 'refused', 'model', 'response_authority_contradiction'],
      ['respond', 'refused', 'model', 'response_authority_degraded'],
      ['respond', 'recorded', 'platform', null],
      ['respond', 'refused', 'model', 'response_authority_suppressed'],
      ['respond', 'recorded', 'model', null],
      ['wait', 'recorded', 'model', null],
    ]);
    expect(await schedulesOf(taskId)).toEqual([]);
    expect(catalog.calls.map((c) => c.operation)).toEqual(['search']);
    expect(await recordedResponses(taskId)).toEqual([{ content: SAFE_REPLY }, { content: FOLLOW_UP }]);
    await bed.deliver();
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual([SAFE_REPLY, FOLLOW_UP]); // 0 additional commercial outbound
  });
});
