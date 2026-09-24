import { afterEach, describe, expect, it } from 'vitest';
import { createSilentLogger } from '@r4/observability';
import { OutboundDeliveryRuntime } from '@r4/live-ops';
import { WhatsAppOutboundAdapter, loadWhatsAppCloudConfig } from '@r4-adapters/whatsapp-cloud';
import { notification, signNotification } from '@r4-adapters/whatsapp-cloud/testing';
import { ACCESS_TOKEN, APP_SECRET, CANARY_PHONE_ID, IDENTITY_KEY, LiveOpsTestbed, OPERATOR, VERIFY_TOKEN, keyOf, say, waitInput } from '../support/live-ops.js';

const CUSTOMER = '56911112222';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

/** A bed with one conversation whose agent response is materialized but not yet dispatched. */
async function withPendingResponse(text = 'Hola, ¿en qué te ayudo?', options: Parameters<typeof LiveOpsTestbed.start>[0] = {}) {
  bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, ...options });
  bed.next(say(text), waitInput());
  await bed.customer(CUSTOMER, 'wamid.in.1', 'Hola');
  await bed.runAgent();
  await bed.gateway.delivery.materialize();
  const taskId = await bed.taskOf(CUSTOMER);
  return { bed, taskId };
}

describe('webhook authentication and verification', () => {
  it('rejects unsigned or wrongly signed notifications without persisting anything', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    const body = notification(CANARY_PHONE_ID, { messages: [{ id: 'wamid.x', from: CUSTOMER, text: 'hola' }] });
    expect((await bed.webhook(body, null)).status).toBe(401);
    expect((await bed.webhook(body, signNotification('not-the-secret', body))).status).toBe(401);
    expect(await bed.rows('select * from inbound_events')).toEqual([]);
    expect(await bed.rows('select * from agent_tasks')).toEqual([]);
  });

  it('answers the subscription handshake only for the configured verify token', async () => {
    bed = await LiveOpsTestbed.start();
    const ok = await bed.gateway.app.inject({ method: 'GET', url: `/v1/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=987654` });
    expect([ok.statusCode, ok.body]).toEqual([200, '987654']);
    const bad = await bed.gateway.app.inject({ method: 'GET', url: '/v1/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1' });
    expect(bad.statusCode).toBe(403);
  });
});

