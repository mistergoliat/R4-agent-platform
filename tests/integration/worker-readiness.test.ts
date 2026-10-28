import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerAdmission, WorkerPlatform } from '@r4/worker';
import { PostgresWorkerPresenceStore } from '@r4/persistence-postgres';
import { ACCESS_TOKEN, APP_SECRET, IDENTITY_KEY, LiveOpsTestbed, VERIFY_TOKEN, say } from '../support/live-ops.js';
import { waitFor } from '../support/worker.js';

/**
 * R4-I worker readiness: `/ready` is CHANNEL readiness and never depends on
 * workers; `/ready/r4` is channel ready AND at least one fresh, compatible,
 * ready PRODUCTION worker (worker_presence on the DB clock). Real gateway,
 * real production worker composition, disposable database, no network.
 */
const CUSTOMER = '56933334444';
/** Short windows so expiry is observable: renewals every 150 ms, fresh for 600 ms. */
const FAST = { leaseDurationMs: 600, heartbeatIntervalMs: 150 } as const;

let bed: LiveOpsTestbed | null = null;
const releases: (() => void)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await bed?.close();
  bed = null;
});

interface ReadinessBody {
  readonly status: string;
  readonly checks: Record<string, unknown> & {
    readonly execution: { readonly ok: boolean; readonly status: string; readonly expected: { readonly compatibility: string }; readonly workers: Record<string, number> };
  };
}

async function get(url: '/ready' | '/ready/r4') {
  const res = await bed!.gateway.app.inject({ method: 'GET', url });
  return { code: res.statusCode, body: res.json<ReadinessBody>(), raw: res.body };
}
const execution = async () => (await get('/ready/r4')).body.checks.execution;

async function row(workerId: string) {
  const [r] = await bed!.rows<{ state: string; reason: string | null; execution_mode: string; compatibility: string; build_ref: string | null; heartbeat_at: Date; window_ms: number; fresh: boolean }>(
    `select state, reason, execution_mode, compatibility, build_ref, heartbeat_at,
            (extract(epoch from (expires_at - heartbeat_at)) * 1000)::int as window_ms, expires_at > clock_timestamp() as fresh
       from worker_presence where worker_id = $1`,
    [workerId],
  );
  return r;
}

async function started(workerId: string, overrides: Parameters<LiveOpsTestbed['worker']>[1] = {}): Promise<WorkerPlatform> {
  const w = await bed!.worker(workerId, overrides);
  w.worker.start();
  await waitFor(async () => (await row(workerId))?.state === 'ready');
  return w;
}

/** An admission that answers normally a few times, then hangs: the loop is stuck while the process lives on. */
function stuckAfter(cycles: number): WorkerAdmission {
  let calls = 0;
  let release!: () => void;
  const hang = new Promise<{ admitted: boolean; reason: string }>((resolve) => {
    release = () => resolve({ admitted: false, reason: 'released' });
  });
  releases.push(release);
  return { admit: () => (++calls <= cycles ? Promise.resolve({ admitted: false, reason: 'test_refused' }) : hang) };
}

describe('dead worker (the central regression)', () => {
  it('gateway, database and schema healthy but no worker: /ready stays ready, /ready/r4 is NOT ready', async () => {
    bed = await LiveOpsTestbed.start();
    const channel = await get('/ready');
    expect(channel.code).toBe(200);
    expect(channel.body.status).toBe('ready');
    expect(channel.body.checks).not.toHaveProperty('execution');
    const r4 = await get('/ready/r4');
    expect(r4.code).toBe(503);
    expect(r4.body).toMatchObject({ status: 'not_ready', checks: { channel: { ok: true }, execution: { ok: false, status: 'no_worker', expected: { executionMode: 'production' } } } });
    // ADR-041: 0012_platform_fallback_outbound is the Core head (platform fallback outbound), after RR-1 R-4 0011.
    expect(r4.body.checks.execution.expected.compatibility).toMatch(/^0012_platform_fallback_outbound:sales-production@1$/);
  });
});

