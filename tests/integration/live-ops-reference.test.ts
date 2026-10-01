import { afterEach, describe, expect, it } from 'vitest';
import { PostgresTrajectoryReader } from '@r4/evaluator';
import { PostgresSalesStore } from '@r4-sales/agent';
import { SCRIPTED_MODEL_PROFILE, evaluateSalesSubject, salesWorkspaceProjection } from '@r4-sales/agent/evaluations';
import { LiveOpsTestbed, OPERATOR, say } from '../support/live-ops.js';

/**
 * R4-I reference paths (offline, real PostgreSQL, real runtime, local fake
 * provider): the full production path, ADR-028 recovery after a delivered
 * response, handoff with inbound, kill switch, rollout exclusion.
 */
const CUSTOMER = '56911112222';
const OTHER_CUSTOMER = '56911112223';
let bed: LiveOpsTestbed | null = null;

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

afterEach(async () => {
  await bed?.close();
  bed = null;
});

describe('reference path: provider inbound → Task → respond → durable outbound → accepted → delivered → evaluation', () => {
  it('runs end to end with every state durable and correlated', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    bed.next(say('¡Hola! Soy el asistente de ventas. ¿Qué estás buscando?'));

    expect(await bed.customer(CUSTOMER, 'wamid.in.1', 'Hola, quiero una bicicleta estática')).toMatchObject({ status: 200, body: { ingested: 1 } });
    const taskId = await bed.taskOf(CUSTOMER);
    // Webhook did no cognition: the model was not called inside the request.
    expect(bed.model.callCount).toBe(0);

    await bed.runAgent();
    expect(bed.model.callCount).toBe(1); // R4-J1E-R2.2: the reply ends the turn (no model call for a wait)
    // respond ≠ delivered: before the delivery owner acts, nothing is sent.
    expect(bed.provider.sends).toHaveLength(0);
    const pass = await bed.deliver();
    expect(pass.materialized).toBe(1);
    expect(bed.provider.sends).toHaveLength(1);
    expect(bed.provider.sends[0]).toMatchObject({ to: CUSTOMER, text: '¡Hola! Soy el asistente de ventas. ¿Qué estás buscando?' });
    const [outbound] = await bed.store.outboundForTask(taskId);
    expect(outbound).toMatchObject({ status: 'accepted', origin: 'agent', attempts: 1, providerMessageId: bed.provider.sends[0]!.providerMessageId });

    // Provider evidence: sent (already accepted: ignored), delivered, read.
    const wamid = outbound!.providerMessageId!;
    await bed.status([{ id: wamid, status: 'sent', recipientId: CUSTOMER }, { id: wamid, status: 'delivered', recipientId: CUSTOMER }, { id: wamid, status: 'read', recipientId: CUSTOMER }]);
    expect((await bed.store.outbound(outbound!.outboundId))!.status).toBe('read');

    // Correlation: provider inbound id → input → task → run → response step → outbound → provider outbound id.
    const [inbound] = await bed.rows<{ provider_event_id: string; task_id: string; input_id: string; content: string | null; conversation_ref: string | null }>('select * from inbound_events');
    expect(inbound).toMatchObject({ provider_event_id: 'wamid.in.1', task_id: taskId, content: null, conversation_ref: null });
    const [step] = await bed.rows<{ step_id: string; run_id: string }>(`select step_id, run_id from agent_run_steps where task_id = $1 and decision_type = 'respond'`, [taskId]);
    expect(outbound).toMatchObject({ responseStepId: step!.step_id, runId: step!.run_id, idempotencyKey: `r4-out:${step!.step_id}` });
    expect(await bed.rows(`select conname from pg_constraint where conrelid = 'outbound_messages'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (response_step_id)'`)).toHaveLength(1);
    await bed.gateway.delivery.materialize();
    await bed.gateway.delivery.materialize();
    expect(await bed.store.outboundForTask(taskId)).toHaveLength(1);

    // Operator view (API): the thread shows the customer turn and the agent turn with its delivery state.
    const thread = await bed.api.production.thread(taskId);
    expect(thread.entries.map((e) => [e.kind, e.delivery?.status ?? null])).toEqual([['contact', null], ['agent', 'read']]);
    const after = await bed.api.production.thread(taskId, thread.cursor!);
    expect(after.entries).toEqual([]);

    // R4-G post-hoc evaluation over the same durable truth (Quality never enters the loop).
    const reader = new PostgresTrajectoryReader(bed.pool, { projections: [salesWorkspaceProjection(new PostgresSalesStore(bed.pool))] });
    const subject = await reader.subject(taskId, { sourceRef: 'production:reference' });
    const { run } = await evaluateSalesSubject(subject, { judge: null, modelUnderTest: SCRIPTED_MODEL_PROFILE, repro: { gitSha: 'unknown' } });
    expect(run.result.outcome.technical).toMatchObject({ status: 'awaiting_input', valid: true });
    expect(run.result.outcome.governance.status).toBe('no_violations');

    const metrics = await bed.store.metrics();
    expect(metrics).toMatchObject({ inbound_received: 1, task_created: 1, outbound_created: 1, outbound_dispatch_attempted: 1, outbound_accepted: 1, outbound_delivered: 1, outbound_read: 1, outbound_unknown: 0, model_calls: 1 });
  });
});

