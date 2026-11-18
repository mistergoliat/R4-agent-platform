import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogDiscoverResponseSchema, type CatalogDiscoverAnswer, type CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { FixtureCatalog, FixtureQuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import { rolloutBucket, rolloutFingerprint } from '@r4/live-ops';
import { LiveOpsTestbed, OPERATOR, keyOf, registerLaneDefinition, say } from '../support/live-ops.js';
import { freezeTemporalClock } from '../support/temporal.js';

/**
 * ADR-045 amendment 1 — the lane serves its named conversations AND the rollout percentage cohort; everything else is
 * exactly as before. Invariants: 0 % changes nothing; a percentage > 0 needs the owner-approved cohort lane (@22);
 * one binding and one task per new cohort conversation, also under concurrent first messages; the main worker never
 * takes a cohort task; restarts and redeliveries never re-route or duplicate; an open binding keeps its profile,
 * autonomy and rollout fingerprint when the percentage changes (until its task ends), new conversations follow the new
 * percentage, and rollback to 0 % gives today's routing once open lane tasks end.
 *
 * C6 runs the real @22 lane worker and the 24 h case idle close (#97); C7 the kill switch. Claiming only the pinned
 * definition and draining after a configuration change are also covered by conversation-lane.test.ts L2/L3/L6 on @13.
 */
const OWNER = '56911110000';
const LANE = 'sales-production@22';
const MAIN = 'sales-production@1';

/** Synthetic wa_ids whose deterministic bucket (from the keyed conversation key) is in [from, to). */
function inBuckets(from: number, to: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count; i += 1) {
    const waId = `5690${String(i).padStart(7, '0')}`;
    const bucket = rolloutBucket(keyOf(waId));
    if (bucket >= from && bucket < to) out.push(waId);
  }
  return out;
}
// 20 % = buckets [0, 2000); 50 % = [0, 5000).
const [COHORT, COHORT2] = inBuckets(0, 2000, 2) as [string, string];
const [MID, MID2] = inBuckets(2000, 5000, 2) as [string, string];
const [OUT] = inBuckets(5000, 10_000, 1) as [string];

let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

const start = (percent: number, env: Record<string, string> = {}) => LiveOpsTestbed.start({ allowlist: [OWNER], lane: [OWNER], laneProfile: LANE, percent, autonomy: true, env });
const rollout = (percent: number) => ({ allowlist: [OWNER], lane: [OWNER], percent });

type BindingRow = { profile: string; status: string; autonomy: string; eligibility_reason: string; rollout_fingerprint: string; closed_reason: string | null; agent_version: number | null };
const bindingsOf = (b: LiveOpsTestbed, waId: string) => b.rows<BindingRow>(
  `select b.profile, b.status, b.autonomy, b.eligibility_reason, b.rollout_fingerprint, b.closed_reason, t.agent_version
     from channel_conversation_bindings b left join agent_tasks t on t.task_id = b.task_id where b.conversation_key = $1 order by b.created_at`, [keyOf(waId)]);
const routed = async (b: LiveOpsTestbed, waId: string) => {
  const open = (await bindingsOf(b, waId)).filter((r) => r.status === 'open');
  expect(open).toHaveLength(1);
  const { profile, autonomy, eligibility_reason, agent_version } = open[0]!;
  return { profile, autonomy, eligibility_reason, agent_version };
};
const disposition = async (b: LiveOpsTestbed, wamid: string) => (await b.rows<{ disposition: string }>('select disposition from inbound_events where provider_event_id = $1', [wamid]))[0]?.disposition;
const ON_LANE = (reason: string) => ({ profile: LANE, autonomy: 'autonomous', eligibility_reason: reason, agent_version: 22 });
const HELD_ON_MAIN = { profile: MAIN, autonomy: 'excluded', eligibility_reason: 'not_in_cohort', agent_version: 3 };

