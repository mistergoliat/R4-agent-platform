import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { AutonomyControls, PRODUCTION_CONTROL_ACTOR } from '@r4/live-ops';
import { PostgresProductionStore } from '@r4/persistence-postgres';
import { runProductionControl } from '@r4-sales/agent/production';
import { createMigratedTestDatabase, openPool } from '../support/database.js';
import { LiveOpsTestbed, OPERATOR, say, waitInput } from '../support/live-ops.js';

/**
 * R4-I D-5/D-6: production administration (`production:sales:control`).
 * Every command runs the real CLI entry (`runProductionControl`) against the
 * bed's database with a pool and runtimes of its own — nothing it decides
 * can come from the bed's in-memory state.
 */
/** What the command prints (JSON). */
type ControlOutput = { readonly holds?: readonly { readonly taskId: string }[] } & Record<string, unknown>;
const A = '56911110001';
const B = '56911110002';
const C = '56911110003';
const OUTSIDER = '56911119999';

let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

interface ControlResult {
  readonly code: number;
  readonly json: ControlOutput | null;
  readonly err: string;
}

async function control(env: Readonly<Record<string, string | undefined>>, ...argv: string[]): Promise<ControlResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runProductionControl(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, json: out.length > 0 ? (JSON.parse(out.join('\n')) as ControlOutput) : null, err: err.join('\n') };
}

const ctl = (...argv: string[]) => control(bed!.env, ...argv);