/**
 * A second agent response on the SAME inbound frontier (no new customer input). Since R4-J1E-R2.2 a
 * reply ends its turn, so a run can no longer fail after replying and replay it on recovery; the real
 * path left is a human takeover released without new input: the resumed run answers the same input again.
 */
async function replayOnSameFrontier(taskId: string, text: string): Promise<void> {
  const handoff = await bed!.api.temporal.takeOver(taskId, { responseKey: `take-${text}`, note: 'Reviso y devuelvo.' }, OPERATOR);
  await bed!.api.temporal.respondHuman(handoff.requestId, { responseKey: `release-${text}`, outcome: 'release', content: 'Devuelvo la conversación al agente.' }, OPERATOR);
  bed!.next(say(text));
  await bed!.runAgent();
}

describe('causal outbound deduplication', () => {
  it('suppresses a replayed response for the same inbound frontier', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    bed.next(say('Perfecto.'));
    await bed.customer(CUSTOMER, 'wamid.in.1', '¿Puedo pagar con transferencia?');
    const taskId = await bed.taskOf(CUSTOMER);
    await bed.runAgent();
    await bed.deliver();
    await replayOnSameFrontier(taskId, 'Perfecto.');

    const steps = await bed.rows<{ step_id: string; context_snapshot_id: string | null }>(`select step_id, context_snapshot_id from agent_run_steps where task_id = $1 and decision_type = 'respond' and outcome = 'recorded'`, [taskId]);
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.context_snapshot_id !== null)).toBe(true);

    const duplicate = await bed.gateway.delivery.materialize();
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]).toMatchObject({ status: 'cancelled', cancelReason: 'duplicate_content' });
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual(['Perfecto.']);
    expect(await bed.store.outboundForTask(taskId)).toHaveLength(2);
  });

  it('allows identical text on a later customer turn in the same Task', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    bed.next(say('Sí, claro.'));
    await bed.customer(CUSTOMER, 'wamid.in.1', '¿Puedo pagar con transferencia?');
    const taskId = await bed.taskOf(CUSTOMER);
    await bed.runAgent();
    await bed.deliver();
    const first = (await bed.store.outboundForTask(taskId))[0]!;
    await bed.status([{ id: first.providerMessageId!, status: 'delivered', recipientId: CUSTOMER }]);

    bed.next(say('Sí, claro.'));
    await bed.customer(CUSTOMER, 'wamid.in.2', '¿También puedo transferir esta otra cotización?');
    await bed.runAgent();
    await bed.deliver();

    const outbound = await bed.store.outboundForTask(taskId);
    expect(outbound.map((o) => [o.status, o.cancelReason])).toEqual([['delivered', null], ['accepted', null]]);
    expect(bed.provider.sends.map((s) => s.text)).toEqual(['Sí, claro.', 'Sí, claro.']);
  });

  it('allows identical text in different Tasks', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER, OTHER_CUSTOMER], autonomy: true });
    bed.next(say('Perfecto.'), say('Perfecto.'));
    await bed.customer(CUSTOMER, 'wamid.a.1', 'Hola');
    await bed.customer(OTHER_CUSTOMER, 'wamid.b.1', 'Hola');
    await bed.runAgent();
    await bed.deliver();

    const firstTask = await bed.taskOf(CUSTOMER);
    const secondTask = await bed.taskOf(OTHER_CUSTOMER);
    expect(firstTask).not.toBe(secondTask);
    expect(await bed.store.outboundForTask(firstTask)).toHaveLength(1);
    expect(await bed.store.outboundForTask(secondTask)).toHaveLength(1);
    expect(bed.provider.sends.map((s) => s.text)).toEqual(['Perfecto.', 'Perfecto.']);
  });

  it.each(['accepted', 'delivered', 'read', 'unknown', 'failed'] as const)('keeps a prior %s outbound as causal evidence', async (status) => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, providerTimeoutMs: 250 });
    bed.next(say('Mismo episodio.'));
    await bed.customer(CUSTOMER, `wamid.${status}.1`, 'Mismo input');
    const taskId = await bed.taskOf(CUSTOMER);
    await bed.runAgent();
    await bed.gateway.delivery.materialize(1);
    const first = (await bed.store.outboundForTask(taskId))[0]!;

    if (status === 'unknown') {
      bed.provider.script({ kind: 'hang', ms: 1000 });
      await bed.gateway.delivery.dispatchOnce();
    } else {
      await bed.gateway.delivery.dispatchOnce();
      const accepted = (await bed.store.outbound(first.outboundId))!;
      if (status === 'delivered' || status === 'read' || status === 'failed') {
        await bed.status([{ id: accepted.providerMessageId!, status, recipientId: CUSTOMER }]);
      }
    }

    const durable = (await bed.store.outbound(first.outboundId))!;
    expect(durable.status).toBe(status);
    await replayOnSameFrontier(taskId, 'Mismo episodio.');
    const second = await bed.gateway.delivery.materialize();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ status: 'cancelled', cancelReason: 'duplicate_content' });
    expect((await bed.store.outbound(first.outboundId))!.status).toBe(status);
    expect(bed.provider.sends).toHaveLength(1);
  });
});

