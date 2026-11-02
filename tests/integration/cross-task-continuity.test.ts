import { afterEach, describe, expect, it } from 'vitest';
import type { ModelRequest } from '@r4/model-gateway';
import { FixtureCatalog } from '@r4-adapters/domains';
import { LiveOpsTestbed, complete, keyOf, say, type QueuedStep } from '../support/live-ops.js';

/**
 * R4-J4-R7-4 — continuity across the tasks of one channel conversation.
 *
 * A terminal task is never revived: the next message opens a new task. These
 * tests prove what the new task's context holds about the earlier ones (the
 * scripted model only records what it was shown), never how a real model
 * uses it.
 */

const CUSTOMER = '56933334444';
const OTHER = '56933335555';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

const start = (options: { catalog?: boolean } = {}) =>
  (bed = LiveOpsTestbed.start({
    allowlist: [CUSTOMER, OTHER],
    autonomy: true,
    ...(options.catalog ? { env: { R4_PROD_POLICY_PROFILE: 'sales-production@2' }, catalog: Object.assign(new FixtureCatalog(), { bindingKind: 'real' }) } : {}),
  }).then((b) => (bed = b)));

/** The customer closes ("Ok, gracias") and the agent completes the task (the guard asks once, the agent confirms). */
async function closeTask(b: LiveOpsTestbed, from: string, id: string): Promise<void> {
  await b.customer(from, id, 'Ok, gracias');
  b.next(complete(), complete());
  await b.runAgent();
}

/** Runs the next model call recording the context it was shown. */
function shownBy(step: QueuedStep): { step: QueuedStep; seen: () => Record<string, unknown>[] } {
  let context: unknown;
  return {
    step: (request: ModelRequest) => ((context = request.context), typeof step === 'function' ? step(request) : step),
    seen: () => Object.values((context as { sections: Record<string, unknown[]> }).sections).flat() as Record<string, unknown>[],
  };
}

const priorTurns = (items: Record<string, unknown>[]) => items.filter((i) => String(i.itemId).startsWith('prior_turn:'));
const texts = (items: Record<string, unknown>[]) => items.map((i) => (i.content as { text: string }).text);
const tasksOf = (b: LiveOpsTestbed) => b.rows<{ task_id: string; status: string }>('select task_id, status from agent_tasks order by created_at');
const snapshotDecisions = async (b: LiveOpsTestbed, taskId: string) =>
  b.rows<{ item_id: string; decision: string; reason: string | null }>(
    'select i.item_id, i.decision, i.exclusion_reason as reason from context_snapshot_items i join context_snapshots s on s.snapshot_id = i.snapshot_id join agent_runs r on r.run_id = s.run_id where r.task_id = $1', [taskId]);