describe('inbound idempotency', () => {
  it('the same event delivered concurrently N times is one input, one task, one wake', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    const body = notification(CANARY_PHONE_ID, { messages: [{ id: 'wamid.dup', from: CUSTOMER, text: 'hola', timestamp: Math.floor(Date.now() / 1000) }] });
    const results = await Promise.all(Array.from({ length: 8 }, () => bed!.webhook(body)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await bed.rows('select count(*)::int as n from inbound_events')).toEqual([{ n: 1 }]);
    expect(await bed.rows('select count(*)::int as n from task_inputs')).toEqual([{ n: 1 }]);
    expect(await bed.rows('select count(*)::int as n from agent_tasks')).toEqual([{ n: 1 }]);
    expect(await bed.rows('select duplicate_deliveries from inbound_events')).toEqual([{ duplicate_deliveries: 7 }]);
    expect((await bed.store.metrics()).inbound_duplicate).toBe(7);
  });

  it('concurrent FIRST messages of a new conversation open one binding and one task (two inputs)', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    await Promise.all([bed.customer(CUSTOMER, 'wamid.a', 'hola'), bed.customer(CUSTOMER, 'wamid.b', 'busco una trotadora')]);
    expect(await bed.rows('select count(*)::int as n from channel_conversation_bindings')).toEqual([{ n: 1 }]);
    expect(await bed.rows('select count(*)::int as n from agent_tasks')).toEqual([{ n: 1 }]);
    expect(await bed.rows('select count(*)::int as n from task_inputs')).toEqual([{ n: 2 }]);
  });

  it('continues the same task; a new contact after truly terminal work opens a new task (no resurrection)', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    await bed.customer(CUSTOMER, 'wamid.1', 'hola');
    const first = await bed.taskOf(CUSTOMER);
    await bed.customer(CUSTOMER, 'wamid.2', 'sigo aquí');
    expect(await bed.taskOf(CUSTOMER)).toBe(first);
    await bed.api.temporal.cancelTask(first, OPERATOR);
    await bed.customer(CUSTOMER, 'wamid.3', 'hola de nuevo');
    const second = await bed.taskOf(CUSTOMER);
    expect(second).not.toBe(first);
    expect((await bed.api.tasks.getTask(first)).task.status).toBe('cancelled');
    expect(await bed.rows(`select status, closed_reason from channel_conversation_bindings order by created_at`)).toEqual([{ status: 'closed', closed_reason: 'task_cancelled' }, { status: 'open', closed_reason: null }]);
    const metrics = await bed.store.metrics();
    expect([metrics.task_created, metrics.task_continued]).toEqual([2, 1]);
  });

  it('unsupported content is classified, recorded and held for a human (never dropped, never empty text)', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    await bed.customer(CUSTOMER, 'wamid.img', '', { type: 'image' });
    const taskId = await bed.taskOf(CUSTOMER);
    expect((await bed.api.tasks.getTask(taskId)).task.statusReason).toBe('unsupported_inbound_content');
    const [input] = await bed.rows<{ text: string }>(`select m.content->>'text' as text from task_inputs i join memory_entries m on m.entry_id = i.memory_entry_id`);
    expect(input!.text).toBe('[unsupported inbound content: image]');
    expect(bed.model.callCount).toBe(0);
  });

  it('a genuine but non-canonicalizable item is recorded as rejected and acknowledged (no retry loop)', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    const raw = JSON.parse(notification(CANARY_PHONE_ID, { messages: [{ id: 'wamid.bad', from: CUSTOMER, text: 'x' }] })) as { entry: { changes: { value: { messages: { timestamp: string }[] } }[] }[] };
    raw.entry[0]!.changes[0]!.value.messages[0]!.timestamp = 'soon';
    const response = await bed.webhook(JSON.stringify(raw));
    expect(response).toMatchObject({ status: 200, body: { rejected: 1, ingested: 0 } });
    expect((await bed.api.production.attention()).production.rejectedInbound.map((r) => [r.providerEventId, r.failureCode])).toEqual([['wamid.bad', 'invalid_timestamp']]);
    expect(await bed.rows('select count(*)::int as n from agent_tasks')).toEqual([{ n: 0 }]);
  });

  it('a notification for another business number is never taken', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true });
    await bed.webhook(notification('5550001', { messages: [{ id: 'wamid.foreign', from: CUSTOMER, text: 'hola' }] }));
    expect(await bed.rows('select count(*)::int as n from agent_tasks')).toEqual([{ n: 0 }]);
    expect(await bed.rows('select failure_code from inbound_events')).toEqual([{ failure_code: 'foreign_business_number' }]);
  });
});