describe('worker presence lifecycle', () => {
  it('publishes nothing before the loop runs, then READY once initialized; renewals use the DB clock', async () => {
    bed = await LiveOpsTestbed.start();
    const w = await bed.worker('A', { leaseDurationMs: 1000, heartbeatIntervalMs: 200 });
    expect(await row('A')).toBeUndefined();
    expect((await execution()).status).toBe('no_worker');
    w.worker.start();
    await waitFor(async () => (await row('A'))?.state === 'ready');
    const first = (await row('A'))!;
    expect(first).toMatchObject({ execution_mode: 'production', compatibility: '0012_platform_fallback_outbound:sales-production@1', build_ref: null, reason: null, fresh: true, window_ms: 1000 });
    await waitFor(async () => (await row('A'))!.heartbeat_at.getTime() > first.heartbeat_at.getTime());
    expect((await row('A'))!.window_ms).toBe(1000);
    expect(await get('/ready/r4')).toMatchObject({ code: 200, body: { status: 'ready', checks: { execution: { ok: true, status: 'ready', workers: { ready: 1 } } } } });
  });

  it('an idle worker (zero tasks, kill switch engaged) stays ready well past its freshness window', async () => {
    bed = await LiveOpsTestbed.start();
    expect((await bed.store.readControls()).state.globalEnabled).toBe(false);
    await started('A', FAST);
    await new Promise((r) => setTimeout(r, FAST.leaseDurationMs * 3));
    expect(await row('A')).toMatchObject({ state: 'ready', fresh: true });
    expect(await bed.rows('select count(*)::int as n from agent_tasks')).toEqual([{ n: 0 }]);
    expect((await get('/ready/r4')).code).toBe(200);
  });

  it('kill switch OFF or ON: the worker stays ready (capability, not authority)', async () => {
    bed = await LiveOpsTestbed.start({ autonomy: true });
    await started('A', FAST);
    await bed.setAutonomy(false);
    await new Promise((r) => setTimeout(r, FAST.leaseDurationMs * 2));
    expect(await row('A')).toMatchObject({ state: 'ready', fresh: true });
    expect((await get('/ready/r4')).code).toBe(200);
    await bed.setAutonomy(true);
    expect((await get('/ready/r4')).code).toBe(200);
  });

  it('a live process whose loop is stuck stops renewing and expires (no independent timer keeps it green)', async () => {
    bed = await LiveOpsTestbed.start();
    await started('A', { ...FAST, admission: stuckAfter(3) });
    await waitFor(async () => !(await row('A'))!.fresh, 5000);
    expect((await row('A'))!.state).toBe('ready');
    expect(await get('/ready/r4')).toMatchObject({ code: 503, body: { checks: { execution: { status: 'stale', workers: { ready: 0, stale: 1 } } } } });
  });

  it('graceful shutdown stops advertising first; no later renewal returns it to ready', async () => {
    bed = await LiveOpsTestbed.start();
    const a = await started('A', FAST);
    await started('B', FAST);
    await a.close();
    expect(await row('A')).toMatchObject({ state: 'stopping', reason: 'shutting_down' });
    await a.presence.progressed();
    expect(await new PostgresWorkerPresenceStore(bed.pool).refreshWorker('A', { state: 'ready', reason: null }, 60_000)).toBe(false);
    expect((await row('A'))!.state).toBe('stopping');
    expect(await execution()).toMatchObject({ ok: true, workers: { ready: 1, stopping: 1 } });
    const b = await started('C', FAST);
    await b.close();
    expect((await execution()).workers.stopping).toBe(2);
  });
});