describe('handoff + inbound: human ownership persists input and blocks autonomy until release', () => {
  it('input durable and visible, no cognition or delivery while human-owned, autonomy resumes after release', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    bed.next(say('Perfecto.'));
    await bed.customer(CUSTOMER, 'wamid.in.1', 'Hola');
    const taskId = await bed.taskOf(CUSTOMER);
    await bed.runAgent();
    await bed.deliver();

    const handoff = await bed.api.temporal.takeOver(taskId, { responseKey: 'take-1', note: 'Tomo la conversación.' }, OPERATOR);
    expect(await bed.customer(CUSTOMER, 'wamid.in.2', 'Quiero hablar con alguien')).toMatchObject({ status: 200 });
    const calls = bed.model.callCount;
    expect(await bed.runAgent()).toEqual([]);
    expect(bed.model.callCount).toBe(calls);
    const [second] = await bed.rows<{ disposition: string }>(`select disposition from inbound_events where provider_event_id = 'wamid.in.2'`);
    expect(second!.disposition).toBe('human_owned');
    const thread = await bed.api.production.thread(taskId);
    expect(thread.entries.filter((e) => e.kind === 'contact').map((e) => e.text)).toEqual(['Hola', 'Quiero hablar con alguien']);

    // Operator manual reply (ported semantics): delivered by the same owner.
    await bed.api.production.manualReply(taskId, { responseKey: 'reply-1', text: 'Perfecto.' }, OPERATOR);
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual(['Perfecto.', 'Perfecto.']);

    await bed.api.temporal.respondHuman(handoff.requestId, { responseKey: 'release-1', outcome: 'release', content: 'Devuelvo la conversación al agente.' }, OPERATOR);
    bed.next(say('Retomo yo. ¿Seguimos con la bicicleta?'));
    await bed.runAgent();
    await bed.deliver();
    expect(bed.provider.sends.at(-1)!.text).toBe('Retomo yo. ¿Seguimos con la bicicleta?');
    // The resumed run saw what happened while humans owned the conversation.
    const context = JSON.stringify(bed.model.requests.at(-1)!.context);
    expect(context).toContain('Quiero hablar con alguien');
  });
});