describe('outbound identity, dispatch and unknown outcomes', () => {
  it('one outbound per accepted respond, whatever the number of materializations', async () => {
    const { taskId } = await withPendingResponse();
    await Promise.all([bed!.gateway.delivery.materialize(), bed!.gateway.delivery.materialize(), bed!.gateway.delivery.materialize()]);
    expect(await bed!.store.outboundForTask(taskId)).toHaveLength(1);
  });

  it('two dispatchers racing over the same messages submit each exactly once (row locks + fencing)', async () => {
    bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER, '56922223333', '56933334444'], autonomy: true });
    for (const [i, who] of [CUSTOMER, '56922223333', '56933334444'].entries()) {
      bed.next(say(`respuesta ${i}`), waitInput());
      await bed.customer(who, `wamid.r${i}`, 'hola');
      await bed.runAgent();
    }
    await bed.gateway.delivery.materialize();
    const config = loadWhatsAppCloudConfig({ R4_WHATSAPP_APP_SECRET: APP_SECRET, R4_WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN, R4_WHATSAPP_ACCESS_TOKEN: ACCESS_TOKEN, R4_WHATSAPP_PHONE_NUMBER_ID: CANARY_PHONE_ID, R4_WHATSAPP_GRAPH_BASE_URL: bed.provider.baseUrl }, { allowNetwork: false });
    const second = new OutboundDeliveryRuntime({ store: bed.store, adapters: [new WhatsAppOutboundAdapter(config)], config: bed.production.config, owner: 'gateway-b', logger: createSilentLogger() });
    await Promise.all([bed.gateway.delivery.tick(), second.tick(), bed.gateway.delivery.tick(), second.tick()]);
    expect(bed.provider.sends.map((s) => s.text).sort()).toEqual(['respuesta 0', 'respuesta 1', 'respuesta 2']);
    expect(await bed.rows(`select count(*)::int as n from outbound_delivery_attempts`)).toEqual([{ n: 3 }]);
  });

  it('a provider timeout is UNKNOWN, never retried; a later provider callback reconciles it', async () => {
    await withPendingResponse('mensaje con timeout', { providerTimeoutMs: 200 });
    bed!.provider.script({ kind: 'hang', ms: 600 });
    await bed!.deliver();
    const taskId = await bed!.taskOf(CUSTOMER);
    const [o] = await bed!.store.outboundForTask(taskId);
    expect(o).toMatchObject({ status: 'unknown', errorClass: 'timeout', attempts: 1, providerMessageId: null });
    for (let i = 0; i < 3; i += 1) await bed!.deliver();
    expect(bed!.provider.sends).toHaveLength(1);
    expect((await bed!.api.production.attention()).production.unknownOutbound.map((x) => x.outboundId)).toEqual([o!.outboundId]);
    // The fake did process it: the provider later reports it by its id; the evidence cannot be matched without the id.
    await bed!.status([{ id: bed!.provider.sends[0]!.providerMessageId!, status: 'delivered', recipientId: CUSTOMER }]);
    expect((await bed!.store.outbound(o!.outboundId))!.status).toBe('unknown');
    expect((await bed!.api.production.attention()).production.unmatchedStatusEvents).toHaveLength(1);
    // Only an operator (with out-of-band evidence) settles it — never a resend.
    const resolved = await bed!.api.production.resolveOutbound(o!.outboundId, { outcome: 'delivered', note: 'el cliente confirmó recepción en llamada' }, OPERATOR);
    expect(resolved).toMatchObject({ status: 'delivered', resolvedBy: OPERATOR.humanRef });
    await expect(bed!.api.production.resolveOutbound(o!.outboundId, { outcome: 'failed', note: 'x' }, OPERATOR)).rejects.toMatchObject({ code: 'outbound_not_unknown' });
  });

  it('5xx and dropped connections are unknown too; 429 is retried within the budget, then accepted', async () => {
    await withPendingResponse('primero');
    bed!.provider.script({ kind: 'status', status: 429, retryAfter: '0' }, { kind: 'accept' });
    await bed!.deliver();
    await new Promise((r) => setTimeout(r, 20));
    await bed!.deliver();
    const taskId = await bed!.taskOf(CUSTOMER);
    expect((await bed!.store.outboundForTask(taskId))[0]).toMatchObject({ status: 'accepted', attempts: 2 });
    const attempts = await bed!.store.attempts((await bed!.store.outboundForTask(taskId))[0]!.outboundId);
    expect(attempts.map((a) => [a.outcome, a.errorClass])).toEqual([['not_sent', 'rate_limited'], ['accepted', null]]);

    bed!.next(say('segundo'), waitInput(), say('tercero'), waitInput());
    await bed!.customer(CUSTOMER, 'wamid.in.2', 'y?');
    await bed!.runAgent();
    bed!.provider.script({ kind: 'status', status: 503 });
    await bed!.deliver();
    await bed!.customer(CUSTOMER, 'wamid.in.3', 'hola??');
    await bed!.runAgent();
    bed!.provider.script({ kind: 'drop' });
    await bed!.deliver();
    const statuses = (await bed!.store.outboundForTask(taskId)).map((o) => [o.status, o.errorClass]);
    expect(statuses).toEqual([['accepted', null], ['unknown', 'provider_5xx'], ['unknown', 'network_after_send']]);
  });

  it('a dispatcher that dies mid-call leaves no assumption: the lease expires into UNKNOWN, never re-sent', async () => {
    await withPendingResponse('mensaje en vuelo', { leaseMs: 1500, providerTimeoutMs: 1000 });
    const claim = await bed!.store.claimNextOutbound({ owner: 'dead-dispatcher', leaseMs: 1500, holdRecheckMs: 10, customerWindowMs: () => null, deniedNow: () => false, decide: () => ({ kind: 'dispatch' }) });
    expect(claim?.kind).toBe('dispatch');
    await bed!.deliver();
    expect(bed!.provider.sends).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 1700));
    const pass = await bed!.deliver();
    expect(pass.swept).toBe(1);
    const taskId = await bed!.taskOf(CUSTOMER);
    const [o] = await bed!.store.outboundForTask(taskId);
    expect(o).toMatchObject({ status: 'unknown', errorClass: 'lease_expired_during_dispatch' });
    expect(await bed!.store.attempts(o!.outboundId)).toEqual([expect.objectContaining({ outcome: 'unknown', errorClass: 'lease_expired_during_dispatch' })]);
    // The dead dispatcher's late report is rejected by the fence (but an acceptance would still count as evidence).
    const late = await bed!.store.recordSubmission(claim!.kind === 'dispatch' ? claim!.token : (undefined as never), { outcome: 'accepted', providerMessageId: 'wamid.late', httpStatus: 200, errorClass: null, errorCode: null, retryAfterMs: null, latencyMs: 1 }, { status: 'accepted' });
    expect(late).toMatchObject({ applied: false, outbound: { status: 'accepted', providerMessageId: 'wamid.late' } });
    expect(bed!.provider.sends).toHaveLength(0);
  });
});