describe('who counts toward production execution readiness', () => {
  it('worker returns without a gateway restart: none → ready → dead/expired → a new worker → ready', async () => {
    bed = await LiveOpsTestbed.start();
    expect((await execution()).status).toBe('no_worker');
    await started('A', { ...FAST, admission: stuckAfter(2) });
    expect((await get('/ready/r4')).code).toBe(200);
    await waitFor(async () => (await execution()).status === 'stale', 5000);
    expect((await get('/ready/r4')).code).toBe(503);
    await started('B', FAST);
    expect(await get('/ready/r4')).toMatchObject({ code: 200, body: { checks: { execution: { workers: { ready: 1, stale: 1 } } } } });
  });

  it('multiple workers: A and B ready; A dies → still ready through B; B stops → not ready', async () => {
    bed = await LiveOpsTestbed.start();
    await started('A', { ...FAST, admission: stuckAfter(2) });
    const b = await started('B', FAST);
    expect((await execution()).workers.ready).toBe(2);
    await waitFor(async () => !(await row('A'))!.fresh, 5000);
    expect(await get('/ready/r4')).toMatchObject({ code: 200, body: { checks: { execution: { status: 'ready', workers: { ready: 1, stale: 1 } } } } });
    await b.close();
    expect(await get('/ready/r4')).toMatchObject({ code: 503, body: { checks: { execution: { status: 'stopping', workers: { ready: 0 } } } } });
  });

  it('a fresh READY shadow worker (same profile) never satisfies production readiness; neither does a test worker', async () => {
    bed = await LiveOpsTestbed.start();
    await started('S', { ...FAST, presence: { executionMode: 'shadow', runtimeProfile: 'sales-production@1' } });
    await started('T', { ...FAST, presence: { executionMode: 'test', runtimeProfile: 'sales-production@1' } });
    expect(await row('S')).toMatchObject({ execution_mode: 'shadow', compatibility: '0012_platform_fallback_outbound:sales-production@1', fresh: true });
    expect(await get('/ready/r4')).toMatchObject({ code: 503, body: { checks: { execution: { status: 'no_worker', workers: { ready: 0, otherMode: 2 } } } } });
    await started('P', FAST);
    expect((await get('/ready/r4')).code).toBe(200);
  });

  it('a fresh production worker with another execution contract does not count; a compatible one does', async () => {
    bed = await LiveOpsTestbed.start();
    await started('OLD', { ...FAST, presence: { executionMode: 'production', runtimeProfile: 'sales-production@0' } });
    expect(await get('/ready/r4')).toMatchObject({ code: 503, body: { checks: { execution: { status: 'incompatible', workers: { ready: 0, incompatible: 1 } } } } });
    await started('NEW', FAST);
    expect(await get('/ready/r4')).toMatchObject({ code: 200, body: { checks: { execution: { workers: { ready: 1, incompatible: 1 } } } } });
  });

  it('build_ref is optional and diagnostic: NULL is ready; a supplied ref is reported, never required', async () => {
    bed = await LiveOpsTestbed.start();
    await started('NULL', FAST);
    expect(await execution()).toMatchObject({ ok: true, workers: { buildRefs: [] } });
    await started('REF', { ...FAST, presence: { executionMode: 'production', runtimeProfile: 'sales-production@1', buildRef: 'git-0123abc' } });
    expect(await row('REF')).toMatchObject({ build_ref: 'git-0123abc', compatibility: '0012_platform_fallback_outbound:sales-production@1' });
    expect(await execution()).toMatchObject({ ok: true, workers: { ready: 2, buildRefs: ['git-0123abc'] } });
  });
});

describe('deployment build identity (R4_BUILD_REF → worker_presence.build_ref)', () => {
  const SHA = '0337a34b712b1bf9e758b8335ee532d6cf29ab05';

  it('persists the configured ref exactly; absent stays NULL; neither changes compatibility or readiness', async () => {
    bed = await LiveOpsTestbed.start();
    await started('NOREF', FAST);
    const withoutRef = (await row('NOREF'))!;
    expect(withoutRef.build_ref).toBeNull();
    await started('SHA', { ...FAST, buildRef: SHA });
    const withRef = (await row('SHA'))!;
    expect(withRef.build_ref).toBe(SHA);
    expect(withRef).toMatchObject({ execution_mode: withoutRef.execution_mode, compatibility: withoutRef.compatibility, state: 'ready', fresh: true });
    expect(await get('/ready/r4')).toMatchObject({ code: 200, body: { checks: { execution: { status: 'ready', expected: { compatibility: withoutRef.compatibility }, workers: { ready: 2, incompatible: 0, buildRefs: [SHA] } } } } });
  });

  it('a different build ref alone never makes a worker compatible, nor an incompatible one eligible', async () => {
    bed = await LiveOpsTestbed.start();
    await started('OLD', { ...FAST, buildRef: SHA, presence: { executionMode: 'production', runtimeProfile: 'sales-production@0' } });
    await started('SHADOW', { ...FAST, buildRef: SHA, presence: { executionMode: 'shadow', runtimeProfile: 'sales-production@1' } });
    expect(await get('/ready/r4')).toMatchObject({ code: 503, body: { checks: { execution: { workers: { ready: 0, incompatible: 1, otherMode: 1, buildRefs: [] } } } } });
    await started('OTHER', { ...FAST, buildRef: 'a'.repeat(40) });
    expect(await get('/ready/r4')).toMatchObject({ code: 200, body: { checks: { execution: { workers: { ready: 1, buildRefs: ['a'.repeat(40)] } } } } });
  });
});

describe('failures', () => {
  it('schema not current: channel and aggregate NOT ready (even with a ready worker); a worker refuses to boot on it', async () => {
    bed = await LiveOpsTestbed.start();
    await started('A', FAST);
    const [applied] = await bed.rows<{ checksum: string }>(`select checksum from r4_schema_migrations where id = '0008_worker_presence'`);
    await bed.pool.query(`delete from r4_schema_migrations where id = '0008_worker_presence'`);
    try {
      expect(await get('/ready')).toMatchObject({ code: 503, body: { checks: { database: { ok: false, pendingMigrations: ['0008_worker_presence'] } } } });
      expect(await get('/ready/r4')).toMatchObject({ code: 503, body: { status: 'not_ready', checks: { channel: { ok: false } } } });
      await expect(bed.worker('B')).rejects.toMatchObject({ code: 'schema_not_current' });
    } finally {
      await bed.pool.query(`insert into r4_schema_migrations (id, checksum) values ('0008_worker_presence', $1)`, [applied!.checksum]);
    }
    expect((await get('/ready/r4')).code).toBe(200);
  });

  it('presence unreadable: aggregate reports execution unavailable (never ready); /ready is unaffected', async () => {
    bed = await LiveOpsTestbed.start();
    await started('A', FAST);
    await bed.pool.query('alter table worker_presence rename to worker_presence_offline');
    try {
      expect((await get('/ready')).code).toBe(200);
      expect(await get('/ready/r4')).toMatchObject({ code: 503, body: { checks: { channel: { ok: true }, execution: { ok: false, status: 'unavailable', workers: null } } } });
    } finally {
      await bed.pool.query('alter table worker_presence_offline rename to worker_presence');
    }
  });
});