describe('ADR-045 amendment 1: the lane takes the rollout cohort', { timeout: 90_000 }, () => {
  it('C1: at 0 % nothing changes; at 20 % the cohort opens on the lane (reason cohort, current rollout fingerprint); the rest exactly as before', async () => {
    const b = (bed = await start(0));
    const atZero = rolloutFingerprint(b.production.config.rollout);
    await b.customer(OWNER, 'wamid.c1a', 'Hola');
    await b.customer(COHORT, 'wamid.c1b', 'Hola');
    expect(await routed(b, OWNER)).toEqual(ON_LANE('allowlisted'));
    expect(await routed(b, COHORT)).toEqual(HELD_ON_MAIN);
    expect(await disposition(b, 'wamid.c1b')).toBe('held:rollout_excluded');

    await b.redeployGateway(rollout(20));
    const atTwenty = rolloutFingerprint(b.production.config.rollout);
    expect(atTwenty).not.toBe(atZero);
    await b.customer(COHORT2, 'wamid.c1c', 'Hola');
    await b.customer(OUT, 'wamid.c1d', 'Hola');
    expect(await routed(b, COHORT2)).toEqual(ON_LANE('cohort'));
    expect((await bindingsOf(b, COHORT2))[0]!.rollout_fingerprint).toBe(atTwenty);
    expect(await disposition(b, 'wamid.c1c')).toBe('autonomous');
    expect(await routed(b, OUT)).toEqual(HELD_ON_MAIN);
    // The binding opened at 0 % keeps its profile, eligibility and fingerprint (never re-read from the configuration).
    await b.customer(COHORT, 'wamid.c1e', '¿Hola?');
    expect(await routed(b, COHORT)).toEqual(HELD_ON_MAIN);
    expect(await bindingsOf(b, COHORT)).toMatchObject([{ rollout_fingerprint: atZero }]);
  });

  it('C2: a percentage > 0 is refused without a lane and with a lane profile not approved for the cohort; 0 % without a lane starts as before', async () => {
    await expect(LiveOpsTestbed.start({ allowlist: [OWNER], percent: 20 })).rejects.toThrow(/without a lane would serve the cohort with the main profile/);
    await expect(LiveOpsTestbed.start({ allowlist: [OWNER], lane: [OWNER], percent: 20 })).rejects.toThrow(/lane profile sales-production@13, which is not approved for the rollout cohort/);
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], autonomy: true }));
    await b.customer(OWNER, 'wamid.c2a', 'Hola');
    expect(await routed(b, OWNER)).toEqual({ profile: MAIN, autonomy: 'autonomous', eligibility_reason: 'allowlisted', agent_version: 3 });
    // …and a running gateway is never redeployed into the refused state.
    await expect(b.redeployGateway({ allowlist: [OWNER], percent: 5 })).rejects.toThrow(/without a lane/);
  });

  it('C3: concurrent first messages (and redeliveries) of a new cohort conversation: one binding, one task pinned to the lane definition; the main worker never takes it', async () => {
    const b = (bed = await start(20));
    const main = await b.worker('main-worker');
    await Promise.all([
      b.customer(COHORT, 'wamid.c3a', 'Hola'), b.customer(COHORT, 'wamid.c3b', 'Busco una barra'), b.customer(COHORT, 'wamid.c3c', 'Para sentadilla'),
      b.customer(COHORT, 'wamid.c3a', 'Hola'), b.customer(COHORT, 'wamid.c3b', 'Busco una barra'),
    ]);
    expect(await bindingsOf(b, COHORT)).toMatchObject([{ ...ON_LANE('cohort'), status: 'open', closed_reason: null }]);
    expect(await b.rows('select agent_version, count(*)::int as n from agent_tasks group by 1')).toEqual([{ agent_version: 22, n: 1 }]);
    const taskId = await b.taskOf(COHORT);
    expect(await b.rows('select count(*)::int as n from task_inputs where task_id = $1', [taskId])).toEqual([{ n: 3 }]);
    expect(await b.runWorker(main)).toEqual([]);
    expect(await b.rows('select count(*)::int as n from agent_runs')).toEqual([{ n: 0 }]);
  });

  it('C4: recovery — redelivery and gateway restarts (also with another percentage) never re-route or duplicate', async () => {
    const b = (bed = await start(20));
    await b.customer(COHORT, 'wamid.c4a', 'Hola');
    const taskId = await b.taskOf(COHORT);
    expect((await b.customer(COHORT, 'wamid.c4a', 'Hola')).body).toMatchObject({ duplicates: 1, ingested: 0 });

    await b.redeployGateway(rollout(20));
    expect((await b.customer(COHORT, 'wamid.c4a', 'Hola')).body).toMatchObject({ duplicates: 1, ingested: 0 });
    await b.customer(COHORT, 'wamid.c4b', 'Sigo');
    expect(await b.taskOf(COHORT)).toBe(taskId);

    await b.redeployGateway(rollout(0));
    expect((await b.customer(COHORT, 'wamid.c4b', 'Sigo')).body).toMatchObject({ duplicates: 1, ingested: 0 });
    await b.customer(COHORT, 'wamid.c4c', '¿Hola?');
    expect(await b.taskOf(COHORT)).toBe(taskId);
    expect(await routed(b, COHORT)).toEqual(ON_LANE('cohort'));
    expect(await bindingsOf(b, COHORT)).toHaveLength(1);
    expect(await b.rows('select count(*)::int as n from agent_tasks')).toEqual([{ n: 1 }]);
    expect(await b.rows('select count(*)::int as n from task_inputs where task_id = $1', [taskId])).toEqual([{ n: 3 }]);
  });

  it('C5: percentage changes mid-task — open bindings stay autonomous on the lane, new conversations follow the new percentage; after rollback to 0 % a cancelled lane task gives today’s routing', async () => {
    const b = (bed = await start(50));
    const main = await b.worker('main-worker');
    await b.customer(MID, 'wamid.c5a', 'Hola');
    expect(await routed(b, MID)).toEqual(ON_LANE('cohort'));
    const midTask = await b.taskOf(MID);

    // Lowered to 20 %: MID (no longer in the cohort) keeps its lane task and its autonomy; a new MID2 is outside.
    await b.redeployGateway(rollout(20));
    await b.customer(MID, 'wamid.c5b', 'Sigo');
    expect(await b.taskOf(MID)).toBe(midTask);
    expect(await disposition(b, 'wamid.c5b')).toBe('autonomous');
    await b.customer(MID2, 'wamid.c5c', 'Hola');
    expect(await routed(b, MID2)).toEqual(HELD_ON_MAIN);
    await b.customer(COHORT, 'wamid.c5d', 'Hola');
    expect(await routed(b, COHORT)).toEqual(ON_LANE('cohort'));

    // Rollback to 0 %: no new conversation reaches the lane; the open lane task still takes autonomous input (for the
    // lane worker; the main worker never takes it). Lowering the percentage does NOT revoke its autonomy.
    await b.redeployGateway(rollout(0));
    await b.customer(COHORT2, 'wamid.c5e', 'Hola');
    expect(await routed(b, COHORT2)).toEqual(HELD_ON_MAIN);
    await b.customer(MID, 'wamid.c5f', '¿Me respondes?');
    expect(await disposition(b, 'wamid.c5f')).toBe('autonomous');
    expect(await routed(b, MID)).toEqual(ON_LANE('cohort'));
    expect(await b.runWorker(main)).toEqual([]);

    // The targeted cut (runbook): cancel the open cohort task; the next message is routed as today.
    await b.api.temporal.cancelTask(midTask, OPERATOR);
    await b.customer(MID, 'wamid.c5g', 'Hola de nuevo');
    expect((await bindingsOf(b, MID)).map((r) => [r.profile, r.status, r.closed_reason])).toEqual([[LANE, 'closed', 'task_cancelled'], [MAIN, 'open', null]]);
    expect(await routed(b, MID)).toEqual(HELD_ON_MAIN);
    expect(await disposition(b, 'wamid.c5g')).toBe('held:rollout_excluded');
  });
});