async function waitForTaskLockWaiters(expected: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await bed!.rows<{ count: number }>(
      `select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%agent_tasks%for update%'`,
    );
    if ((row?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${expected} Task row lock waiters`);
}
const handoff = (summary: string) => ({ type: 'structured' as const, data: { type: 'request_handoff', summary, contextRefs: [] } });
const consult = (question: string) => ({ type: 'structured' as const, data: { type: 'request_consultation', question, contextRefs: [] } });

async function controlEvents() {
  return bed!.rows<{ autonomy_enabled: boolean; reason: string; changed_by: string; correlation_id: string; version: number }>('select autonomy_enabled, reason, changed_by, correlation_id, version from autonomy_control_events order by occurred_at, version');
}

async function humansOf(taskId: string) {
  return (await bed!.api.temporal.inspect(taskId)).humans;
}

/** Everything that proves channel/delivery state was not touched by an administrative command. */
async function channelState() {
  return {
    bindings: await bed!.rows('select binding_id, status, autonomy, task_id from channel_conversation_bindings order by binding_id'),
    inbound: await bed!.rows('select inbound_id, status, disposition from inbound_events order by inbound_id'),
    outbound: await bed!.rows('select outbound_id, status, hold_reason, cancel_reason, attempts from outbound_messages order by outbound_id'),
    channelControls: await bed!.rows("select scope from autonomy_controls where scope <> 'global'"),
    inputs: await bed!.rows('select input_id, task_id, external_key from task_inputs order by input_id'),
  };
}

describe('D-5 autonomy status', () => {
  it('reads the authoritative durable state (migration default, then a change by another process)', async () => {
    bed = await LiveOpsTestbed.start();
    const initial = await ctl('autonomy', 'status');
    expect(initial.code).toBe(0);
    expect(initial.json).toMatchObject({ autonomy: 'disabled', lastChange: { by: 'migration:0007', version: 1 }, channels: [] });
    await bed.store.setControl({ scope: 'global', autonomyEnabled: true, reason: 'enabled elsewhere', changedBy: 'someone-else', correlationId: 'x' });
    expect((await ctl('autonomy', 'status')).json).toMatchObject({ autonomy: 'enabled', lastChange: { reason: 'enabled elsewhere', by: 'someone-else', version: 2 } });
  });

  it('is read-only and exposes no database URL, token or secret', async () => {
    bed = await LiveOpsTestbed.start();
    const before = await controlEvents();
    const r = await ctl('autonomy', 'status');
    expect(await controlEvents()).toEqual(before);
    const printed = JSON.stringify(r.json) + r.err;
    for (const secret of [bed.db.url, 'r4-test-access-token', 'r4-test-app-secret', 'r4-test-identity-hash-key']) expect(printed).not.toContain(secret);
  });

  it('needs no channel or model credentials: only the production declaration and the database', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [A] });
    await bed.customer(A, 'wamid.a.1', 'Hola');
    const taskId = await bed.taskOf(A);
    const env = Object.fromEntries(Object.entries(bed.env).filter(([k]) => !k.startsWith('R4_WHATSAPP_') && !k.startsWith('R4_MODEL_')));
    expect((await control(env, 'autonomy', 'status')).code).toBe(0);
    expect((await control(env, 'holds', 'list')).code).toBe(0);
    expect((await control(env, 'autonomy', 'on', '--reason', 'open')).code).toBe(0);
    expect((await control(env, 'holds', 'release', '--task', taskId, '--reason', 'resume'))).toMatchObject({ code: 0, err: '' });
    expect(bed.provider.sends).toHaveLength(0);
  });
});

describe('D-5 autonomy off / on', () => {
  it('off persists the disabled state with its reason and an audited control event attributed to production control', async () => {
    bed = await LiveOpsTestbed.start({ autonomy: true });
    const r = await ctl('autonomy', 'off', '--reason', 'incident 42: wrong prices quoted');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ autonomy: 'disabled', scope: 'global', reason: 'incident 42: wrong prices quoted', by: PRODUCTION_CONTROL_ACTOR });
    expect(await bed.rows("select autonomy_enabled, reason, changed_by from autonomy_controls where scope = 'global'")).toEqual([{ autonomy_enabled: false, reason: 'incident 42: wrong prices quoted', changed_by: PRODUCTION_CONTROL_ACTOR }]);
    const last = (await controlEvents()).at(-1)!;
    expect(last).toMatchObject({ autonomy_enabled: false, reason: 'incident 42: wrong prices quoted', changed_by: PRODUCTION_CONTROL_ACTOR });
    expect(last.correlation_id).toMatch(/^production-control:/);
    // Every process sees it at once (no cache): the worker's admission refuses new claims.
    expect(await new AutonomyControls({ store: new PostgresProductionStore(bed.pool), logger: createSilentLogger() }).admit()).toEqual({ admitted: false, reason: 'autonomy_disabled' });
  });

  it('on persists the enabled state with its reason and an audited control event', async () => {
    bed = await LiveOpsTestbed.start();
    const r = await ctl('autonomy', 'on', '--reason', 'canary approved by ops review');
    expect(r).toMatchObject({ code: 0, json: { autonomy: 'enabled', reason: 'canary approved by ops review', by: PRODUCTION_CONTROL_ACTOR } });
    expect((await controlEvents()).at(-1)).toMatchObject({ autonomy_enabled: true, reason: 'canary approved by ops review', changed_by: PRODUCTION_CONTROL_ACTOR });
    expect((await ctl('autonomy', 'status')).json).toMatchObject({ autonomy: 'enabled', lastChange: { reason: 'canary approved by ops review', by: PRODUCTION_CONTROL_ACTOR } });
  });

  it('repeating a change follows the control primitive: the state is unchanged, the repeated intent is audited', async () => {
    bed = await LiveOpsTestbed.start();
    await ctl('autonomy', 'off', '--reason', 'first');
    await ctl('autonomy', 'off', '--reason', 'second');
    expect((await ctl('autonomy', 'status')).json).toMatchObject({ autonomy: 'disabled', lastChange: { reason: 'second', version: 3 } });
    expect((await controlEvents()).map((e) => [e.autonomy_enabled, e.reason])).toEqual([[false, 'first'], [false, 'second']]);
  });

  it('refuses a mutation without a meaningful reason (no default is invented) and changes nothing', async () => {
    bed = await LiveOpsTestbed.start();
    for (const argv of [['autonomy', 'on'], ['autonomy', 'off'], ['autonomy', 'on', '--reason'], ['autonomy', 'on', '--reason', ''], ['autonomy', 'on', '--reason', '   '], ['autonomy', 'on', '--reason', '--task']]) {
      const r = await ctl(...argv);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/reason/);
    }
    for (const argv of [['holds', 'release', '--task', '00000000-0000-7000-8000-000000000000'], ['holds', 'release', '--task', '00000000-0000-7000-8000-000000000000', '--reason', ' ']]) {
      expect((await ctl(...argv)).code).not.toBe(0);
    }
    expect(await controlEvents()).toEqual([]);
    expect((await ctl('autonomy', 'status')).json).toMatchObject({ autonomy: 'disabled', lastChange: { by: 'migration:0007' } });
  });

  it('rejects unknown, bulk or wildcard commands', async () => {
    bed = await LiveOpsTestbed.start();
    for (const argv of [[], ['autonomy'], ['autonomy', 'toggle', '--reason', 'x'], ['holds', 'release-all', '--reason', 'x'], ['holds', 'release', '--task', '*', '--reason', 'x'], ['holds', 'release', '--all', '--reason', 'x'], ['holds', 'list', '--all'], ['autonomy', 'on', '--reason', 'x', '--scope', 'channel:whatsapp']]) {
      expect((await ctl(...argv)).code).not.toBe(0);
    }
    expect(await controlEvents()).toEqual([]);
  });

  it('fails closed when production cannot be positively established (nothing is read or mutated)', async () => {
    bed = await LiveOpsTestbed.start();
    const { R4_EXECUTION_MODE: _mode, ...undeclared } = bed.env;
    const cases: Record<string, string | undefined>[] = [
      undeclared,
      { ...bed.env, R4_EXECUTION_MODE: 'shadow' },
      { ...bed.env, R4_EXECUTION_MODE: 'prod' },
      { ...bed.env, R4_DATABASE_URL: undefined },
      { ...bed.env, R4_DATABASE_URL: 'sqlite://r4.db' },
      { ...bed.env, R4_PROD_POLICY_PROFILE: 'other-pack@1' },
      { ...bed.env, R4_PROD_ROLLOUT_PERCENT: undefined },
      { ...bed.env, R4_PROD_IDENTITY_HASH_KEY: 'short' },
    ];
    for (const env of cases) {
      const r = await control(env, 'autonomy', 'on', '--reason', 'must not apply');
      expect(r.code).toBe(1);
      expect(r.err).not.toContain(bed.db.url);
    }
    expect(await controlEvents()).toEqual([]);
  });

  it('refuses a database whose schema is not current (the Sales schema is pending) and a database it cannot reach', async () => {
    bed = await LiveOpsTestbed.start();
    const coreOnly = await createMigratedTestDatabase();
    try {
      const r = await control({ ...bed.env, R4_DATABASE_URL: coreOnly.url }, 'autonomy', 'on', '--reason', 'must not apply');
      expect(r).toMatchObject({ code: 1 });
      expect(r.err).toMatch(/schema_not_current/);
      const pool = openPool(coreOnly.url);
      expect((await pool.query("select autonomy_enabled from autonomy_controls where scope = 'global'")).rows).toEqual([{ autonomy_enabled: false }]);
      await pool.end();
    } finally {
      await coreOnly.drop();
    }
    const unreachable = await control({ ...bed.env, R4_DATABASE_URL: 'postgres://r4:secret-password@127.0.0.1:1/r4' }, 'autonomy', 'status');
    expect(unreachable.code).toBe(1);
    expect(unreachable.err).not.toContain('secret-password');
  });

  it('changing autonomy never releases a held task and never touches channel, rollout or delivery state', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [A] });
    await bed.customer(A, 'wamid.a.1', 'Hola');
    const taskId = await bed.taskOf(A);
    const before = await channelState();
    expect((await ctl('autonomy', 'on', '--reason', 'canary open')).code).toBe(0);
    expect((await ctl('autonomy', 'off', '--reason', 'drill')).code).toBe(0);
    expect((await ctl('autonomy', 'on', '--reason', 'drill over')).code).toBe(0);
    expect(await channelState()).toEqual(before);
    expect(await humansOf(taskId)).toEqual([expect.objectContaining({ kind: 'handoff', status: 'requested', payload: expect.objectContaining({ initiatedBy: 'platform', reason: 'autonomy_disabled' }) })]);
    expect(await bed.store.taskState(taskId)).toMatchObject({ status: 'blocked', humanOwned: true });
    const calls = bed.model.callCount;
    expect(await bed.runAgent()).toEqual([]);
    expect(bed.model.callCount).toBe(calls);
  });
});

describe('D-6 holds list', () => {
  it('lists only open platform holds caused by disabled autonomy', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [A, B, C] });
    // Autonomy disabled (migration default): A is held by the platform.
    await bed.customer(A, 'wamid.a.1', 'Hola');
    await bed.setAutonomy(true);
    // Rollout exclusion is a platform hold with another cause.
    await bed.customer(OUTSIDER, 'wamid.o.1', 'Hola');
    // B: the agent asks for a human. C: the agent consults a human.
    bed.next(handoff('The customer wants to talk to a person.'));
    await bed.customer(B, 'wamid.b.1', 'Quiero hablar con una persona');
    await bed.runAgent();
    bed.next(consult('Can we offer a discount?'));
    await bed.customer(C, 'wamid.c.1', '¿Descuento?');
    await bed.runAgent();
    const [taskA, taskB, taskC, taskO] = [await bed.taskOf(A), await bed.taskOf(B), await bed.taskOf(C), await bed.taskOf(OUTSIDER)];
    expect((await humansOf(taskB))[0]).toMatchObject({ kind: 'handoff', status: 'requested', payload: { initiatedBy: 'agent' } });
    expect((await humansOf(taskC))[0]).toMatchObject({ kind: 'consultation', status: 'requested' });
    expect((await humansOf(taskO))[0]).toMatchObject({ kind: 'handoff', payload: { initiatedBy: 'platform', reason: 'rollout_excluded' } });

    const r = await ctl('holds', 'list');
    expect(r.code).toBe(0);
    expect(r.json!.holds).toEqual([{ taskId: taskA, requestId: (await humansOf(taskA))[0]!.requestId, heldAt: expect.any(String), reason: 'autonomy_disabled', channel: 'whatsapp', taskStatus: 'blocked', autonomyEnabled: true }]);
    // No conversation content in the listing.
    expect(JSON.stringify(r.json)).not.toMatch(/Hola|persona|Descuento/);

    // A resolved hold no longer appears.
    expect((await ctl('holds', 'release', '--task', taskA, '--reason', 'autonomy restored')).code).toBe(0);
    expect((await ctl('holds', 'list')).json!.holds).toEqual([]);
  });

  it('an unrelated blocked task (operator takeover) does not appear', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [A], autonomy: true });
    bed.next(say('Hola'), waitInput());
    await bed.customer(A, 'wamid.a.1', 'Hola');
    await bed.runAgent();
    const taskId = await bed.taskOf(A);
    await bed.api.temporal.takeOver(taskId, { responseKey: 'take', note: 'Tomo yo.' }, OPERATOR);
    expect(await bed.store.taskState(taskId)).toMatchObject({ status: 'blocked' });
    expect((await ctl('holds', 'list')).json!.holds).toEqual([]);
  });
});

describe('D-6 holds release', () => {
  it('is refused while autonomy is still disabled; allowed once enabled; the task becomes claimable and nothing runs in the CLI', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [A] });
    await bed.customer(A, 'wamid.a.1', 'Hola');
    const taskId = await bed.taskOf(A);
    const [held] = await humansOf(taskId);

    const refused = await ctl('holds', 'release', '--task', taskId, '--reason', 'customer waiting');
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/autonomy_disabled/);
    expect(await humansOf(taskId)).toEqual([expect.objectContaining({ requestId: held!.requestId, status: 'requested' })]);

    expect((await ctl('autonomy', 'on', '--reason', 'incident closed')).code).toBe(0);
    const calls = bed.model.callCount;
    const released = await ctl('holds', 'release', '--task', taskId, '--reason', 'customer waiting since the incident');
    expect(released).toMatchObject({ code: 0, json: { released: { taskId, requestId: held!.requestId, status: 'cancelled' }, taskStatus: 'running' } });
    // Nothing executed or sent by the CLI.
    expect(bed.model.callCount).toBe(calls);
    expect(bed.provider.sends).toHaveLength(0);

    // Existing durable semantics: the platform handoff is cancelled, its WAIT_FOR_HUMAN completed, the task woken; attributed and reasoned.
    const inspected = await bed.api.temporal.inspect(taskId);
    expect(inspected.humans).toEqual([expect.objectContaining({ requestId: held!.requestId, status: 'cancelled', humanRef: null })]);
    expect(inspected.wait).toBeNull();
    expect(inspected.waits.at(-1)).toMatchObject({ kind: 'WAIT_FOR_HUMAN', status: 'completed', resolution: 'human', referenceId: held!.requestId });
    expect(inspected.ownership).toMatchObject({ owner: 'agent', blockedBy: [] });
    const event = inspected.events.find((e) => e.type === 'handoff.cancelled')!;
    expect(event).toMatchObject({ entityId: held!.requestId, actorRef: PRODUCTION_CONTROL_ACTOR, data: { outcome: 'platform_release', initiatedBy: 'platform', reason: 'autonomy_disabled', content: 'customer waiting since the incident' } });
    expect(event.correlationId).toMatch(/^production-control:/);
    expect(inspected.events.map((e) => e.type)).toContain('task.woken');

    // The normal worker owns execution.
    bed.next(say('¡Hola! Disculpa la espera.'), waitInput());
    expect(await bed.runAgent()).not.toEqual([]);
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual(['¡Hola! Disculpa la espera.']);
  });

  it('retrying the same release returns an intelligible refusal and changes nothing', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [A] });
    await bed.customer(A, 'wamid.a.1', 'Hola');
    const taskId = await bed.taskOf(A);
    await ctl('autonomy', 'on', '--reason', 'incident closed');
    expect((await ctl('holds', 'release', '--task', taskId, '--reason', 'first')).code).toBe(0);
    const before = await bed.api.temporal.inspect(taskId);
    const retry = await ctl('holds', 'release', '--task', taskId, '--reason', 'first');
    expect(retry.code).toBe(1);
    expect(retry.err).toMatch(/platform_hold_not_open/);
    expect(await bed.api.temporal.inspect(taskId)).toEqual(before);
  });

  it('MUST NOT release an agent-requested human handoff: refused, the HumanRequest stays open, the task stays human-waiting', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [B], autonomy: true });
    bed.next(handoff('The customer asked for a human.'));
    await bed.customer(B, 'wamid.b.1', 'Quiero hablar con una persona');
    await bed.runAgent();
    const taskId = await bed.taskOf(B);
    const before = await bed.api.temporal.inspect(taskId);
    expect(before.humans).toEqual([expect.objectContaining({ kind: 'handoff', status: 'requested', payload: expect.objectContaining({ initiatedBy: 'agent' }) })]);

    const r = await ctl('holds', 'release', '--task', taskId, '--reason', 'trying to force it');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/platform_hold_mismatch/);
    const after = await bed.api.temporal.inspect(taskId);
    expect(after).toEqual(before);
    expect(after.wait).toMatchObject({ kind: 'WAIT_FOR_HUMAN', status: 'waiting' });
    expect(await bed.store.taskState(taskId)).toMatchObject({ status: 'blocked', humanOwned: true });
  });

  it('refuses a consultation, another platform cause, a hold a human accepted, and unknown or malformed tasks', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [A, C], autonomy: true });
    bed.next(consult('Can we offer a discount?'));
    await bed.customer(C, 'wamid.c.1', '¿Descuento?');
    await bed.runAgent();
    await bed.customer(OUTSIDER, 'wamid.o.1', 'Hola');
    await bed.setAutonomy(false);
    await bed.customer(A, 'wamid.a.1', 'Hola');
    await bed.setAutonomy(true);
    const [taskA, taskC, taskO] = [await bed.taskOf(A), await bed.taskOf(C), await bed.taskOf(OUTSIDER)];
    // A human accepted A's platform hold: humans own it now.
    await bed.api.temporal.respondHuman((await humansOf(taskA))[0]!.requestId, { responseKey: 'accept', outcome: 'accept', content: 'Lo tomo.' }, OPERATOR);
    const snapshots = await Promise.all([taskA, taskC, taskO].map((t) => bed!.api.temporal.inspect(t)));

    expect((await ctl('holds', 'release', '--task', taskC, '--reason', 'x')).err).toMatch(/platform_hold_not_open/);
    expect((await ctl('holds', 'release', '--task', taskO, '--reason', 'x')).err).toMatch(/platform_hold_mismatch/);
    expect((await ctl('holds', 'release', '--task', taskA, '--reason', 'x')).err).toMatch(/handoff_owned_by_human/);
    expect((await ctl('holds', 'release', '--task', '00000000-0000-7000-8000-000000000000', '--reason', 'x'))).toMatchObject({ code: 1, err: expect.stringMatching(/task_not_found/) });
    expect((await ctl('holds', 'release', '--task', 'not-a-task', '--reason', 'x'))).toMatchObject({ code: 1, err: expect.stringMatching(/invalid_task_id/) });
    expect(await Promise.all([taskA, taskC, taskO].map((t) => bed!.api.temporal.inspect(t)))).toEqual(snapshots);
  });

  it('new inputs while held stay durable; after on + explicit release the next run compiles a fresh context with all of them', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [A], autonomy: true });
    bed.next(say('Hola, ¿qué bicicleta buscas?'), waitInput());
    await bed.customer(A, 'wamid.a.1', 'Hola');
    await bed.runAgent();
    await bed.deliver();
    const taskId = await bed.taskOf(A);
    const calls = bed.model.callCount;

    expect((await ctl('autonomy', 'off', '--reason', 'incident')).code).toBe(0);
    await bed.customer(A, 'wamid.a.2', 'input A: una de montaña');
    await bed.customer(A, 'wamid.a.3', 'input B: talla M');
    expect(await bed.runAgent()).toEqual([]);
    expect(bed.model.callCount).toBe(calls);
    expect((await bed.rows<{ n: number }>('select count(*)::int as n from task_inputs where task_id = $1', [taskId]))[0]!.n).toBe(3);

    expect((await ctl('autonomy', 'on', '--reason', 'incident closed')).code).toBe(0);
    expect(await bed.runAgent()).toEqual([]);
    expect((await ctl('holds', 'release', '--task', taskId, '--reason', 'resume after incident')).code).toBe(0);
    expect(bed.model.callCount).toBe(calls);

    bed.next(say('Perfecto: montaña, talla M.'), waitInput());
    await bed.runAgent();
    const context = JSON.stringify(bed.model.requests[calls]!.context);
    expect(context).toContain('input A: una de montaña');
    expect(context).toContain('input B: talla M');
    // The snapshot the new response came from evaluated every durable input (no stale snapshot replayed).
    const [snapshot] = await bed.rows<{ context_snapshot_id: string }>("select context_snapshot_id from agent_run_steps where task_id = $1 and decision_type = 'respond' order by created_at desc limit 1", [taskId]);
    expect(await bed.rows(`select i.input_id from task_inputs i where i.task_id = $1 and not exists (select 1 from context_snapshot_items c where c.snapshot_id = $2 and c.item_id = 'memory:' || i.memory_entry_id::text)`, [taskId, snapshot!.context_snapshot_id])).toEqual([]);
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual(['Hola, ¿qué bicicleta buscas?', 'Perfecto: montaña, talla M.']);
  });

  it('a stale pending agent response is never sent after release: stale-response protection stays authoritative', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [A], autonomy: true });
    bed.next(say('respuesta vieja'), waitInput());
    await bed.customer(A, 'wamid.a.1', 'Hola');
    await bed.runAgent();
    await bed.gateway.delivery.materialize();
    const taskId = await bed.taskOf(A);
    expect((await ctl('autonomy', 'off', '--reason', 'incident')).code).toBe(0);
    await bed.deliver();
    expect((await bed.store.outboundForTask(taskId))[0]).toMatchObject({ status: 'pending', holdReason: 'autonomy_disabled' });
    await bed.customer(A, 'wamid.a.2', 'mejor otra cosa');
    expect((await ctl('autonomy', 'on', '--reason', 'incident closed')).code).toBe(0);
    expect((await ctl('holds', 'release', '--task', taskId, '--reason', 'resume')).code).toBe(0);
    // The release itself dispatched nothing; the delivery gate then refuses the stale response.
    expect(bed.provider.sends).toHaveLength(0);
    await bed.deliver();
    expect(bed.provider.sends).toHaveLength(0);
    expect((await bed.store.outboundForTask(taskId))[0]).toMatchObject({ status: 'cancelled', cancelReason: 'superseded_by_newer_input' });
    bed.next(say('respuesta nueva'), waitInput());
    await bed.runAgent();
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual(['respuesta nueva']);
  });

  it('an unknown delivery is preserved: releasing the hold never retries it blindly', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [A], autonomy: true, providerTimeoutMs: 200 });
    bed.next(say('mensaje con timeout'), waitInput());
    await bed.customer(A, 'wamid.a.1', 'Hola');
    await bed.runAgent();
    bed.provider.script({ kind: 'hang', ms: 600 });
    await bed.deliver();
    const taskId = await bed.taskOf(A);
    const [unknown] = await bed.store.outboundForTask(taskId);
    expect(unknown).toMatchObject({ status: 'unknown', attempts: 1 });

    expect((await ctl('autonomy', 'off', '--reason', 'incident')).code).toBe(0);
    await bed.customer(A, 'wamid.a.2', '¿llegó?');
    expect((await ctl('autonomy', 'on', '--reason', 'incident closed')).code).toBe(0);
    expect((await ctl('holds', 'release', '--task', taskId, '--reason', 'resume')).code).toBe(0);
    for (let i = 0; i < 3; i += 1) await bed.deliver();
    expect(bed.provider.sends).toHaveLength(1);
    expect(await bed.store.outbound(unknown!.outboundId)).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(await bed.store.attempts(unknown!.outboundId)).toHaveLength(1);
    expect((await bed.api.production.attention()).production.unknownOutbound.map((o) => o.outboundId)).toEqual([unknown!.outboundId]);
  });

  it('serializes an administrative release, a new inbound, an outbound claim and a worker claim on the Task row', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [A], autonomy: true });
    bed.next(say('respuesta vieja'), waitInput());
    await bed.customer(A, 'wamid.a.1', 'Hola');
    await bed.runAgent();
    await bed.gateway.delivery.materialize();
    const taskId = await bed.taskOf(A);
    await ctl('autonomy', 'off', '--reason', 'incident');
    await bed.customer(A, 'wamid.a.2', 'input X');
    await ctl('autonomy', 'on', '--reason', 'incident closed');
    const worker = await bed.worker();
    const calls = bed.model.callCount;

    const blocker = await bed.pool.connect();
    await blocker.query('begin');
    await blocker.query('select task_id from agent_tasks where task_id = $1 for update', [taskId]);
    try {
      const release = ctl('holds', 'release', '--task', taskId, '--reason', 'resume');
      await waitForTaskLockWaiters(1);
      const inbound = bed.customer(A, 'wamid.a.3', 'input Y');
      await waitForTaskLockWaiters(2);
      const dispatch = bed.gateway.delivery.dispatchOnce();
      await waitForTaskLockWaiters(3);
      // The worker never waits on a locked task (SKIP LOCKED): it cannot run cognition now.
      expect((await worker.worker.runOnce()).kind).toBe('idle');
      await blocker.query('commit');
      const [released, received, dispatched] = await Promise.all([release, inbound, dispatch]);
      expect(released.code).toBe(0);
      expect(received).toMatchObject({ status: 200, body: { ingested: 1 } });
      expect(dispatched).toMatchObject({ kind: 'cancelled' });
    } catch (error) {
      await blocker.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }
    expect(bed.provider.sends).toHaveLength(0);
    expect(bed.model.callCount).toBe(calls);
    expect((await bed.rows<{ n: number }>('select count(*)::int as n from task_inputs where task_id = $1', [taskId]))[0]!.n).toBe(3);
    expect((await humansOf(taskId)).map((h) => h.status)).toEqual(['cancelled']);
    bed.next(say('respuesta nueva'), waitInput());
    await bed.runAgent();
    const context = JSON.stringify(bed.model.requests[calls]!.context);
    expect(context).toContain('input X');
    expect(context).toContain('input Y');
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual(['respuesta nueva']);
  });

  it('kill-switch state, the hold and the release are durable across independent processes (no in-memory state)', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [A] });
    await bed.customer(A, 'wamid.a.1', 'Hola');
    const taskId = await bed.taskOf(A);
    await ctl('autonomy', 'on', '--reason', 'open');
    await ctl('autonomy', 'off', '--reason', 'close again');
    // A second, freshly composed bed over the same database stands for a restarted deployment.
    const fresh = openPool(bed.db.url);
    try {
      const store = new PostgresProductionStore(fresh);
      expect((await store.readControls()).records.find((r) => r.scope === 'global')).toMatchObject({ autonomyEnabled: false, reason: 'close again', changedBy: PRODUCTION_CONTROL_ACTOR });
      expect((await ctl('holds', 'list')).json!.holds!.map((h: { taskId: string }) => h.taskId)).toEqual([taskId]);
      await ctl('autonomy', 'on', '--reason', 'reopen');
      await ctl('holds', 'release', '--task', taskId, '--reason', 'resume');
      expect(await store.taskState(taskId)).toMatchObject({ status: 'running', humanOwned: false });
      expect((await fresh.query("select status from human_requests where task_id = $1", [taskId])).rows).toEqual([{ status: 'cancelled' }]);
    } finally {
      await fresh.end();
    }
  });
});
