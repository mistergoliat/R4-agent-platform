import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogDiscoverResponseSchema, type CatalogDiscoverAnswer, type CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { DomainError, FixtureCatalog, type ShippingService } from '@r4-adapters/domains';
import { rolloutBucket } from '@r4/live-ops';
import { LiveOpsTestbed, OPERATOR, keyOf, say } from '../support/live-ops.js';

/**
 * ADR-045 + rollout cohort — the lane serves its named conversations AND the rollout percentage cohort; everything else
 * is exactly as before. Invariants: 0 % changes nothing; one binding and one task per new cohort conversation, also
 * under concurrent first messages; only the lane worker runs cohort tasks; restarts and redeliveries never re-route or
 * duplicate; an open binding keeps its profile and autonomy when the percentage changes (until its task ends), new
 * conversations follow the new percentage, and rollback to 0 % gives today's routing once open lane tasks end.
 */
const OWNER = '56911110000';
const LANE = 'sales-production@13';
const MAIN = 'sales-production@1';

/** Synthetic wa_ids whose deterministic bucket (from the keyed conversation key) is in [from, to). */
function inBuckets(from: number, to: number, count: number, skip: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count; i += 1) {
    const waId = `5690${String(i).padStart(7, '0')}`;
    const bucket = rolloutBucket(keyOf(waId));
    if (bucket >= from && bucket < to && !skip.includes(waId)) out.push(waId);
  }
  return out;
}
// 20 % = buckets [0, 2000); 50 % = [0, 5000).
const [COHORT, COHORT2] = inBuckets(0, 2000, 2) as [string, string];
const [MID, MID2] = inBuckets(2000, 5000, 2) as [string, string];
const [OUT] = inBuckets(5000, 10_000, 1) as [string];

const fixtures = JSON.parse(readFileSync(new URL('../../adapters/domains/catalog/http/fixtures/discover/catalog-discover.fixtures.v1b1.json', import.meta.url), 'utf8')) as { answers: { httpStatus: number; response: unknown }[] };
const ANSWER: CatalogDiscoverAnswer = catalogDiscoverResponseSchema.parse(fixtures.answers.find((a) => a.httpStatus === 200)!.response);
function owners() {
  const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.resolve(ANSWER) };
  const shipping: ShippingService & { bindingKind: string } = { bindingKind: 'http', quote: () => Promise.reject(new DomainError('temporarily_unavailable', 'not_in_test', 'not used')) };
  return { catalog: Object.assign(new FixtureCatalog(), { bindingKind: 'real' }), discover, shipping };
}

let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

type BindingRow = { profile: string; status: string; autonomy: string; eligibility_reason: string; closed_reason: string | null; agent_version: number | null };
const bindingsOf = (b: LiveOpsTestbed, waId: string) => b.rows<BindingRow>(
  `select b.profile, b.status, b.autonomy, b.eligibility_reason, b.closed_reason, t.agent_version
     from channel_conversation_bindings b left join agent_tasks t on t.task_id = b.task_id where b.conversation_key = $1 order by b.created_at`, [keyOf(waId)]);
const routed = async (b: LiveOpsTestbed, waId: string) => {
  const rows = await bindingsOf(b, waId);
  const open = rows.filter((r) => r.status === 'open');
  expect(open).toHaveLength(1);
  const { profile, autonomy, eligibility_reason, agent_version } = open[0]!;
  return { profile, autonomy, eligibility_reason, agent_version };
};
const disposition = async (b: LiveOpsTestbed, wamid: string) => (await b.rows<{ disposition: string }>('select disposition from inbound_events where provider_event_id = $1', [wamid]))[0]?.disposition;
const ON_LANE = (reason: string) => ({ profile: LANE, autonomy: 'autonomous', eligibility_reason: reason, agent_version: 13 });
const HELD_ON_MAIN = { profile: MAIN, autonomy: 'excluded', eligibility_reason: 'not_in_cohort', agent_version: 3 };

