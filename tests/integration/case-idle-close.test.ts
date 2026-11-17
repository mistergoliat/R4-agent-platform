import { afterEach, describe, expect, it } from 'vitest';
import type { FakeModelStep, ModelRequest } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { CASE_IDLE_CLOSE_ACTOR, CaseIdleCloser, type ProductionStore } from '@r4/live-ops';
import { LiveOpsTestbed, OPERATOR, say, type QueuedStep } from '../support/live-ops.js';
import { freezeTemporalClock } from '../support/temporal.js';

/**
 * Case idle close: a conversation task waiting for the contact closes after R4_PROD_CASE_IDLE_CLOSE_HOURS without a
 * contact message; the next message opens a new case that sees the earlier turns. Real production composition over
 * PostgreSQL (webhook, Sales worker, scripted model, delivery, local WhatsApp). Temporal time is moved by redefining
 * `r4_now()` (the clock of task inputs and of the idle rule), so no test waits a day.
 */
const CUSTOMER = '56944445555';
const HOURS = 24;
const DAY = HOURS * 3_600_000;
const CONSULT: FakeModelStep = { type: 'structured', data: { type: 'request_consultation', question: '¿Hay despacho a regiones?', contextRefs: [] } };
const HANDOFF: FakeModelStep = { type: 'structured', data: { type: 'request_handoff', summary: 'El cliente pide hablar con una persona.', contextRefs: [] } };

let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

const start = async (idle = true) => (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, ...(idle ? { env: { R4_PROD_CASE_IDLE_CLOSE_HOURS: String(HOURS) } } : {}) }));

/** Temporal time `ms` after the newest input of the bed (inputs are received on the temporal clock). */
async function idleFor(b: LiveOpsTestbed, ms: number): Promise<void> {
  const [row] = await b.rows<{ at: Date }>('select max(received_at) as at from task_inputs');
  await freezeTemporalClock(b.pool, new Date(row!.at.getTime() + ms));
}

/** One answered message: the agent replies, the reply is delivered, the task waits for the contact. */
async function answered(b: LiveOpsTestbed, id: string, text: string, reply: string): Promise<string> {
  b.next(say(reply));
  await b.customer(CUSTOMER, id, text);
  await b.runAgent();
  await b.deliver();
  return b.taskOf(CUSTOMER);
}

const sweep = (b: LiveOpsTestbed) => b.gateway.idleClose!.sweep();
const closer = (b: LiveOpsTestbed, store: ProductionStore = b.store) => new CaseIdleCloser({ store, temporal: b.api.temporal, channel: 'whatsapp', idleForMs: DAY, logger: createSilentLogger() });
const taskRow = async (b: LiveOpsTestbed, taskId: string) => (await b.rows<{ status: string; status_reason: string | null }>('select status, status_reason from agent_tasks where task_id = $1', [taskId]))[0]!;
const bindings = (b: LiveOpsTestbed) => b.rows<{ task_id: string; status: string; closed_reason: string | null }>('select task_id, status, closed_reason from channel_conversation_bindings order by created_at');
const inputsOf = async (b: LiveOpsTestbed, taskId: string) => (await b.rows<{ n: number }>('select count(*)::int as n from task_inputs where task_id = $1', [taskId]))[0]!.n;

