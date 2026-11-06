import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogDiscoverResponseSchema, type CatalogDiscoverAnswer, type CatalogDiscoverPort, type CatalogDiscoverRequest } from '@r4-adapters/catalog-http';
import { DomainError, FixtureCatalog, type ShippingService } from '@r4-adapters/domains';
import type { ModelRequest } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint } from '@r4/live-ops';
import { SALES_CHANNEL_INGRESS, SALES_PRODUCTION_PROFILE_V3, composeSalesProductionWorker, salesConversationTaskFactory, salesGatewayLane } from '@r4-sales/agent/production';
import { CANARY_PHONE_ID, LiveOpsTestbed, OPERATOR, keyOf, registerLaneDefinition, say, type QueuedStep } from '../support/live-ops.js';

/**
 * ADR-045 — the E1 lane on the existing gateway and number: the owner's allowlisted conversation is served by the lane
 * profile sales-production@13 (definition v13, its own worker), every other conversation exactly as before.
 * Invariants (mandate «R4 — Integrated Commercial E2E», §C): deterministic assignment, exclusion of other
 * conversations, one execution per message, history preserved, no duplicated responses, recovery after restart,
 * rollback, and the main profile untouched.
 */
const OWNER = '56911110000';
const OTHER = '56922220000';
const OUTSIDER = '56933330000';
const LANE = 'sales-production@13';

const fixtures = JSON.parse(readFileSync(new URL('../../adapters/domains/catalog/http/fixtures/discover/catalog-discover.fixtures.v1b1.json', import.meta.url), 'utf8')) as { answers: { httpStatus: number; response: unknown }[] };
const ANSWER: CatalogDiscoverAnswer = catalogDiscoverResponseSchema.parse(fixtures.answers.find((a) => a.httpStatus === 200)!.response);

function owners() {
  const calls: CatalogDiscoverRequest[] = [];
  const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: (request) => (calls.push(request), Promise.resolve(ANSWER)) };
  const shipping: ShippingService & { bindingKind: string } = { bindingKind: 'http', quote: () => Promise.reject(new DomainError('temporarily_unavailable', 'not_in_test', 'not used')) };
  return { catalog: Object.assign(new FixtureCatalog(), { bindingKind: 'real' }), discover, shipping, calls };
}

let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

const bindings = (b: LiveOpsTestbed) => b.rows<{ conversation_key: string; profile: string; status: string; closed_reason: string | null; agent_version: number | null }>(
  'select b.conversation_key, b.profile, b.status, b.closed_reason, t.agent_version from channel_conversation_bindings b left join agent_tasks t on t.task_id = b.task_id order by b.created_at');
const versionOf = async (b: LiveOpsTestbed, waId: string) => (await b.rows<{ agent_version: number }>('select agent_version from agent_tasks where task_id = $1', [await b.taskOf(waId)]))[0]!.agent_version;
const capabilityIds = (request: ModelRequest) => JSON.stringify(request.tools ?? []) + JSON.stringify(request.context ?? {});
function recording(step: QueuedStep): { step: QueuedStep; seen: () => ModelRequest } {
  let seen: ModelRequest | undefined;
  return { step: (request: ModelRequest) => ((seen = request), typeof step === 'function' ? step(request) : step), seen: () => seen! };
}