describe('provider callbacks', () => {
  it('duplicate callbacks (also concurrent) are one transition; out-of-order ones never move status backwards', async () => {
    await withPendingResponse();
    await bed!.deliver();
    const taskId = await bed!.taskOf(CUSTOMER);
    const [o] = await bed!.store.outboundForTask(taskId);
    const wamid = o!.providerMessageId!;
    const ts = Math.floor(Date.now() / 1000);
    const delivered = notification(CANARY_PHONE_ID, { statuses: [{ id: wamid, status: 'delivered', recipientId: CUSTOMER, timestamp: ts }] });
    await Promise.all(Array.from({ length: 5 }, () => bed!.webhook(delivered)));
    expect(await bed!.rows(`select effect from outbound_delivery_events where status = 'delivered'`)).toEqual([{ effect: 'applied' }]);
    await bed!.status([{ id: wamid, status: 'sent', recipientId: CUSTOMER, timestamp: ts - 5 }, { id: wamid, status: 'failed', recipientId: CUSTOMER, timestamp: ts + 5, errorCode: 131026 }]);
    expect((await bed!.store.outbound(o!.outboundId))!.status).toBe('delivered');
    expect((await bed!.store.deliveryEvents(o!.outboundId)).map((e) => [e.status, e.effect])).toEqual([['accepted', 'ignored'], ['delivered', 'applied'], ['failed', 'ignored']]);
  });

  it('a status that arrives before the submission recorded its provider id is applied once the id is known', async () => {
    const { taskId } = await withPendingResponse();
    // The provider will answer with wamid.fake.1; its delivery report arrives first.
    await bed!.status([{ id: 'wamid.fake.1', status: 'delivered', recipientId: CUSTOMER }]);
    await bed!.deliver();
    expect((await bed!.store.outboundForTask(taskId))[0]).toMatchObject({ providerMessageId: 'wamid.fake.1', status: 'delivered' });
  });
});

describe('stale reply protection and operator supersession (ported CRM semantics)', () => {
  it('a newer customer input supersedes a pending response; the next cognition sees it was not sent', async () => {
    const { taskId } = await withPendingResponse('respuesta que ya no aplica');
    bed!.next(say('respuesta a lo nuevo'), waitInput());
    await bed!.customer(CUSTOMER, 'wamid.in.2', 'mejor otra cosa');
    await bed!.deliver();
    expect((await bed!.store.outboundForTask(taskId))[0]).toMatchObject({ status: 'cancelled', cancelReason: 'superseded_by_newer_input' });
    await bed!.runAgent();
    const context = bed!.model.requests.at(-2)!.context!;
    expect(context.sections.episodicMemory.filter((i) => i.sourceId === 'production.delivery').map((i) => (i.content as { reason: string }).reason)).toEqual(['superseded_by_newer_input']);
    await bed!.deliver();
    expect(bed!.provider.sends.map((s) => s.text)).toEqual(['respuesta a lo nuevo']);
  });

  it('an operator takeover supersedes pending agent output; a submitted one is never cancelled', async () => {
    const { taskId } = await withPendingResponse('pendiente');
    await bed!.api.temporal.takeOver(taskId, { responseKey: 't1', note: 'tomo' }, OPERATOR);
    await bed!.deliver();
    expect((await bed!.store.outboundForTask(taskId))[0]).toMatchObject({ status: 'cancelled', cancelReason: 'superseded_by_operator' });
    expect(bed!.provider.sends).toHaveLength(0);
    await expect(bed!.api.production.cancelOutbound((await bed!.store.outboundForTask(taskId))[0]!.outboundId, OPERATOR)).rejects.toMatchObject({ code: 'outbound_not_pending' });
  });
});