/** A store whose candidate selection lets `meanwhile` happen between the selection and the close. */
function racing(store: ProductionStore, meanwhile: () => Promise<unknown>): ProductionStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'idleConversations') {
        return async (command: Parameters<ProductionStore['idleConversations']>[0]) => {
          const selected = await target.idleConversations(command);
          await meanwhile();
          return selected;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function shownBy(step: QueuedStep): { step: QueuedStep; seen: () => Record<string, unknown>[] } {
  let context: unknown;
  return {
    step: (request: ModelRequest) => ((context = request.context), typeof step === 'function' ? step(request) : step),
    seen: () => Object.values((context as { sections: Record<string, unknown[]> }).sections).flat() as Record<string, unknown>[],
  };
}
const texts = (items: Record<string, unknown>[]) => items.map((i) => (i.content as { text: string }).text);

describe('case idle close (R4_PROD_CASE_IDLE_CLOSE_HOURS)', { timeout: 90_000 }, () => {
  it('is off by default: nothing is composed, and an idle task stays open', async () => {
    const b = await start(false);
    const taskId = await answered(b, 'wamid.off-1', 'Hola', 'Hola, ¿en qué te ayudo?');
    expect(b.gateway.idleClose).toBeNull();
    const ready = await b.gateway.app.inject({ method: 'GET', url: '/ready' });
    expect(ready.json<{ checks: { caseIdleCloseHours: unknown } }>().checks.caseIdleCloseHours).toBeNull();
    await idleFor(b, 30 * DAY);
    expect((await taskRow(b, taskId)).status).toBe('waiting');
    expect((await bindings(b)).map((r) => r.status)).toEqual(['open']);
  });

  it('closes after the threshold, not before: the task ends idle_timeout, the binding closes idle_timeout, an event is audited and nothing is sent', async () => {
    const b = await start();
    const taskId = await answered(b, 'wamid.1', 'Busco un banco regulable', 'Tenemos el banco Atlas.');
    expect((await taskRow(b, taskId)).status).toBe('waiting');
    const sends = b.provider.sends.length;
    const outbound = await b.rows('select outbound_id from outbound_messages');

    expect(await sweep(b)).toEqual({ closed: 0, notIdle: 0 });
    await idleFor(b, DAY - 60_000);
    expect(await sweep(b)).toEqual({ closed: 0, notIdle: 0 });
    expect((await taskRow(b, taskId)).status).toBe('waiting');

    await idleFor(b, DAY);
    // Each gateway closes only its own channel's cases.
    expect(await new CaseIdleCloser({ store: b.store, temporal: b.api.temporal, channel: 'web', idleForMs: DAY, logger: createSilentLogger() }).sweep()).toEqual({ closed: 0, notIdle: 0 });
    expect(await sweep(b)).toEqual({ closed: 1, notIdle: 0 });
    expect(await taskRow(b, taskId)).toEqual({ status: 'cancelled', status_reason: 'idle_timeout' });
    expect(await bindings(b)).toEqual([{ task_id: taskId, status: 'closed', closed_reason: 'idle_timeout' }]);
    const events = await b.rows<{ actor_ref: string; data: Record<string, unknown> }>(`select actor_ref, data from temporal_events where task_id = $1 and event_type = 'task.cancelled'`, [taskId]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_ref: CASE_IDLE_CLOSE_ACTOR, data: { initiatedBy: 'platform', reason: 'idle_timeout', idleForMs: DAY } });
    // The operator thread shows the closing; the contact receives nothing.
    expect((await b.store.thread(taskId)).filter((e) => e.kind === 'event').map((e) => e.refs)).toContainEqual(expect.objectContaining({ type: 'task.cancelled', reason: 'idle_timeout' }));
    await b.deliver();
    expect(b.provider.sends.length).toBe(sends);
    expect(await b.rows('select outbound_id from outbound_messages')).toEqual(outbound);

    // A second run is a no-op.
    expect(await sweep(b)).toEqual({ closed: 0, notIdle: 0 });
    expect(await b.rows(`select 1 from temporal_events where task_id = $1 and event_type = 'task.cancelled'`, [taskId])).toHaveLength(1);
  });

  it('the next message opens a new binding and task whose context holds the earlier turns', async () => {
    const b = await start();
    const first = await answered(b, 'wamid.n1', 'Busco un banco regulable', 'Tenemos el banco Atlas a $89.990.');
    await idleFor(b, DAY);
    expect((await sweep(b)).closed).toBe(1);

    const shown = shownBy(say('Claro, el banco Atlas.'));
    b.next(shown.step);
    await b.customer(CUSTOMER, 'wamid.n2', 'Quiero el banco que me dijiste');
    await b.runAgent();
    const second = await b.taskOf(CUSTOMER);
    expect(second).not.toBe(first);
    expect((await bindings(b)).map((r) => [r.task_id, r.status, r.closed_reason])).toEqual([[first, 'closed', 'idle_timeout'], [second, 'open', null]]);
    expect(await inputsOf(b, first)).toBe(1);
    expect(await inputsOf(b, second)).toBe(1);
    const prior = shown.seen().filter((i) => String(i.itemId).startsWith('prior_turn:'));
    expect(texts(prior)).toEqual(['Busco un banco regulable', 'Tenemos el banco Atlas a $89.990.']);
    expect(shown.seen().find((i) => i.itemId === `prior_conversation:${second}`)).toMatchObject({ content: { earlierTasks: 1 } });
  });

  it('never closes a task with an outbound pending, dispatching or unknown; closes once it settles', async () => {
    const b = await start();
    b.next(say('Te respondo enseguida.'));
    await b.customer(CUSTOMER, 'wamid.o1', 'Hola');
    await b.runAgent();
    const taskId = await b.taskOf(CUSTOMER);
    await b.store.materializeResponses({ limit: 10 });
    await idleFor(b, 2 * DAY);
    expect(await b.rows('select status from outbound_messages')).toEqual([{ status: 'pending' }]);
    expect(await sweep(b)).toEqual({ closed: 0, notIdle: 0 });
    for (const status of ['dispatching', 'unknown']) {
      await b.pool.query(`update outbound_messages set status = $1, lease_owner = case when $1 = 'dispatching' then 'x' end, lease_expires_at = case when $1 = 'dispatching' then clock_timestamp() end`, [status]);
      expect(await sweep(b)).toEqual({ closed: 0, notIdle: 0 });
    }
    expect((await taskRow(b, taskId)).status).toBe('waiting');
    await b.pool.query(`update outbound_messages set status = 'accepted', lease_owner = null, lease_expires_at = null`);
    expect(await sweep(b)).toEqual({ closed: 1, notIdle: 0 });
  });

  it.each([
    ['a pending consultation', CONSULT],
    ['a requested handoff', HANDOFF],
  ])('never closes a task with %s', async (_label, step) => {
    const b = await start();
    b.next(step);
    await b.customer(CUSTOMER, 'wamid.h1', 'Necesito ayuda');
    await b.runAgent();
    await b.deliver();
    const taskId = await b.taskOf(CUSTOMER);
    await idleFor(b, 2 * DAY);
    expect(await sweep(b)).toEqual({ closed: 0, notIdle: 0 });
    expect((await taskRow(b, taskId)).status).not.toBe('cancelled');
    expect((await bindings(b))[0]!.status).toBe('open');
  });

  it('never closes a task an operator took over (active handoff): it stays with the operators', async () => {
    const b = await start();
    const taskId = await answered(b, 'wamid.t1', 'Hola', 'Hola, ¿en qué te ayudo?');
    await b.api.temporal.takeOver(taskId, { responseKey: 'takeover-1', note: 'Un ejecutivo toma la conversación.' }, OPERATOR);
    await idleFor(b, 2 * DAY);
    expect(await sweep(b)).toEqual({ closed: 0, notIdle: 0 });
    expect(await taskRow(b, taskId)).toMatchObject({ status: 'blocked', status_reason: 'human_handoff' });
  });

  it('a message arriving after the selection reaches the old task, which is not closed', async () => {
    const b = await start();
    const taskId = await answered(b, 'wamid.r1', 'Hola', 'Hola, ¿en qué te ayudo?');
    await idleFor(b, 2 * DAY);
    const store = racing(b.store, () => b.customer(CUSTOMER, 'wamid.r2', 'Sigo aquí'));
    expect(await closer(b, store).sweep()).toEqual({ closed: 0, notIdle: 1 });
    expect((await taskRow(b, taskId)).status).toBe('running');
    expect(await inputsOf(b, taskId)).toBe(2);
    expect((await bindings(b)).map((r) => r.status)).toEqual(['open']);
    b.next(say('¡Hola de nuevo!'));
    await b.runAgent();
    await b.deliver();
    expect(b.provider.sends.at(-1)!.text).toBe('¡Hola de nuevo!');
  });

  it('a message arriving after the close opens the new case — also when the binding was not closed yet (a crash in between)', async () => {
    const b = await start();
    const first = await answered(b, 'wamid.c1', 'Hola', 'Hola, ¿en qué te ayudo?');
    await idleFor(b, 2 * DAY);
    // The process dies between closing the task and closing its binding.
    const crashing = new Proxy(b.store, {
      get(target, property) {
        if (property === 'closeBinding') return () => Promise.reject(new Error('crash'));
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(closer(b, crashing).sweep()).rejects.toThrow('crash');
    expect(await taskRow(b, first)).toEqual({ status: 'cancelled', status_reason: 'idle_timeout' });
    expect((await bindings(b))[0]!.status).toBe('open');

    b.next(say('Hola otra vez.'));
    await b.customer(CUSTOMER, 'wamid.c2', 'Hola otra vez');
    await b.runAgent();
    const second = await b.taskOf(CUSTOMER);
    expect(second).not.toBe(first);
    expect(await inputsOf(b, first)).toBe(1);
    expect(await inputsOf(b, second)).toBe(1);
    // Whoever closes the binding first, the reason is the idle close.
    expect((await bindings(b)).map((r) => [r.task_id, r.status, r.closed_reason])).toEqual([[first, 'closed', 'idle_timeout'], [second, 'open', null]]);
  });

  it('a crash between the task and the binding is finished by the next sweep', async () => {
    const b = await start();
    const taskId = await answered(b, 'wamid.k1', 'Hola', 'Hola, ¿en qué te ayudo?');
    await idleFor(b, 2 * DAY);
    const crashing = new Proxy(b.store, {
      get(target, property) {
        if (property === 'closeBinding') return () => Promise.reject(new Error('crash'));
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(closer(b, crashing).sweep()).rejects.toThrow('crash');
    expect(await closer(b).sweep()).toEqual({ closed: 1, notIdle: 0 });
    expect(await bindings(b)).toEqual([{ task_id: taskId, status: 'closed', closed_reason: 'idle_timeout' }]);
    expect(await b.rows(`select 1 from temporal_events where task_id = $1 and event_type = 'task.cancelled'`, [taskId])).toHaveLength(1);
  });

  it('two sweeps at once close the case exactly once', async () => {
    const b = await start();
    const taskId = await answered(b, 'wamid.d1', 'Hola', 'Hola, ¿en qué te ayudo?');
    await idleFor(b, 2 * DAY);
    const results = await Promise.all([closer(b).sweep(), closer(b).sweep(), sweep(b)]);
    expect(results.reduce((n, r) => n + r.notIdle, 0)).toBe(0);
    expect(await taskRow(b, taskId)).toEqual({ status: 'cancelled', status_reason: 'idle_timeout' });
    expect(await b.rows(`select 1 from temporal_events where task_id = $1 and event_type = 'task.cancelled'`, [taskId])).toHaveLength(1);
    expect(await bindings(b)).toEqual([{ task_id: taskId, status: 'closed', closed_reason: 'idle_timeout' }]);
  });

  it('a message racing the sweep is never lost: it is an input of a live task, old or new', async () => {
    for (let round = 0; round < 3; round += 1) {
      const b = await start();
      await answered(b, `wamid.x${round}a`, 'Hola', 'Hola, ¿en qué te ayudo?');
      await idleFor(b, 2 * DAY);
      await Promise.all([sweep(b), b.customer(CUSTOMER, `wamid.x${round}b`, '¿Siguen ahí?')]);
      const [input] = await b.rows<{ status: string }>(
        `select t.status from task_inputs i join agent_tasks t on t.task_id = i.task_id join inbound_events e on e.input_id = i.input_id where e.provider_event_id = $1`, [`wamid.x${round}b`]);
      expect(input?.status).not.toBe('cancelled');
      expect(['running', 'pending']).toContain(input?.status);
      expect((await bindings(b)).filter((r) => r.status === 'open')).toHaveLength(1);
      await bed!.close();
      bed = null;
    }
  });
});
