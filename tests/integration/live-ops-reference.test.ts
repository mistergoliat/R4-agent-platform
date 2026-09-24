import { afterEach, describe, expect, it } from 'vitest';
import { PostgresTrajectoryReader } from '@r4/evaluator';
import { PostgresSalesStore } from '@r4-sales/agent';
import { SCRIPTED_MODEL_PROFILE, evaluateSalesSubject, salesWorkspaceProjection } from '@r4-sales/agent/evaluations';
import { LiveOpsTestbed, OPERATOR, invalid, say, waitInput } from '../support/live-ops.js';

/**
 * R4-I reference paths (offline, real PostgreSQL, real runtime, local fake
 * provider): the full production path, ADR-028 recovery after a delivered
 * response, handoff with inbound, kill switch, rollout exclusion.
 */
const CUSTOMER = '56911112222';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

describe('reference path: provider inbound → Task → respond → durable outbound → accepted → delivered → evaluation', () => {
  it('runs end to end with every state durable and correlated', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    bed.next(say('¡Hola! Soy el asistente de ventas. ¿Qué estás buscando?'), waitInput());

    expect(await bed.customer(CUSTOMER, 'wamid.in.1', 'Hola, quiero una bicicleta estática')).toMatchObject({ status: 200, body: { ingested: 1 } });
    const taskId = await bed.taskOf(CUSTOMER);
    // Webhook did no cognition: the model was not called inside the request.
    expect(bed.model.callCount).toBe(0);

    await bed.runAgent();
    expect(bed.model.callCount).toBe(2);
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
    expect(metrics).toMatchObject({ inbound_received: 1, task_created: 1, outbound_created: 1, outbound_dispatch_attempted: 1, outbound_accepted: 1, outbound_delivered: 1, outbound_read: 1, outbound_unknown: 0, model_calls: 2 });
  });
});

describe('ADR-028 production regression: a later protocol failure never re-sends a delivered response', () => {
  it('same Task, prior response not re-dispatched, new input accepted, recovery answer delivered once', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    bed.next(say('Tenemos bicicletas estáticas desde $199.990.'), waitInput());
    await bed.customer(CUSTOMER, 'wamid.in.1', 'Hola');
    const taskId = await bed.taskOf(CUSTOMER);
    await bed.runAgent();
    await bed.deliver();
    const first = (await bed.store.outboundForTask(taskId))[0]!;
    await bed.status([{ id: first.providerMessageId!, status: 'delivered', recipientId: CUSTOMER }]);

    // Next turn: the model breaks the protocol (invalid decision) → run fails recoverably → recovery run.
    bed.next(invalid(), say('Perfecto, te cuento las opciones de pago.'), waitInput());
    await bed.customer(CUSTOMER, 'wamid.in.2', '¿Aceptan tarjeta?');
    await bed.runAgent();
    const runs = await bed.rows<{ status: string; termination_reason: string | null }>('select status, termination_reason from agent_runs where task_id = $1 order by sequence', [taskId]);
    expect(runs.map((r) => r.status)).toEqual(['suspended', 'failed', 'suspended']);
    expect(runs[1]!.termination_reason).toBe('invalid_decision');
    expect(await bed.taskOf(CUSTOMER)).toBe(taskId);

    await bed.deliver();
    await bed.deliver();
    const texts = bed.provider.sends.map((s) => s.text);
    expect(texts).toEqual(['Tenemos bicicletas estáticas desde $199.990.', 'Perfecto, te cuento las opciones de pago.']);
    expect((await bed.store.outbound(first.outboundId))!.status).toBe('delivered');

    // A recovery run that repeats an identical live response is never sent twice.
    bed.next(invalid(), say('Perfecto, te cuento las opciones de pago.'), waitInput());
    await bed.customer(CUSTOMER, 'wamid.in.3', '¿Y en cuotas?');
    await bed.runAgent();
    await bed.deliver();
    const outbound = await bed.store.outboundForTask(taskId);
    expect(outbound.map((o) => [o.status, o.cancelReason])).toEqual([['delivered', null], ['accepted', null], ['cancelled', 'duplicate_content']]);
    expect(bed.provider.sends).toHaveLength(2);
    // The next cognition is told the truth about that response.
    bed.next(waitInput());
    await bed.customer(CUSTOMER, 'wamid.in.4', '¿Hola?');
    await bed.runAgent();
    const lastContext = bed.model.requests.at(-1)!.context!;
    const episodes = lastContext.sections.episodicMemory.filter((i) => i.sourceId === 'production.delivery');
    expect(episodes.map((e) => (e.content as { status: string; reason: string }).reason)).toContain('duplicate_content');
  });
});

describe('handoff + inbound: human ownership persists input and blocks autonomy until release', () => {
  it('input durable and visible, no cognition or delivery while human-owned, autonomy resumes after release', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    bed.next(say('Hola, ¿en qué te ayudo?'), waitInput());
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
    await bed.api.production.manualReply(taskId, { responseKey: 'reply-1', text: 'Hola, soy Ana del equipo de ventas.' }, OPERATOR);
    await bed.deliver();
    expect(bed.provider.sends.map((s) => s.text)).toEqual(['Hola, ¿en qué te ayudo?', 'Hola, soy Ana del equipo de ventas.']);

    await bed.api.temporal.respondHuman(handoff.requestId, { responseKey: 'release-1', outcome: 'release', content: 'Devuelvo la conversación al agente.' }, OPERATOR);
    bed.next(say('Retomo yo. ¿Seguimos con la bicicleta?'), waitInput());
    await bed.runAgent();
    await bed.deliver();
    expect(bed.provider.sends.at(-1)!.text).toBe('Retomo yo. ¿Seguimos con la bicicleta?');
    // The resumed run saw what happened while humans owned the conversation.
    const context = JSON.stringify(bed.model.requests.at(-2)!.context);
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
    expect((await bed.store.metrics()).kill_switch_blocks).toBe(1);
  });

  it('engaged mid-conversation: pending agent output is held (not sent, not lost); new cognition is refused', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    bed.next(say('Respuesta que no debe salir con el switch activo.'), waitInput());
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
    expect((await bed.api.production.attention()).production.heldOutbound).toHaveLength(1);
    // Released: the held response goes out (still fresh); the task stays with humans until an operator releases it.
    await bed.api.production.setControl({ scope: 'global', autonomyEnabled: true, reason: 'drill over' }, OPERATOR);
    await new Promise((r) => setTimeout(r, 30));
    await bed.deliver();
    expect(bed.provider.sends).toHaveLength(0);
    expect((await bed.store.outboundForTask(taskId))[0]).toMatchObject({ status: 'cancelled', cancelReason: 'superseded_by_operator' });
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