describe('startup fail-closed', () => {
  it('refuses a non-real outbound binding, a missing outbound owner, or an undeclared profile for a REAL channel', async () => {
    bed = await LiveOpsTestbed.start();
    const { composeSalesGateway } = await import('@r4-sales/agent/production');
    const { createGatewayPlatform } = await import('@r4/channel-gateway');
    const { bindings } = composeSalesGateway({ pool: bed.pool, production: bed.production, env: bed.env });
    const config = { databaseUrl: bed.db.url, host: '127.0.0.1', port: 0, logLevel: 'silent' as const, dbPoolMax: 1, gatewayId: 'refused', dispatch: false, resumeAfterMs: 1000 };
    const sink = { ...bindings.outbound[0]!, channel: 'whatsapp', bindingKind: 'local-fake' as const, submit: bindings.outbound[0]!.submit.bind(bindings.outbound[0]) };
    await expect(createGatewayPlatform(config, { ...bindings, outbound: [sink] }, { logger: createSilentLogger() })).rejects.toThrow(/is local-fake but the profile declares REAL/);
    await expect(createGatewayPlatform(config, { ...bindings, outbound: [] }, { logger: createSilentLogger() })).rejects.toThrow(/no outbound adapter/);
    await expect(createGatewayPlatform(config, { ...bindings, production: { ...bed.production, config: { ...bed.production.config, policyProfile: 'sales-production@2' } } }, { logger: createSilentLogger() })).rejects.toThrow(/is not the declared R4_PROD_POLICY_PROFILE/);
  });
});

describe('privacy and secrets', () => {
  it('no secret, raw payload or profile name is ever persisted; the address lives only on the binding', async () => {
    await withPendingResponse();
    await bed!.deliver();
    const dump = JSON.stringify(await bed!.rows(`select table_name from information_schema.tables where table_schema in ('public', 'sales')`));
    const tables = (JSON.parse(dump) as { table_name: string }[]).map((t) => t.table_name);
    const everything: string[] = [];
    for (const t of tables) {
      const schema = ['conversations', 'workspaces', 'workspace_transitions', 'quote_requests', 'quote_references'].includes(t) ? 'sales' : 'public';
      everything.push(JSON.stringify(await bed!.rows(`select * from ${schema}.${t}`)));
    }
    const all = everything.join('\n');
    for (const secret of [APP_SECRET, ACCESS_TOKEN, VERIFY_TOKEN, IDENTITY_KEY, 'Bearer ']) expect(all).not.toContain(secret);
    expect(all).not.toContain('Test Contact');
    expect(all).not.toContain('whatsapp_business_account');
    const withPhone = tables.filter((_, i) => everything[i]!.includes(CUSTOMER));
    expect(withPhone).toEqual(['channel_conversation_bindings']);
    expect(all).toContain(keyOf(CUSTOMER));
  });
});

describe('operator plane over HTTP', () => {
  it('thread, outbound, attention, controls and manual reply are exposed only with a trusted human context', async () => {
    const { taskId } = await withPendingResponse();
    await bed!.deliver();
    const get = (url: string) => bed!.api.app.inject({ method: 'GET', url });
    expect((await get(`/v1/tasks/${taskId}/thread`)).json<{ entries: unknown[] }>().entries).toHaveLength(2);
    expect((await get(`/v1/tasks/${taskId}/outbound`)).json<{ outbound: { status: string }[] }>().outbound[0]!.status).toBe('accepted');
    expect((await get('/v1/production/controls')).json<{ state: { globalEnabled: boolean } }>().state.globalEnabled).toBe(true);
    const metrics = (await get('/v1/production/metrics')).json<{ metrics: { outbound_accepted: number } }>();
    expect(metrics.metrics.outbound_accepted).toBe(1);
    const reply = await bed!.api.app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/operator-messages`, payload: { responseKey: 'r1', text: 'Te escribe Ana.' } });
    expect(reply.statusCode).toBe(201);
    const again = await bed!.api.app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/operator-messages`, payload: { responseKey: 'r1', text: 'Te escribe Ana.' } });
    expect(again.statusCode).toBe(200);
    const kill = await bed!.api.app.inject({ method: 'POST', url: '/v1/production/controls', payload: { scope: 'global', autonomyEnabled: false, reason: 'drill' } });
    expect(kill.json<{ control: { version: number } }>().control.version).toBe(3);
    expect(await bed!.rows('select scope, autonomy_enabled, changed_by from autonomy_control_events order by occurred_at')).toEqual([
      { scope: 'global', autonomy_enabled: true, changed_by: 'test' },
      { scope: 'global', autonomy_enabled: false, changed_by: OPERATOR.humanRef },
    ]);
  });
});