describe('kill switch', () => {
  it('defaults safe: inbound persisted and held for humans, no cognition, no delivery, visible in attention', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER] });
    expect(await bed.customer(CUSTOMER, 'wamid.in.1', 'Hola')).toMatchObject({ status: 200, body: { ingested: 1 } });
    const taskId = await bed.taskOf(CUSTOMER);
    expect(await bed.runAgent()).toEqual([]);
    expect(bed.model.callCount).toBe(0);
    await bed.deliver();
    expect(bed.provider.sends).toHaveLength(0);
    const task = (await bed.api.tasks.getTask(taskId)).task;
    expect(task).toMatchObject({ status: 'blocked', statusReason: 'autonomy_disabled' });
    const attention = await bed.api.production.attention();
    expect(attention.tasks.requests.find((r) => r.taskId === taskId)).toMatchObject({ kind: 'handoff', status: 'requested', payload: { initiatedBy: 'platform', reason: 'autonomy_disabled' } });
    expect((await bed.api.temporal.inspect(taskId)).humans).toHaveLength(1);
    expect((await bed.store.metrics()).kill_switch_blocks).toBe(1);
  });

  it('engaged mid-conversation: pending agent output is held (not sent, not lost); new cognition is refused', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    bed.next(say('Respuesta que no debe salir con el switch activo.'));
    await bed.customer(CUSTOMER, 'wamid.in.1', 'Hola');
    await bed.runAgent();
    await bed.api.production.setControl({ scope: 'global', autonomyEnabled: false, reason: 'incident drill' }, OPERATOR);
    await bed.deliver();
    expect(bed.provider.sends).toHaveLength(0);
    const taskId = await bed.taskOf(CUSTOMER);
    expect((await bed.store.outboundForTask(taskId))[0]).toMatchObject({ status: 'pending', holdReason: 'autonomy_disabled' });
    // A new message: persisted, task held, no model call.
    const calls = bed.model.callCount;
    await bed.customer(CUSTOMER, 'wamid.in.2', '¿Hola?');
    expect(await bed.runAgent()).toEqual([]);
    expect(bed.model.callCount).toBe(calls);
    expect((await bed.store.taskState(taskId))).toMatchObject({ status: 'blocked', humanOwned: true });
    expect((await bed.api.temporal.inspect(taskId)).humans[0]).toMatchObject({ kind: 'handoff', status: 'requested', payload: { initiatedBy: 'platform', reason: 'autonomy_disabled' } });
    expect((await bed.api.production.attention()).production.heldOutbound).toHaveLength(1);
    // Released: the held response goes out (still fresh); the task stays with humans until an operator releases it.
    await bed.api.production.setControl({ scope: 'global', autonomyEnabled: true, reason: 'drill over' }, OPERATOR);
    await new Promise((r) => setTimeout(r, 30));
    await bed.deliver();
    expect(bed.provider.sends).toHaveLength(0);
    expect((await bed.store.outboundForTask(taskId))[0]).toMatchObject({ status: 'cancelled', cancelReason: 'superseded_by_operator' });
  });

  it('serializes inbound, operator takeover and an outbound claim on the Task row', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    bed.next(say('Pendiente.'));
    await bed.customer(CUSTOMER, 'wamid.in.1', 'Hola');
    await bed.runAgent();
    await bed.gateway.delivery.materialize();
    const taskId = await bed.taskOf(CUSTOMER);
    const [outbound] = await bed.store.outboundForTask(taskId);
    expect(outbound).toMatchObject({ status: 'pending', attempts: 0 });

    const blocker = await bed.pool.connect();
    await blocker.query('begin');
    await blocker.query('select task_id from agent_tasks where task_id = $1 for update', [taskId]);
    try {
      const takeover = bed.api.temporal.takeOver(taskId, { responseKey: 'concurrent-take', note: 'Tomo la conversación.' }, OPERATOR);
      await waitForTaskLockWaiters(1);
      const inbound = bed.customer(CUSTOMER, 'wamid.in.2', 'Necesito ayuda humana');
      await waitForTaskLockWaiters(2);
      const claim = bed.gateway.delivery.dispatchOnce();
      await waitForTaskLockWaiters(3);
      await blocker.query('commit');

      const [handoff, received, dispatch] = await Promise.all([takeover, inbound, claim]);
      expect(handoff.status).toBe('active');
      expect(received).toMatchObject({ status: 200, body: { ingested: 1 } });
      expect(dispatch).toMatchObject({ kind: 'cancelled', reason: 'superseded_by_operator' });
    } catch (error) {
      await blocker.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }

    const [inbound] = await bed.rows<{ disposition: string; task_id: string }>(`select disposition, task_id from inbound_events where provider_event_id = 'wamid.in.2'`);
    expect(inbound).toEqual({ disposition: 'human_owned', task_id: taskId });
    expect(await bed.store.taskState(taskId)).toMatchObject({ status: 'blocked', humanOwned: true });
    expect((await bed.api.temporal.inspect(taskId)).ownership).toMatchObject({ owner: 'human', blockedBy: ['human_handoff'] });
    expect((await bed.store.outbound(outbound!.outboundId))).toMatchObject({ status: 'cancelled', cancelReason: 'superseded_by_operator' });
    expect(bed.provider.sends).toHaveLength(0);
    expect(await bed.runAgent()).toEqual([]);
  });
});

describe('rollout exclusion', () => {
  it('a valid inbound from a conversation outside the cohort is kept and made visible; the model never runs', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: ['56900000001'], autonomy: true });
    await bed.customer(CUSTOMER, 'wamid.in.1', 'Hola');
    const taskId = await bed.taskOf(CUSTOMER);
    expect(await bed.runAgent()).toEqual([]);
    expect(bed.model.callCount).toBe(0);
    expect((await bed.api.tasks.getTask(taskId)).task).toMatchObject({ status: 'blocked', statusReason: 'rollout_excluded' });
    const [binding] = await bed.rows<{ autonomy: string; eligibility_reason: string }>('select autonomy, eligibility_reason from channel_conversation_bindings');
    expect(binding).toEqual({ autonomy: 'excluded', eligibility_reason: 'not_in_cohort' });
    expect((await bed.store.metrics()).rollout_blocks).toBe(1);
  });
});