describe('ADR-045 conversation lane', () => {
  it('L1: assignment is deterministic and exclusive — only the lane conversation opens on @13 / v13; the others are exactly as before', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER, OTHER], lane: [OWNER], autonomy: true }));
    await b.laneWorker(owners());
    await b.customer(OWNER, 'wamid.l1a', 'Hola');
    await b.customer(OTHER, 'wamid.l1b', 'Hola');
    await b.customer(OUTSIDER, 'wamid.l1c', 'Hola');
    expect(await bindings(b)).toEqual([
      { conversation_key: keyOf(OWNER), profile: LANE, status: 'open', closed_reason: null, agent_version: 13 },
      { conversation_key: keyOf(OTHER), profile: 'sales-production@1', status: 'open', closed_reason: null, agent_version: 3 },
      { conversation_key: keyOf(OUTSIDER), profile: 'sales-production@1', status: 'open', closed_reason: null, agent_version: 3 },
    ]);
    // Same answer for the same conversation, message after message.
    await b.customer(OWNER, 'wamid.l1d', '¿Siguen ahí?');
    expect(await versionOf(b, OWNER)).toBe(13);
    expect((await bindings(b)).filter((r) => r.conversation_key === keyOf(OWNER))).toHaveLength(1);
  });

  it('L2: each worker runs only its own tasks; the lane worker really calls Discover and only it offers catalog.discover', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER, OTHER], lane: [OWNER], autonomy: true }));
    const o = owners();
    const lane = await b.laneWorker(o);
    const main = await b.worker('main-worker');
    await b.customer(OWNER, 'wamid.l2a', 'Algo para entrenar piernas en casa');
    await b.customer(OTHER, 'wamid.l2b', 'Hola');

    const mainSeen = recording(say('Hola, ¿en qué te ayudo?'));
    b.next(mainSeen.step);
    await b.runWorker(main);
    expect(await b.rows('select 1 from agent_runs where task_id = $1', [await b.taskOf(OWNER)])).toEqual([]);
    expect(capabilityIds(mainSeen.seen())).not.toContain('catalog.discover');

    const laneSeen = recording({ type: 'structured', data: { type: 'read_capability', capabilityId: 'catalog.discover', arguments: { need: 'entrenar piernas en casa', limit: 3 } } });
    b.next(laneSeen.step, say('Encontré estas opciones.'));
    await b.runWorker(lane);
    expect(capabilityIds(laneSeen.seen())).toContain('catalog.discover');
    expect(o.calls).toEqual([{ schemaVersion: 1, need: 'entrenar piernas en casa', limit: 3 }]);
    const [observation] = await b.rows<{ capability_id: string; payload: { requestId: string } }>('select capability_id, payload from observations where task_id = $1', [await b.taskOf(OWNER)]);
    expect(observation).toMatchObject({ capability_id: 'catalog.discover', payload: { requestId: ANSWER.requestId } });
    // Nothing is left for either worker.
    expect(await b.runWorker(main)).toEqual([]);
    expect(await b.runWorker(lane)).toEqual([]);
  });

  it('L3: one execution and one response per message, also under duplicated provider deliveries', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], lane: [OWNER], autonomy: true }));
    const lane = await b.laneWorker(owners());
    const main = await b.worker('main-worker');
    await Promise.all(Array.from({ length: 5 }, () => b.customer(OWNER, 'wamid.l3', 'Hola')));
    b.next(say('Hola, ¿qué buscas?'));
    await Promise.all([b.runWorker(lane), b.runWorker(main)]);
    await b.deliver();
    const taskId = await b.taskOf(OWNER);
    expect(await b.rows('select count(*)::int as n from task_inputs where task_id = $1', [taskId])).toEqual([{ n: 1 }]);
    expect(await b.rows('select count(*)::int as n from agent_runs where task_id = $1', [taskId])).toEqual([{ n: 1 }]);
    expect((await b.store.outboundForTask(taskId)).length).toBe(1);
    expect(b.provider.sends.length).toBe(1);
  });

  it('L3b: concurrent DISTINCT first messages of the lane conversation open one binding and one v13 task', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], lane: [OWNER], autonomy: true }));
    await Promise.all([b.customer(OWNER, 'wamid.l3b1', 'Hola'), b.customer(OWNER, 'wamid.l3b2', 'Busco una barra'), b.customer(OWNER, 'wamid.l3b3', 'Para sentadilla')]);
    expect(await bindings(b)).toHaveLength(1);
    expect(await b.rows('select agent_version, count(*)::int as n from agent_tasks group by 1')).toEqual([{ agent_version: 13, n: 1 }]);
    expect(await b.rows('select count(*)::int as n from task_inputs')).toEqual([{ n: 3 }]);
  });

  it('L4: history is preserved — the first lane task sees the earlier @1 conversation of the same contact', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], autonomy: true }));
    await b.customer(OWNER, 'wamid.l4a', 'Busco un banco regulable');
    b.next(say('Tenemos el banco Atlas.'));
    await b.runAgent();
    await b.deliver();
    await b.api.temporal.cancelTask(await b.taskOf(OWNER), OPERATOR);

    const lane = await b.laneWorker(owners());
    await b.redeployGateway({ allowlist: [OWNER], lane: [OWNER] });
    const seen = recording(say('Sigamos con el banco.'));
    await b.customer(OWNER, 'wamid.l4b', '¿Y el banco que me dijiste?');
    b.next(seen.step);
    await b.runWorker(lane);
    expect(await versionOf(b, OWNER)).toBe(13);
    const context = JSON.stringify(seen.seen().context);
    expect(context).toContain('Busco un banco regulable');
    expect(context).toContain('Tenemos el banco Atlas.');
  });

  it('L5: an existing lane binding follows its task even after the lane is removed (assignment never re-read from configuration)', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER, OTHER], lane: [OWNER], autonomy: true }));
    await b.customer(OWNER, 'wamid.l5a', 'Hola');
    const laneTask = await b.taskOf(OWNER);
    await b.redeployGateway({ allowlist: [OWNER, OTHER] });
    await b.customer(OWNER, 'wamid.l5b', 'Sigo aquí');
    expect(await b.taskOf(OWNER)).toBe(laneTask);
    expect(await versionOf(b, OWNER)).toBe(13);
    // …and a taskless leftover (crash between opening and creating) keeps its lane profile while the gateway serves it.
    await b.redeployGateway({ allowlist: [OWNER, OTHER], lane: [OWNER] });
    await b.pool.query(`insert into channel_conversation_bindings (binding_id, channel, conversation_key, account_ref, recipient_ref, status, autonomy, eligibility_reason, rollout_fingerprint, profile, profile_fingerprint)
      select gen_random_uuid(), channel, $1, account_ref, $2, 'open', 'autonomous', 'allowlisted', rollout_fingerprint, profile, profile_fingerprint from channel_conversation_bindings where conversation_key = $3`, [keyOf(OTHER), OTHER, keyOf(OWNER)]);
    await b.customer(OTHER, 'wamid.l5c', 'Hola');
    expect(await versionOf(b, OTHER)).toBe(13);
  });

  it('L5b: a taskless leftover of a profile the gateway no longer serves, with no task created, is reopened under the current assignment', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER, OTHER], lane: [OWNER], autonomy: true }));
    await b.customer(OWNER, 'wamid.l5d', 'Hola');
    await b.pool.query(`insert into channel_conversation_bindings (binding_id, channel, conversation_key, account_ref, recipient_ref, status, autonomy, eligibility_reason, rollout_fingerprint, profile, profile_fingerprint)
      select gen_random_uuid(), channel, $1, account_ref, $2, 'open', 'autonomous', 'allowlisted', rollout_fingerprint, profile, profile_fingerprint from channel_conversation_bindings where conversation_key = $3`, [keyOf(OTHER), OTHER, keyOf(OWNER)]);
    await b.redeployGateway({ allowlist: [OWNER, OTHER] });
    await b.customer(OTHER, 'wamid.l5e', 'Hola');
    expect(await versionOf(b, OTHER)).toBe(3);
    expect((await bindings(b)).filter((r) => r.conversation_key === keyOf(OTHER)).map((r) => [r.profile, r.status, r.closed_reason])).toEqual([[LANE, 'closed', 'profile_not_served'], ['sales-production@1', 'open', null]]);
  });

  it('L5c: a crash after the lane task was created but before it was attached, then the lane removed: the binding adopts that task (no second task, no second execution)', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], lane: [OWNER], autonomy: true }));
    const inserted = await b.pool.query<{ binding_id: string }>(`insert into channel_conversation_bindings (binding_id, channel, conversation_key, account_ref, recipient_ref, status, autonomy, eligibility_reason, rollout_fingerprint, profile, profile_fingerprint)
      values (gen_random_uuid(), 'whatsapp', $1, $2, $3, 'open', 'autonomous', 'allowlisted', 'leftover', $4, 'leftover') returning binding_id`, [keyOf(OWNER), CANARY_PHONE_ID, OWNER, LANE]);
    const bindingId = inserted.rows[0]!.binding_id;
    // What the crashed gateway had done: the v13 task created with this binding's creation key, with the first input.
    const created = await b.api.temporal.createTaskWithInput(b.api.tasks, {
      request: salesConversationTaskFactory(b.pool, 13).request({ bindingId, channel: 'whatsapp' }), requestedBy: SALES_CHANNEL_INGRESS, correlationId: `conversation-${bindingId}`, idempotencyKey: `conversation-${bindingId}`,
    }, { externalKey: 'wamid.l5f', content: 'Hola', sourceRef: 'channel:whatsapp', occurredAt: new Date().toISOString() }, { kind: 'user', ref: 'whatsapp:test' });
    await b.redeployGateway({ allowlist: [OWNER] });
    await b.customer(OWNER, 'wamid.l5g', '¿Hola?');
    expect(await b.taskOf(OWNER)).toBe(created.taskId);
    expect(await b.rows('select agent_version, count(*)::int as n from agent_tasks group by 1')).toEqual([{ agent_version: 13, n: 1 }]);
    expect(await b.rows('select count(*)::int as n from task_inputs where task_id = $1', [created.taskId])).toEqual([{ n: 2 }]);
  });

  it('L6: rollback by the runbook: lane removed, the lane worker keeps answering its open task (no message lost), then the task is cancelled and @1 serves the conversation again', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER, OTHER], lane: [OWNER], autonomy: true }));
    const lane = await b.laneWorker(owners());
    await b.customer(OWNER, 'wamid.l6a', 'Hola');
    b.next(say('Hola.'));
    await b.runWorker(lane);
    const laneTask = await b.taskOf(OWNER);

    // 1. Lane removed from the gateway; 2. the lane worker still runs and answers what reaches its open task.
    await b.redeployGateway({ allowlist: [OWNER, OTHER] });
    await b.customer(OWNER, 'wamid.l6b', 'Sigo');
    expect(await b.taskOf(OWNER)).toBe(laneTask);
    b.next(say('Te sigo.'));
    await b.runWorker(lane);
    await b.deliver();
    expect((await b.store.outboundForTask(laneTask)).length).toBe(2);
    // 3. Cancel the drained lane task; 4. the next message opens @1, and the lane worker has nothing left.
    await b.api.temporal.cancelTask(laneTask, OPERATOR);
    await b.customer(OWNER, 'wamid.l6c', 'Hola de nuevo');
    expect(await versionOf(b, OWNER)).toBe(3);
    b.next(say('Hola, ¿en qué te ayudo?'));
    await b.runAgent();
    expect(await b.runWorker(lane)).toEqual([]);
    expect((await bindings(b)).map((r) => [r.profile, r.status, r.closed_reason])).toEqual([[LANE, 'closed', 'task_cancelled'], ['sales-production@1', 'open', null]]);
  });

  it('L7: refusals — a lane conversation outside the rollout allowlist, partial or unknown lane configuration, a lane profile as the gateway profile', async () => {
    await expect(LiveOpsTestbed.start({ allowlist: [OTHER], lane: [OWNER] })).rejects.toThrow(/not allowlisted/);
    await expect(LiveOpsTestbed.start({ allowlist: [OWNER], env: { R4_PROD_LANE_ALLOWLIST: keyOf(OWNER) } })).rejects.toThrow(/set together or not at all/);
    await expect(LiveOpsTestbed.start({ allowlist: [OWNER], env: { R4_PROD_LANE_PROFILE: 'sales-production@3', R4_PROD_LANE_ALLOWLIST: keyOf(OWNER) } })).rejects.toThrow(/not a Sales lane profile/);
    await expect(LiveOpsTestbed.start({ allowlist: [OWNER], env: { R4_PROD_LANE_PROFILE: LANE, R4_PROD_LANE_ALLOWLIST: OWNER } })).rejects.toThrow(/64-hex/);
    await expect(LiveOpsTestbed.start({ allowlist: [OWNER], env: { R4_PROD_POLICY_PROFILE: LANE } })).rejects.toThrow(/not a Sales production profile/);
  });

  it('L7b: a gateway with a lane refuses to start while the lane definition is not registered; keys may be separated like the rollout allowlist', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER] }));
    await expect(b.redeployGateway({ allowlist: [OWNER], lane: [OWNER] })).rejects.toThrow(/lane definition sales@13 is not registered/);
    const env = { ...b.env, R4_PROD_LANE_PROFILE: LANE, R4_PROD_LANE_ALLOWLIST: `\n ${keyOf(OWNER)} \n ${keyOf(OTHER)},${keyOf(OWNER)}` };
    expect(salesGatewayLane(env, b.pool)?.conversationKeys).toEqual([keyOf(OWNER), keyOf(OTHER)]);
    await registerLaneDefinition(b.env);
    await b.redeployGateway({ allowlist: [OWNER], lane: [OWNER] });
    await b.customer(OWNER, 'wamid.l7b', 'Hola');
    expect(await versionOf(b, OWNER)).toBe(13);
  });

  it('L8: the lane worker never composes without Catalog V2 Discover', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], lane: [OWNER] }));
    const { catalog, shipping } = owners();
    const production = loadProductionConfig({ ...b.env, R4_PROD_POLICY_PROFILE: LANE });
    expect(() => composeSalesProductionWorker({ pool: b.pool, store: b.store, production, modelProvider: b.model, logger: createSilentLogger(), catalog, shipping })).toThrow(/requires Catalog V2 Discover/);
    // A Discover port without its key (or not on V2) is refused too, instead of failing every call later.
    const unconfigured: CatalogDiscoverPort = { discoverConfigured: false, discover: () => Promise.reject(new Error('never called')) };
    expect(() => composeSalesProductionWorker({ pool: b.pool, store: b.store, production, modelProvider: b.model, logger: createSilentLogger(), catalog, catalogDiscover: unconfigured, shipping })).toThrow(/requires Catalog V2 Discover/);
  });

  it('L9: with sales-production@3 as the gateway profile (production), only the lane conversation leaves it; @3 bindings keep the @3 fingerprint', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER, OTHER], lane: [OWNER], autonomy: true, env: { R4_PROD_POLICY_PROFILE: 'sales-production@3' } }));
    await b.customer(OWNER, 'wamid.l9a', 'Hola');
    await b.customer(OTHER, 'wamid.l9b', 'Hola');
    const rows = await b.rows<{ profile: string; profile_fingerprint: string }>('select profile, profile_fingerprint from channel_conversation_bindings order by created_at');
    expect(rows.map((r) => r.profile)).toEqual([LANE, 'sales-production@3']);
    expect(rows[1]!.profile_fingerprint).toBe(profileFingerprint(SALES_PRODUCTION_PROFILE_V3));
    expect(await versionOf(b, OWNER)).toBe(13);
    expect(await versionOf(b, OTHER)).toBe(4);
  });
});