const fixtures = JSON.parse(readFileSync(new URL('../../adapters/domains/catalog/http/fixtures/discover/catalog-discover.fixtures.v1b1.json', import.meta.url), 'utf8')) as { answers: { httpStatus: number; response: unknown }[] };
const ANSWER: CatalogDiscoverAnswer = catalogDiscoverResponseSchema.parse(fixtures.answers.find((a) => a.httpStatus === 200)!.response);
/** Stand-ins for the owners of the @22 quote lane (never called by these scripted turns). */
function owners() {
  const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.resolve(ANSWER) };
  const shipping: ShippingService & { bindingKind: string } = { bindingKind: 'http', quote: () => Promise.reject(new Error('not used')) };
  return { catalog: Object.assign(new FixtureCatalog(), { bindingKind: 'real' }), discover, shipping, quotes: Object.assign(new FixtureQuoteV2Service(), { bindingKind: 'http' }) };
}
const DAY = 24 * 3_600_000;
async function idleFor(b: LiveOpsTestbed, ms: number): Promise<void> {
  const [row] = await b.rows<{ at: Date }>('select max(received_at) as at from task_inputs');
  await freezeTemporalClock(b.pool, new Date(row!.at.getTime() + ms));
}

describe('ADR-045 amendment 1: cohort lifecycle on @22', { timeout: 90_000 }, () => {
  it('C6: a cohort binding keeps @22 after a rollback to 0 % until its task ends; the 24 h case idle close (#97) ends it, and the next message follows the current percentage', async () => {
    const b = (bed = await start(20, { R4_PROD_CASE_IDLE_CLOSE_HOURS: '24' }));
    const lane = await b.laneWorker(owners(), 'lane-worker-1', LANE);
    const main = await b.worker('main-worker');
    await b.customer(COHORT, 'wamid.c6a', 'Hola');
    const taskId = await b.taskOf(COHORT);
    b.next(say('Hola, ¿qué buscas?'));
    expect((await b.runWorker(lane)).length).toBeGreaterThan(0);
    expect(await b.runWorker(main)).toEqual([]);
    await b.deliver();
    expect((await b.store.outboundForTask(taskId)).length).toBe(1);
    expect((await b.rows<{ status: string }>('select status from agent_tasks where task_id = $1', [taskId]))[0]!.status).toBe('waiting');

    await b.redeployGateway(rollout(0));
    await idleFor(b, DAY - 60_000);
    expect((await b.gateway.idleClose!.sweep()).closed).toBe(0);
    expect(await routed(b, COHORT)).toEqual(ON_LANE('cohort'));

    await idleFor(b, DAY);
    expect((await b.gateway.idleClose!.sweep()).closed).toBe(1);
    expect((await bindingsOf(b, COHORT)).map((r) => [r.profile, r.status, r.closed_reason])).toEqual([[LANE, 'closed', 'idle_timeout']]);
    await b.customer(COHORT, 'wamid.c6b', 'Hola de nuevo');
    expect(await routed(b, COHORT)).toEqual(HELD_ON_MAIN);
    expect(await disposition(b, 'wamid.c6b')).toBe('held:rollout_excluded');
    expect(await b.runWorker(lane)).toEqual([]);
  });

  it('C7: the kill switch holds cohort conversations exactly like allowlisted ones, and releasing it resumes both on the lane', async () => {
    const b = (bed = await start(20));
    await b.customer(OWNER, 'wamid.c7a', 'Hola');
    await b.customer(COHORT, 'wamid.c7b', 'Hola');
    await b.setAutonomy(false);
    await b.customer(OWNER, 'wamid.c7c', '¿Sigues?');
    await b.customer(COHORT, 'wamid.c7d', '¿Sigues?');
    await b.customer(COHORT2, 'wamid.c7e', 'Hola');
    expect([await disposition(b, 'wamid.c7c'), await disposition(b, 'wamid.c7d'), await disposition(b, 'wamid.c7e')]).toEqual(['held:autonomy_disabled', 'held:autonomy_disabled', 'held:autonomy_disabled']);
    // Held, not re-routed: a conversation opened while engaged is still a cohort binding on the lane.
    expect(await routed(b, COHORT2)).toEqual(ON_LANE('cohort'));
    const status = async (waId: string) => (await b.rows<{ status: string; status_reason: string | null }>('select status, status_reason from agent_tasks where task_id = $1', [await b.taskOf(waId)]))[0];
    expect(await status(COHORT)).toEqual(await status(OWNER));
  });

  it('C8: lane rollback @22 → @21 with the percentage still > 0 (owner decision 2026-11-18): the gateway starts, open @22 bindings keep their task, new cohort conversations open on @21', async () => {
    const b = (bed = await start(20));
    await b.customer(COHORT, 'wamid.c8a', 'Hola');
    const task22 = await b.taskOf(COHORT);
    // As a deployment: the rollback definition is registered, then the gateway is redeployed with it.
    await registerLaneDefinition(b.env, 'sales-production@21');
    await b.redeployGateway({ ...rollout(20), laneProfile: 'sales-production@21' });
    await b.customer(COHORT, 'wamid.c8b', 'Sigo');
    expect(await b.taskOf(COHORT)).toBe(task22);
    expect(await routed(b, COHORT)).toEqual(ON_LANE('cohort'));
    await b.customer(COHORT2, 'wamid.c8c', 'Hola');
    expect(await routed(b, COHORT2)).toEqual({ profile: 'sales-production@21', autonomy: 'autonomous', eligibility_reason: 'cohort', agent_version: 21 });
  });
});