describe('ingress during an execution outage', () => {
  it('no worker: inbound is still durably accepted (channel ready, aggregate not); the returning worker processes it', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    expect((await bed.customer(CUSTOMER, 'wamid.out.1', 'Hola, ¿hay stock?')).status).toBe(200);
    const taskId = await bed.taskOf(CUSTOMER);
    expect(await bed.rows('select count(*)::int as n from inbound_events')).toEqual([{ n: 1 }]);
    expect(await bed.rows(`select count(*)::int as n from task_inputs where task_id = $1`, [taskId])).toEqual([{ n: 1 }]);
    expect((await get('/ready')).code).toBe(200);
    expect(await get('/ready/r4')).toMatchObject({ code: 503, body: { checks: { execution: { status: 'no_worker' } } } });
    expect(bed.model.callCount).toBe(0);

    bed.next(say('Sí, te ayudo con el stock.'));
    await started('A', FAST);
    await waitFor(async () => {
      await bed!.gateway.delivery.materialize();
      return (await bed!.store.outboundForTask(taskId)).length === 1;
    }, 10_000);
    expect(bed.model.callCount).toBeGreaterThan(0);
    expect((await get('/ready/r4')).code).toBe(200);
  });
});

describe('readiness has no customer effect and exposes no secret', () => {
  it('repeated /ready and /ready/r4 create no task, run, decision, proposal, outbound or send — and do not dispatch pending outbound', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    await bed.customer(CUSTOMER, 'wamid.fx.1', 'Hola');
    bed.next(say('respuesta pendiente de entrega'));
    await bed.runAgent();
    expect(await bed.gateway.delivery.materialize()).toHaveLength(1);
    // Autonomy stays ON: the pending response IS sendable, so any delivery pass triggered by a probe would show.
    await started('A', FAST);
    const snapshot = () => bed!.rows(`select
      (select count(*) from agent_tasks)::int as tasks, (select count(*) from agent_runs)::int as runs,
      (select count(*) from agent_run_steps)::int as steps, (select count(*) from action_proposals)::int as proposals,
      (select count(*) from inbound_events)::int as inbound, (select count(*) from task_inputs)::int as inputs,
      (select count(*) from outbound_messages)::int as outbound, (select count(*) from outbound_delivery_attempts)::int as attempts,
      (select string_agg(status, ',') from outbound_messages) as statuses`);
    const before = await snapshot();
    const calls = bed.model.callCount;
    for (let i = 0; i < 10; i += 1) {
      expect((await get('/ready')).code).toBe(200);
      expect((await get('/ready/r4')).code).toBe(200);
    }
    expect(await snapshot()).toEqual(before);
    expect(before[0]).toMatchObject({ statuses: 'pending', attempts: 0 });
    expect(bed.model.callCount).toBe(calls);
    expect(bed.provider.sends).toHaveLength(0);
  });

  it('readiness output and worker_presence rows carry no credential, URL, environment or customer data', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER] });
    await bed.customer(CUSTOMER, 'wamid.sec.1', 'mi dirección es Calle Secreta 123');
    await started('A', { ...FAST, buildRef: '0337a34b712b1bf9e758b8335ee532d6cf29ab05' });
    await started('S', { ...FAST, presence: { executionMode: 'shadow', runtimeProfile: 'sales-shadow@1' } });
    const texts = [(await get('/ready')).raw, (await get('/ready/r4')).raw, JSON.stringify(await bed.rows('select row_to_json(p)::text as r from worker_presence p'))];
    const forbidden = [bed.db.url, new URL(bed.db.url).password, 'postgres://', ACCESS_TOKEN, APP_SECRET, VERIFY_TOKEN, IDENTITY_KEY, CUSTOMER, 'Calle Secreta', 'R4_'];
    for (const text of texts) for (const secret of forbidden) expect(text).not.toContain(secret);
  });
});