describe('cross-task continuity (R4-J4-R7-4)', () => {
  it('R74-1: after a task ends, the next message sees the earlier conversation — a product named then included — once, and only as conversation', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r74-1a', 'Hola, busco un banco regulable');
    b.next(say('Tenemos el banco regulable Atlas a $89.990.'));
    await b.runAgent();
    await b.deliver();
    await closeTask(b, CUSTOMER, 'wamid.r74-1b');
    const [first] = await tasksOf(b);
    expect(first!.status).toBe('completed');

    const shown = shownBy(say('Claro, el banco Atlas.'));
    await b.customer(CUSTOMER, 'wamid.r74-1c', 'Quiero el banco que me dijiste');
    b.next(shown.step);
    await b.runAgent();

    const tasks = await tasksOf(b);
    expect(tasks).toHaveLength(2);
    const second = tasks[1]!.task_id;
    const turns = priorTurns(shown.seen());
    expect(texts(turns)).toEqual(['Hola, busco un banco regulable', 'Tenemos el banco regulable Atlas a $89.990.', 'Ok, gracias']);
    expect(turns.every((t) => t.authority === 'CONVERSATIONAL' && t.kind === 'conversation_turn')).toBe(true);
    expect(shown.seen().find((i) => i.itemId === `prior_conversation:${second}`)).toMatchObject({ authority: 'OBSERVED', content: { earlierTasks: 1, turnsShown: 3, earlierTurnsOmitted: false } });
    // The new message is the new task's own input, exactly once; the earlier ones stay in the earlier task.
    const inputs = await b.rows<{ task_id: string }>('select task_id from task_inputs order by received_at');
    expect(inputs.map((i) => i.task_id)).toEqual([first!.task_id, first!.task_id, second]);
    expect(texts(shown.seen().filter((i) => String(i.itemId).startsWith('memory:')))).toEqual(['Quiero el banco que me dijiste']);
    // The tasks stay separate: no lineage through the Task Runtime's parent (a sub-task relation of live tasks).
    expect((await b.rows('select parent_task_id from agent_tasks where parent_task_id is not null'))).toEqual([]);
  });

  it('R74-2: across several ended tasks, the turns keep their order; another conversation never enters', async () => {
    const b = await start();
    await b.customer(OTHER, 'wamid.r74-2x', 'Mi pedido secreto de otro cliente');
    b.next(say('Anotado.'));
    await b.runAgent();
    await closeTask(b, OTHER, 'wamid.r74-2y');

    await b.customer(CUSTOMER, 'wamid.r74-2a', 'Busco discos de 20 kg');
    b.next(say('Tenemos discos de 20 kg.'));
    await b.runAgent();
    await closeTask(b, CUSTOMER, 'wamid.r74-2b');
    await b.customer(CUSTOMER, 'wamid.r74-2c', '¿Y barras olímpicas?');
    b.next(say('También tenemos barras olímpicas.'));
    await b.runAgent();
    await closeTask(b, CUSTOMER, 'wamid.r74-2d');

    const shown = shownBy(say('Sí.'));
    await b.customer(CUSTOMER, 'wamid.r74-2e', 'Quiero los discos y la barra');
    b.next(shown.step);
    await b.runAgent();
    expect(texts(priorTurns(shown.seen()))).toEqual(['Busco discos de 20 kg', 'Tenemos discos de 20 kg.', 'Ok, gracias', '¿Y barras olímpicas?', 'También tenemos barras olímpicas.', 'Ok, gracias']);
    expect(JSON.stringify(shown.seen())).not.toContain('secreto');
  });

  it('R74-3: nothing an earlier task observed or was authorized for is evidence for the new one', async () => {
    const b = await start({ catalog: true });
    await b.customer(CUSTOMER, 'wamid.r74-3a', 'Busco discos');
    b.next({ type: 'structured', data: { type: 'read_capability', capabilityId: 'catalog.search', arguments: { query: 'disco' } } }, say('Tenemos discos.'));
    await b.runAgent();
    await closeTask(b, CUSTOMER, 'wamid.r74-3b');
    const [earlier] = await tasksOf(b);
    const [observation] = await b.rows<{ observation_id: string }>('select observation_id from observations where task_id = $1', [earlier!.task_id]);
    expect(observation).toBeDefined();

    const shown = shownBy({ type: 'structured', data: { type: 'propose_action', capabilityId: 'sales.workspace.update', arguments: { operations: [{ op: 'record_fact', key: 'budget', value: 300000, statedBy: 'customer' }] }, evidenceRefs: [observation!.observation_id] } });
    await b.customer(CUSTOMER, 'wamid.r74-3c', 'Quiero los discos de antes');
    b.next(shown.step, say('Déjame revisar de nuevo el catálogo.'));
    await b.runAgent();
    const current = (await tasksOf(b))[1]!.task_id;
    // Not in the context: no observation, receipt, approval or human request of the earlier task.
    expect(shown.seen().filter((i) => /^(observation|human_request|human_response|sales_workspace):/.test(String(i.itemId)) && JSON.stringify(i).includes(earlier!.task_id))).toEqual([]);
    expect(JSON.stringify(shown.seen())).not.toContain(observation!.observation_id);
    // Not citable: the proposal that cites it is an invalid decision (ADR-028 recovers the run), and no action exists.
    const steps = await b.rows<{ outcome: string; error_code: string | null }>('select outcome, error_code from agent_run_steps where task_id = $1 order by created_at', [current]);
    expect(steps[0]).toEqual({ outcome: 'invalid', error_code: 'unknown_evidence' });
    expect(await b.rows('select 1 from action_proposals where task_id = $1', [current])).toEqual([]);
  });

  it('R74-4: building the context re-runs nothing: no earlier response is re-sent and no capability is called again', async () => {
    const b = await start({ catalog: true });
    await b.customer(CUSTOMER, 'wamid.r74-4a', 'Busco discos');
    b.next({ type: 'structured', data: { type: 'read_capability', capabilityId: 'catalog.search', arguments: { query: 'disco' } } }, say('Tenemos discos.'));
    await b.runAgent();
    await b.deliver();
    await closeTask(b, CUSTOMER, 'wamid.r74-4b');
    const [earlier] = await tasksOf(b);
    const before = await b.rows('select (select count(*) from outbound_messages where task_id = $1)::int as outbound, (select count(*) from observations where task_id = $1)::int as observations, (select count(*) from agent_run_steps where task_id = $1)::int as steps', [earlier!.task_id]);

    await b.customer(CUSTOMER, 'wamid.r74-4c', 'Hola otra vez');
    b.next(say('Hola.'));
    await b.runAgent();
    await b.deliver();
    const current = (await tasksOf(b))[1]!.task_id;
    expect(await b.rows('select (select count(*) from outbound_messages where task_id = $1)::int as outbound, (select count(*) from observations where task_id = $1)::int as observations, (select count(*) from agent_run_steps where task_id = $1)::int as steps', [earlier!.task_id])).toEqual(before);
    expect(await b.rows<{ n: number }>('select count(*)::int as n from observations where task_id = $1', [current])).toEqual([{ n: 0 }]);
    expect(await b.rows<{ origin: string }>('select origin from outbound_messages where task_id = $1', [current])).toEqual([{ origin: 'agent' }]);
    expect(b.provider.sends.length).toBe(2);
  });

  it('R74-5: a restart does not lose the continuity: another worker compiles the same earlier conversation', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r74-5a', 'Busco un banco regulable');
    b.next(say('Tenemos el banco Atlas.'));
    await b.runAgent();
    await closeTask(b, CUSTOMER, 'wamid.r74-5b');

    const before = shownBy(say('Hola.'));
    await b.customer(CUSTOMER, 'wamid.r74-5c', 'Hola');
    b.next(before.step);
    await b.runAgent();
    await (await b.worker('worker-1')).close();

    const restarted = await b.worker('worker-2');
    const after = shownBy(say('El banco Atlas, claro.'));
    await b.customer(CUSTOMER, 'wamid.r74-5d', '¿Me recuerdas el banco?');
    b.next(after.step);
    for (let i = 0; i < 10 && (await restarted.worker.runOnce()).kind !== 'idle'; i += 1);
    expect(priorTurns(after.seen())).toEqual(priorTurns(before.seen()));
    expect(texts(priorTurns(after.seen()))).toEqual(['Busco un banco regulable', 'Tenemos el banco Atlas.', 'Ok, gracias']);
  });

  // The bed dates customer messages ~10 minutes in the past (provider timestamps), so "newest" is decided by createdAt, as the compiler does.
  it('R74-6: the earlier conversation competes for the conversation budget like any turn; its framing episode is never dropped', async () => {
    const b = await start();
    await b.worker('worker-1', { context: { budget: { mode: 'unbounded' }, kindLimits: { conversation_turn: { maxItems: 2 } } } });
    await b.customer(CUSTOMER, 'wamid.r74-6a', 'Busco un banco regulable');
    b.next(say('Tenemos el banco Atlas.'));
    await b.runAgent();
    await closeTask(b, CUSTOMER, 'wamid.r74-6b');

    await b.customer(CUSTOMER, 'wamid.r74-6c', 'Quiero el banco');
    b.next(say('Claro.'));
    await b.runAgent();
    const current = (await tasksOf(b))[1]!.task_id;
    const decisions = await snapshotDecisions(b, current);
    const turns = decisions.filter((d) => /^(prior_turn|memory):/.test(d.item_id));
    expect(turns).toHaveLength(4);
    expect(turns.filter((d) => d.decision === 'included')).toHaveLength(2);
    expect(turns.filter((d) => d.decision === 'excluded').map((d) => d.reason)).toEqual(['policy', 'policy']);
    expect(decisions.find((d) => d.item_id === `prior_conversation:${current}`)?.decision).toBe('included');
  });

  it('R74-7: nothing is invented — a first conversation has no earlier context, and an earlier reply never sent is shown as not sent', async () => {
    const b = await start();
    const first = shownBy(say('Tenemos el banco Atlas.'));
    await b.customer(CUSTOMER, 'wamid.r74-7a', 'Busco un banco regulable');
    b.next(first.step);
    await b.runAgent();
    expect(first.seen().filter((i) => /^prior_(turn|conversation):/.test(String(i.itemId)))).toEqual([]);
    // No delivery pass: the reply is still pending when the task ends.
    await closeTask(b, CUSTOMER, 'wamid.r74-7b');

    const shown = shownBy(say('Hola.'));
    await b.customer(CUSTOMER, 'wamid.r74-7c', 'Hola');
    b.next(shown.step);
    await b.runAgent();
    const reply = priorTurns(shown.seen()).find((t) => (t.content as { text: string }).text === 'Tenemos el banco Atlas.')!;
    expect(reply.content).toMatchObject({ actor: { role: 'agent' }, earlierTask: true, delivery: 'not sent' });
    expect(keyOf(CUSTOMER)).not.toBe(keyOf(OTHER));
  });
});