describe('ADR-045 lane takes the rollout cohort', () => {
  it('C1: at 0 % nothing changes; at 20 % the cohort opens on the lane (reason cohort), the rest exactly as before', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], lane: [OWNER], autonomy: true }));
    await b.customer(OWNER, 'wamid.c1a', 'Hola');
    await b.customer(COHORT, 'wamid.c1b', 'Hola');
    expect(await routed(b, OWNER)).toEqual(ON_LANE('allowlisted'));
    expect(await routed(b, COHORT)).toEqual(HELD_ON_MAIN);
    expect(await disposition(b, 'wamid.c1b')).toBe('held:rollout_excluded');

    await b.redeployGateway({ allowlist: [OWNER], lane: [OWNER], percent: 20 });
    await b.customer(COHORT2, 'wamid.c1c', 'Hola');
    await b.customer(OUT, 'wamid.c1d', 'Hola');
    expect(await routed(b, COHORT2)).toEqual(ON_LANE('cohort'));
    expect(await disposition(b, 'wamid.c1c')).toBe('autonomous');
    expect(await routed(b, OUT)).toEqual(HELD_ON_MAIN);
    // The binding opened at 0 % keeps its profile and eligibility (it is never re-read from the configuration).
    await b.customer(COHORT, 'wamid.c1e', '¿Hola?');
    expect(await routed(b, COHORT)).toEqual(HELD_ON_MAIN);
    expect(await bindingsOf(b, COHORT)).toHaveLength(1);
  });

  it('C2: without a lane, the cohort is served by the main profile, exactly as before', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], percent: 20, autonomy: true }));
    await b.customer(COHORT, 'wamid.c2a', 'Hola');
    expect(await routed(b, COHORT)).toEqual({ profile: MAIN, autonomy: 'autonomous', eligibility_reason: 'cohort', agent_version: 3 });
  });

  it('C3: concurrent first messages (and redeliveries) of a new cohort conversation: one binding, one v13 task, one run by the lane worker only', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], lane: [OWNER], percent: 20, autonomy: true }));
    const lane = await b.laneWorker(owners());
    const main = await b.worker('main-worker');
    await Promise.all([
      b.customer(COHORT, 'wamid.c3a', 'Hola'), b.customer(COHORT, 'wamid.c3b', 'Busco una barra'), b.customer(COHORT, 'wamid.c3c', 'Para sentadilla'),
      b.customer(COHORT, 'wamid.c3a', 'Hola'), b.customer(COHORT, 'wamid.c3b', 'Busco una barra'),
    ]);
    expect(await bindingsOf(b, COHORT)).toEqual([{ ...ON_LANE('cohort'), status: 'open', closed_reason: null }]);
    expect(await b.rows('select agent_version, count(*)::int as n from agent_tasks group by 1')).toEqual([{ agent_version: 13, n: 1 }]);
    const taskId = await b.taskOf(COHORT);
    expect(await b.rows('select count(*)::int as n from task_inputs where task_id = $1', [taskId])).toEqual([{ n: 3 }]);

    b.next(say('Hola, ¿qué buscas?'));
    const [laneCycles, mainCycles] = await Promise.all([b.runWorker(lane), b.runWorker(main)]);
    await b.deliver();
    expect(laneCycles.length).toBeGreaterThan(0);
    expect(mainCycles).toEqual([]);
    expect(await b.rows('select count(*)::int as n from agent_runs where task_id = $1', [taskId])).toEqual([{ n: 1 }]);
    expect(b.provider.sends.length).toBe(1);
    expect(await b.runWorker(main)).toEqual([]);
  });

  it('C4: recovery — redelivery and gateway restarts (also with another percentage) never re-route or duplicate', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], lane: [OWNER], percent: 20, autonomy: true }));
    await b.customer(COHORT, 'wamid.c4a', 'Hola');
    const taskId = await b.taskOf(COHORT);
    expect((await b.customer(COHORT, 'wamid.c4a', 'Hola')).body).toMatchObject({ duplicates: 1, ingested: 0 });

    await b.redeployGateway({ allowlist: [OWNER], lane: [OWNER], percent: 20 });
    expect((await b.customer(COHORT, 'wamid.c4a', 'Hola')).body).toMatchObject({ duplicates: 1, ingested: 0 });
    await b.customer(COHORT, 'wamid.c4b', 'Sigo');
    expect(await b.taskOf(COHORT)).toBe(taskId);

    await b.redeployGateway({ allowlist: [OWNER], lane: [OWNER], percent: 0 });
    expect((await b.customer(COHORT, 'wamid.c4b', 'Sigo')).body).toMatchObject({ duplicates: 1, ingested: 0 });
    await b.customer(COHORT, 'wamid.c4c', '¿Hola?');
    expect(await b.taskOf(COHORT)).toBe(taskId);
    expect(await routed(b, COHORT)).toEqual(ON_LANE('cohort'));
    expect(await bindingsOf(b, COHORT)).toHaveLength(1);
    expect(await b.rows('select count(*)::int as n from agent_tasks')).toEqual([{ n: 1 }]);
    expect(await b.rows('select count(*)::int as n from task_inputs where task_id = $1', [taskId])).toEqual([{ n: 3 }]);
  });

  it('C5: percentage changes mid-task — open bindings stay, new conversations follow the new percentage; rollback to 0 % drains to today’s routing', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [OWNER], lane: [OWNER], percent: 50, autonomy: true }));
    const lane = await b.laneWorker(owners());
    await b.customer(MID, 'wamid.c5a', 'Hola');
    expect(await routed(b, MID)).toEqual(ON_LANE('cohort'));
    const midTask = await b.taskOf(MID);

    // Lowered to 20 %: MID (no longer in the cohort) keeps its lane task and its autonomy; a new MID2 is outside.
    await b.redeployGateway({ allowlist: [OWNER], lane: [OWNER], percent: 20 });
    await b.customer(MID, 'wamid.c5b', 'Sigo');
    expect(await b.taskOf(MID)).toBe(midTask);
    expect(await disposition(b, 'wamid.c5b')).toBe('autonomous');
    await b.customer(MID2, 'wamid.c5c', 'Hola');
    expect(await routed(b, MID2)).toEqual(HELD_ON_MAIN);
    await b.customer(COHORT, 'wamid.c5d', 'Hola');
    expect(await routed(b, COHORT)).toEqual(ON_LANE('cohort'));

    // Rollback to 0 %: no new conversation reaches the lane; the open lane tasks are still answered by the lane worker.
    await b.redeployGateway({ allowlist: [OWNER], lane: [OWNER], percent: 0 });
    await b.customer(COHORT2, 'wamid.c5e', 'Hola');
    expect(await routed(b, COHORT2)).toEqual(HELD_ON_MAIN);
    await b.customer(MID, 'wamid.c5f', '¿Me respondes?');
    expect(await disposition(b, 'wamid.c5f')).toBe('autonomous');
    b.next(say('Hola.'), say('Hola.'));
    await b.runWorker(lane);
    await b.deliver();
    expect((await b.store.outboundForTask(midTask)).length).toBe(1);
    expect((await b.store.outboundForTask(await b.taskOf(COHORT))).length).toBe(1);

    // Once its task ends (here: the operator cancels it, as in the ADR-045 runbook), the conversation is routed as today.
    await b.api.temporal.cancelTask(midTask, OPERATOR);
    await b.customer(MID, 'wamid.c5g', 'Hola de nuevo');
    expect((await bindingsOf(b, MID)).map((r) => [r.profile, r.status, r.closed_reason])).toEqual([[LANE, 'closed', 'task_cancelled'], [MAIN, 'open', null]]);
    expect(await routed(b, MID)).toEqual(HELD_ON_MAIN);
    expect(await disposition(b, 'wamid.c5g')).toBe('held:rollout_excluded');
    expect(await b.runWorker(lane)).toEqual([]);
  });
});
