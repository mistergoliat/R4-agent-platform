import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_PRODUCTS, FixtureCatalog, type CatalogPort } from '@r4-adapters/domains';
import { SALES_RUN_FAILURE_FALLBACK_TEXT } from '@r4-sales/agent/production';
import { LiveOpsTestbed, complete, say, waitInput } from '../support/live-ops.js';

/**
 * R4-J4-R7-2 — Turn Completion Guard and durable steering (runtime suite).
 *
 * The model is SCRIPTED: these tests prove what the platform does with any
 * decision the model could make (structure, persistence, bounds), never how
 * a real model interprets a message — that is the G-sem suite's (separate
 * authorization). The same customer texts appear with both branches to show
 * the runtime never reads them: the outcome depends on durable facts only.
 *
 * Scenario ids refer to R4_J4_R7_TEST_PLAN.md §3.2, §3.4 and §3.6.
 */

const CUSTOMER = '56933334444';
const OTHER = '56933335555';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

const start = async (options: { catalog?: CatalogPort } = {}) =>
  (bed = await LiveOpsTestbed.start({
    allowlist: [CUSTOMER, OTHER],
    autonomy: true,
    ...(options.catalog ? { env: { R4_PROD_POLICY_PROFILE: 'sales-production@2' }, catalog: Object.assign(options.catalog, { bindingKind: 'real' }) } : {}),
  }));
const waitUntil = (until: string) => ({ type: 'structured' as const, data: { type: 'wait', condition: { kind: 'WAIT_UNTIL', until }, reason: 'later' } });
const focusUnknownGoal = () => ({ type: 'structured' as const, data: { type: 'manage_goal', change: { operation: 'focus', goalId: '00000000-0000-4000-8000-000000000000' } } });

interface RunRow { run_id: string; status: string; termination_reason: string; termination_code: string; details: Record<string, unknown> | null }
interface EventRow { event_id: string; entity_id: string; data: Record<string, unknown> }
const runs = (b: LiveOpsTestbed, taskId: string) =>
  b.rows<RunRow>('select run_id, status, termination_reason, termination_code, termination_details as details from agent_runs where task_id = $1 order by sequence', [taskId]);
const task = async (b: LiveOpsTestbed, taskId: string) => (await b.rows<{ status: string; status_reason: string }>('select status, status_reason from agent_tasks where task_id = $1', [taskId]))[0];
const events = (b: LiveOpsTestbed, taskId: string, type: string) =>
  b.rows<EventRow>('select event_id, entity_id, data from temporal_events where task_id = $1 and event_type = $2 order by occurred_at, event_id', [taskId, type]);
const steps = (b: LiveOpsTestbed, runId: string) =>
  b.rows<{ step_id: string; decision_type: string; outcome: string; error_code: string | null }>('select step_id, decision_type, outcome, error_code from agent_run_steps where run_id = $1 order by iteration', [runId]);
const outbound = (b: LiveOpsTestbed, taskId: string) => b.rows<{ origin: string; status: string }>('select origin, status from outbound_messages where task_id = $1 order by created_at', [taskId]);
const input = async (b: LiveOpsTestbed, providerId: string) =>
  (await b.rows<{ input_id: string; memory_entry_id: string; task_id: string }>(
    'select i.input_id, i.memory_entry_id, i.task_id from inbound_events e join task_inputs i on i.input_id = e.input_id where e.provider_event_id = $1', [providerId]))[0]!;
/** Every item a run's snapshots evaluated, with the decision (included / excluded). */
const snapshotItems = async (b: LiveOpsTestbed, runId: string) =>
  new Map((await b.rows<{ item_id: string; decision: string }>(
    'select i.item_id, i.decision from context_snapshot_items i join context_snapshots s on s.snapshot_id = i.snapshot_id where s.run_id = $1', [runId])).map((r) => [r.item_id, r.decision]));
/** The steering ledger (R4_J4_R7_DESIGN, annex A): inputs a run incorporated after it started, and at which iteration. */
const steeringLedger = (b: LiveOpsTestbed, taskId: string) =>
  b.rows<{ sequence: number; input_id: string; iteration: number }>(
    `select r.sequence, i.input_id, min(cs.iteration)::int as iteration
       from agent_runs r
       join task_inputs i on i.task_id = r.task_id and i.actor_kind = 'user' and i.received_at >= r.started_at and (r.finished_at is null or i.received_at <= r.finished_at)
       join context_snapshots cs on cs.run_id = r.run_id
       join context_snapshot_items it on it.snapshot_id = cs.snapshot_id and it.item_id = 'memory:' || i.memory_entry_id::text
      where r.task_id = $1 group by r.sequence, i.input_id order by r.sequence`, [taskId]);

/** A first reply already accepted, then `text`: the conversation state of a social closing. */
async function afterReply(b: LiveOpsTestbed, from: string, prefix: string, text: string): Promise<string> {
  await b.customer(from, `${prefix}-1`, '¿Tienen discos de 20 kg?');
  b.next(say('Sí, tenemos discos de 20 kg a $45.990 cada uno.'));
  await b.runAgent();
  await b.deliver();
  await b.customer(from, `${prefix}-2`, text);
  return b.taskOf(from);
}

describe('Turn Completion Guard: complete (F4)', () => {
  it('S20 + S29 + S36: complete facing a request is deferred once; the next run sees an episode naming the input, and replies', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r72-20a', 'Necesito cotizar un rack');
    const taskId = await b.taskOf(CUSTOMER);
    let shown = '';
    b.next(complete(), (request) => {
      shown = JSON.stringify(request.context);
      return say('Claro. ¿Para qué peso máximo y qué altura necesitas el rack?');
    });
    await b.runAgent();
    await b.deliver();
    const { input_id: inputId, memory_entry_id: memoryEntryId } = await input(b, 'wamid.r72-20a');
    const [first, second] = await runs(b, taskId);
    // The run ends as the model decided; the task does not follow it.
    expect(first).toMatchObject({ status: 'completed', termination_reason: 'completed', details: { turnGuard: { outcome: 'deferred', code: 'turn_reply_pending', inputId } } });
    expect(second).toMatchObject({ status: 'suspended', termination_reason: 'waiting' });
    expect(await task(b, taskId)).toEqual({ status: 'waiting', status_reason: 'waiting' });
    const [reconsider, ...more] = await events(b, taskId, 'turn.closure.reconsider');
    expect(more).toEqual([]);
    // S36: the reconsideration identifies the input: id, memory item (the conversation item the model has) and arrival.
    expect(reconsider).toMatchObject({ entity_id: inputId, data: { decision: 'complete', code: 'turn_reply_pending', memoryItemId: `memory:${memoryEntryId}`, stepId: (await steps(b, first!.run_id))[0]!.step_id } });
    expect(typeof reconsider!.data.receivedAt).toBe('string');
    // S29: the episode is INCLUDED in the next run's snapshot, next to the input it names.
    const items = await snapshotItems(b, second!.run_id);
    expect(items.get(`turn_closure:${reconsider!.event_id}`)).toBe('included');
    expect(items.get(`memory:${memoryEntryId}`)).toBe('included');
    expect(shown).toContain('turn.closure.reconsider');
    expect(await events(b, taskId, 'turn.closed_without_reply')).toEqual([]);
    expect(await outbound(b, taskId)).toEqual([{ origin: 'agent', status: 'accepted' }]);
  });

  it('S21 + S37: complete twice on the same frontier is accepted as the same model\'s ratification, recorded (never as a verification)', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r72-21a', 'Necesito cotizar un rack');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(complete(), complete());
    await b.runAgent();
    const { input_id: inputId } = await input(b, 'wamid.r72-21a');
    const [first, second] = await runs(b, taskId);
    expect(await task(b, taskId)).toMatchObject({ status: 'completed' });
    const [reconsider] = await events(b, taskId, 'turn.closure.reconsider');
    const closed = await events(b, taskId, 'turn.closed_without_reply');
    expect(closed).toEqual([{
      event_id: expect.any(String),
      entity_id: inputId,
      data: {
        basis: 'model_ratification', decision: 'complete', policy: 'closure.v1', reconsiderEventId: reconsider!.event_id,
        stepIds: [(await steps(b, first!.run_id))[0]!.step_id, (await steps(b, second!.run_id))[0]!.step_id],
        hadPriorReply: false, trailingCount: 1,
      },
    }]);
    // The documented residue (B1): the runtime accepts an explicit silence; whether it was right is G-sem's question.
    expect(JSON.stringify(closed)).not.toMatch(/verif/i);
    expect(await outbound(b, taskId)).toEqual([]);
  });

  it('S22: complete with an input the deciding call never saw is deferred without reconsideration; the next run answers both', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r72-22a', 'Hola, busco discos');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(async () => (await b.customer(CUSTOMER, 'wamid.r72-22b', 'De 20 kg, por favor'), complete()), say('Tenemos discos de 20 kg a $45.990.'));
    await b.runAgent();
    await b.deliver();
    const late = await input(b, 'wamid.r72-22b');
    const [first, second] = await runs(b, taskId);
    expect(first).toMatchObject({ status: 'completed', details: { turnGuard: { outcome: 'deferred', code: 'turn_input_unseen', inputId: late.input_id } } });
    expect(await events(b, taskId, 'turn.closure.reconsider')).toEqual([]);
    const items = await snapshotItems(b, second!.run_id);
    expect(items.get(`memory:${(await input(b, 'wamid.r72-22a')).memory_entry_id}`)).toBe('included');
    expect(items.get(`memory:${late.memory_entry_id}`)).toBe('included');
    expect(await task(b, taskId)).toMatchObject({ status: 'waiting' });
    expect(await outbound(b, taskId)).toEqual([{ origin: 'agent', status: 'accepted' }]);
  });

  it('S28: an open human request (forced by fixture) refuses the completion as a platform contingency, never completed', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r72-28a', 'Gracias, eso es todo');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(async () => {
      const [run] = await b.rows<{ run_id: string }>(`select run_id from agent_runs where task_id = $1 and status = 'running'`, [taskId]);
      await b.rows(
        `insert into human_requests (request_id, task_id, run_id, kind, status, payload, created_at, updated_at, correlation_id)
         values (gen_random_uuid(), $1, $2, 'consultation', 'requested', '{"question":"¿Plazo?","contextRefs":[]}', now(), now(), 'r72-28')`, [taskId, run!.run_id]);
      return complete();
    });
    await b.runAgent();
    await b.deliver();
    expect(await task(b, taskId)).toEqual({ status: 'blocked', status_reason: 'run_internal_failure' });
    expect(await runs(b, taskId)).toEqual([expect.objectContaining({ status: 'failed', termination_reason: 'internal_failure', termination_code: 'ending_refused', details: expect.objectContaining({ refusedReason: 'completed' }) })]);
    expect(b.provider.sends.map((s) => s.text)).toEqual([SALES_RUN_FAILURE_FALLBACK_TEXT]);
  });
});

describe('Turn Completion Guard: agent wait (F3)', () => {
  it('S23: «Ok, gracias» closed by wait, wait — refused once, then ratified; the conversation stays on the same task', async () => {
    const b = await start();
    const taskId = await afterReply(b, CUSTOMER, 'wamid.r72-23', 'Ok, gracias');
    b.next(waitInput(), waitInput());
    await b.runAgent();
    const { input_id: inputId } = await input(b, 'wamid.r72-23-2');
    const [, second] = await runs(b, taskId);
    const [refused, accepted] = await steps(b, second!.run_id);
    expect([refused, accepted].map((s) => [s!.decision_type, s!.outcome, s!.error_code])).toEqual([['wait', 'refused', 'turn_reply_pending'], ['wait', 'recorded', null]]);
    expect(await task(b, taskId)).toMatchObject({ status: 'waiting' });
    expect((await events(b, taskId, 'turn.closure.reconsider')).map((e) => e.entity_id)).toEqual([inputId]);
    expect(await events(b, taskId, 'turn.closed_without_reply')).toEqual([
      expect.objectContaining({ entity_id: inputId, data: expect.objectContaining({ basis: 'model_ratification', decision: 'wait', stepIds: [refused!.step_id, accepted!.step_id], hadPriorReply: true }) }),
    ]);
    expect(await b.taskOf(CUSTOMER)).toBe(taskId);
    expect(await outbound(b, taskId)).toHaveLength(1);
  });

  it('S24: wait then complete on the same frontier is one ratification (different decisions, same input)', async () => {
    const b = await start();
    const taskId = await afterReply(b, CUSTOMER, 'wamid.r72-24', 'Muchas gracias, eso sería todo');
    b.next(waitInput(), complete());
    await b.runAgent();
    expect(await task(b, taskId)).toMatchObject({ status: 'completed' });
    expect((await events(b, taskId, 'turn.closed_without_reply')).map((e) => e.data.decision)).toEqual(['complete']);
  });

  it('S25: a reply covers the input: no reconsideration, no closing event', async () => {
    const b = await start();
    const taskId = await afterReply(b, CUSTOMER, 'wamid.r72-25', 'Ok, gracias');
    b.next(say('¡A ti! Quedo atento.'));
    await b.runAgent();
    expect(await events(b, taskId, 'turn.closure.reconsider')).toEqual([]);
    expect(await events(b, taskId, 'turn.closed_without_reply')).toEqual([]);
  });

  it('S27 (invalid wait): waiting for input while a question is unanswered (no continuation but the customer) is refused; the model then replies', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r72-27a', '¿Tienen garantía extendida?');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(waitInput(), say('Sí, 12 meses en máquinas.'));
    await b.runAgent();
    await b.deliver();
    const [run] = await runs(b, taskId);
    expect((await steps(b, run!.run_id)).map((s) => [s.decision_type, s.outcome])).toEqual([['wait', 'refused'], ['respond', 'recorded'], ['wait', 'recorded']]);
    expect(await outbound(b, taskId)).toEqual([{ origin: 'agent', status: 'accepted' }]);
    expect(await events(b, taskId, 'turn.closed_without_reply')).toEqual([]);
  });

  it('temporal wait: WAIT_UNTIL is not a closing — accepted without reconsideration, covers nothing, and the next closing still faces the input', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r72-tw', 'Avísame cuando llegue el stock del rack');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(waitUntil('2099-01-01T00:00:00.000Z'));
    await b.runAgent();
    expect(await task(b, taskId)).toMatchObject({ status: 'waiting' });
    expect(await b.rows(`select kind, status from schedules where task_id = $1 and kind = 'wake'`, [taskId])).toEqual([{ kind: 'wake', status: 'pending' }]);
    expect(await events(b, taskId, 'turn.closure.reconsider')).toEqual([]);
    expect(await events(b, taskId, 'turn.closed_without_reply')).toEqual([]);
    // When it resumes (here: an operator-visible platform input), a silent WAIT_FOR_INPUT on the same input is reconsidered.
    await b.api.temporal.submitInput(taskId, { externalKey: 'marker-tw', content: 'identity verified', sourceRef: 'identity-verification', occurredAt: new Date().toISOString() }, { kind: 'system', ref: 'identity-verification' }, 'r72-tw');
    b.next(waitInput(), say('Te aviso apenas llegue.'));
    await b.runAgent();
    expect((await events(b, taskId, 'turn.closure.reconsider')).map((e) => e.entity_id)).toEqual([(await input(b, 'wamid.r72-tw')).input_id]);
  });

  it('S26: a new frontier after a ratified closing needs its own reconsideration; the old closing covers only its input', async () => {
    const b = await start();
    const taskId = await afterReply(b, CUSTOMER, 'wamid.r72-26', 'Ok, gracias');
    b.next(waitInput(), waitInput());
    await b.runAgent();
    await b.customer(CUSTOMER, 'wamid.r72-26-3', 'Una cosa más: ¿hacen envíos a regiones?');
    b.next(waitInput(), say('Sí, despachamos a todo Chile.'));
    await b.runAgent();
    const [l, l2] = [await input(b, 'wamid.r72-26-2'), await input(b, 'wamid.r72-26-3')];
    expect((await events(b, taskId, 'turn.closure.reconsider')).map((e) => e.entity_id)).toEqual([l.input_id, l2.input_id]);
    expect((await events(b, taskId, 'turn.closed_without_reply')).map((e) => e.entity_id)).toEqual([l.input_id]);
  });

  it('S35: an input arriving between the reconsideration and the second closing voids the ratification (G0 condition 3)', async () => {
    const b = await start();
    const taskId = await afterReply(b, CUSTOMER, 'wamid.r72-35', 'Perfecto');
    b.next(waitInput(), async () => (await b.customer(CUSTOMER, 'wamid.r72-35-3', 'Mejor que sean dos discos'), waitInput()));
    await b.runAgent(1);
    // The second wait saw neither the new input nor a ratifiable frontier: applied, then woken at once (UNSEEN, F3).
    expect(await events(b, taskId, 'turn.closed_without_reply')).toEqual([]);
    expect(await task(b, taskId)).toMatchObject({ status: 'running' });
    b.next(waitInput(), say('Perfecto, dos discos de 20 kg: $91.980.'));
    await b.runAgent();
    const [l, l2] = [await input(b, 'wamid.r72-35-2'), await input(b, 'wamid.r72-35-3')];
    expect((await events(b, taskId, 'turn.closure.reconsider')).map((e) => e.entity_id)).toEqual([l.input_id, l2.input_id]);
    expect(await events(b, taskId, 'turn.closed_without_reply')).toEqual([]);
    expect(await task(b, taskId)).toMatchObject({ status: 'waiting' });
  });

  it('S33: the identity marker (a system input) creates no obligation', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r72-33a', '¿Tienen discos de 20 kg?');
    b.next(say('Sí, a $45.990.'));
    await b.runAgent();
    const taskId = await b.taskOf(CUSTOMER);
    await b.api.temporal.submitInput(taskId, { externalKey: 'marker-1', content: 'identity verified', sourceRef: 'identity-verification', occurredAt: new Date().toISOString() }, { kind: 'system', ref: 'identity-verification' }, 'r72-33');
    b.next(waitInput());
    await b.runAgent();
    expect(await task(b, taskId)).toMatchObject({ status: 'waiting' });
    expect(await events(b, taskId, 'turn.closure.reconsider')).toEqual([]);
  });

  it('INV-D4: a reply the delivery gate discarded (expired) covers nothing: a later silent wait on that input is reconsidered', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, env: { R4_PROD_OUTBOUND_MAX_AGE_MS: '1000' } }));
    await b.customer(CUSTOMER, 'wamid.r72-d4a', '¿Tienen discos de 20 kg?');
    b.next(say('Sí, a $45.990.'));
    await b.runAgent();
    await b.gateway.delivery.materialize();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await b.deliver();
    const taskId = await b.taskOf(CUSTOMER);
    expect(await b.rows('select cancel_reason from outbound_messages where task_id = $1', [taskId])).toEqual([{ cancel_reason: 'expired' }]);
    // A platform input (not conversational) wakes the task; the agent closes silently on the unanswered question.
    await b.api.temporal.submitInput(taskId, { externalKey: 'marker-d4', content: 'identity verified', sourceRef: 'identity-verification', occurredAt: new Date().toISOString() }, { kind: 'system', ref: 'identity-verification' }, 'r72-d4');
    b.next(waitInput(), say('Te confirmo: discos de 20 kg a $45.990.'));
    await b.runAgent();
    expect((await events(b, taskId, 'turn.closure.reconsider')).map((e) => e.entity_id)).toEqual([(await input(b, 'wamid.r72-d4a')).input_id]);
  });

  it('S34: audit metadata never decides: «Hola» as the first message, closed silently twice, is ratified with hadPriorReply = false', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r72-34a', 'Hola');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(waitInput(), waitInput());
    await b.runAgent();
    expect(await events(b, taskId, 'turn.closed_without_reply')).toEqual([expect.objectContaining({ data: expect.objectContaining({ hadPriorReply: false, trailingCount: 1 }) })]);
  });
});

describe('message catalog (R4_J4_R7_TEST_PLAN §3.7): the runtime treats every text the same way', () => {
  const MESSAGES = [
    'Ok, gracias', 'Perfecto', 'Muchas gracias, eso sería todo',
    'Necesito cotizar un rack', 'Mándame el precio', 'Quiero agregar dos discos',
    'Ya, dale', 'Perfecto, avancemos', 'Gracias, pero agrégale dos discos',
  ];
  it.each(MESSAGES)('«%s»: branch B (silent twice) is refused then ratified; branch A (reply) is covered', async (text) => {
    const b = await start();
    const silent = await afterReply(b, CUSTOMER, 'wamid.r72-cat-b', text);
    b.next(waitInput(), waitInput());
    await b.runAgent();
    const replied = await afterReply(b, OTHER, 'wamid.r72-cat-a', text);
    b.next(say('Entendido.'));
    await b.runAgent();
    expect([(await events(b, silent, 'turn.closure.reconsider')).length, (await events(b, silent, 'turn.closed_without_reply')).length]).toEqual([1, 1]);
    expect([(await events(b, replied, 'turn.closure.reconsider')).length, (await events(b, replied, 'turn.closed_without_reply')).length]).toEqual([0, 0]);
  });
});

describe('durable steering (level 1): inputs during work reach the next safe frontier', () => {
  /** A catalog whose `search` lets the test act while the capability call is in flight. */
  function catalogWithHook(onSearch: () => Promise<void>): CatalogPort {
    const fixture = new FixtureCatalog({ products: FIXTURE_PRODUCTS });
    return {
      search: async (request, options) => (await onSearch(), fixture.search(request, options)),
      getProductContext: (key, options) => fixture.getProductContext(key, options),
      getItemContext: (request, options) => fixture.getItemContext(request, options),
    };
  }
  const search = { type: 'structured' as const, data: { type: 'read_capability', capabilityId: 'catalog.search', arguments: { query: 'disco' } } };

  it('S70: a quantity change during a catalog search enters the very next model call (F1) and the ledger records it', async () => {
    let once = false;
    const b = await start({
      catalog: catalogWithHook(async () => {
        if (once) return;
        once = true;
        await b.customer(CUSTOMER, 'wamid.r72-70b', 'Mejor que sean cuatro');
      }),
    });
    await b.customer(CUSTOMER, 'wamid.r72-70a', 'Quiero dos discos de 20 kg');
    const taskId = await b.taskOf(CUSTOMER);
    let seenAfterRead = false;
    b.next(search, (request) => ((seenAfterRead = JSON.stringify(request.context).includes('Mejor que sean cuatro')), say('Perfecto, cuatro discos de 20 kg.')));
    await b.runAgent();
    await b.deliver();
    expect(seenAfterRead).toBe(true);
    const changed = await input(b, 'wamid.r72-70b');
    expect(changed.task_id).toBe(taskId);
    expect(await steeringLedger(b, taskId)).toEqual([{ sequence: 1, input_id: changed.input_id, iteration: 2 }]);
    expect(await outbound(b, taskId)).toEqual([{ origin: 'agent', status: 'accepted' }]);
    expect(await events(b, taskId, 'turn.closure.reconsider')).toEqual([]);
  });

  it('S31 + S75: concurrent messages while the deciding call runs are serialized on one task and none is orphaned by complete', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r72-31a', 'Hola');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(async () => {
      await Promise.all([b.customer(CUSTOMER, 'wamid.r72-31b', 'Busco un rack'), b.customer(CUSTOMER, 'wamid.r72-31c', 'Y una barra olímpica'), b.customer(CUSTOMER, 'wamid.r72-31d', 'Para gimnasio en casa')]);
      return complete();
    }, say('Te ayudo con el rack y la barra para tu gimnasio.'));
    await b.runAgent();
    const ids = ['wamid.r72-31a', 'wamid.r72-31b', 'wamid.r72-31c', 'wamid.r72-31d'];
    const all = await Promise.all(ids.map((id) => input(b, id)));
    expect(new Set(all.map((i) => i.task_id))).toEqual(new Set([taskId]));
    const [first, second] = await runs(b, taskId);
    expect(first).toMatchObject({ details: { turnGuard: { outcome: 'deferred', code: 'turn_input_unseen' } } });
    const items = await snapshotItems(b, second!.run_id);
    for (const i of all) expect(items.get(`memory:${i.memory_entry_id}`)).toBe('included');
    expect(await task(b, taskId)).toMatchObject({ status: 'waiting' });
  });

  it('G2 A1: an inbound racing the closing transaction is never orphaned, whichever takes the task row first', async () => {
    const b = await start();
    for (let round = 0; round < 6; round += 1) {
      await b.customer(CUSTOMER, `wamid.g2-race-${round}a`, '¿Tienen discos de 20 kg?');
      b.next(say('Sí, a $45.990.'));
      await b.runAgent();
      await b.deliver();
      const taskId = await b.taskOf(CUSTOMER);
      await b.api.temporal.submitInput(taskId, { externalKey: `marker-race-${round}`, content: 'identity verified', sourceRef: 'identity-verification', occurredAt: new Date().toISOString() }, { kind: 'system', ref: 'identity-verification' }, 'g2-race');
      let race: Promise<unknown> = Promise.resolve();
      // The frontier is covered: only the racing inbound can stop this complete, and it is NOT awaited.
      b.next(() => ((race = b.customer(CUSTOMER, `wamid.g2-race-${round}b`, 'Una cosa más')), complete()), say('Dime.'));
      await b.runAgent();
      await race;
      await b.runAgent();
      await b.deliver();
      // Deferred on the same task, or (C-2) reopened on a new one; in both, a run received the input.
      const { memory_entry_id: entry } = await input(b, `wamid.g2-race-${round}b`);
      expect(await b.rows(`select 1 from context_snapshot_items where item_id = $1 and decision = 'included'`, [`memory:${entry}`])).not.toEqual([]);
    }
    // No conversational input in a completed task without a decision whose snapshot carried it.
    expect(await b.rows(
      `select i.input_id from task_inputs i join agent_tasks t on t.task_id = i.task_id
        where t.status = 'completed' and i.actor_kind = 'user' and not exists (
          select 1 from agent_run_steps s join context_snapshot_items c on c.snapshot_id = s.context_snapshot_id and c.item_id = 'memory:' || i.memory_entry_id::text and c.decision = 'included'
           where s.task_id = i.task_id and s.decision_type is not null)`)).toEqual([]);
  });

  it('S56 + restart during incorporation: a message arrives, the completion is deferred, the worker dies; a new worker incorporates it once', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r72-56a', 'Hola');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(async () => (await b.customer(CUSTOMER, 'wamid.r72-56b', '¿Tienen bancos?'), complete()), say('Sí, tenemos bancos planos y regulables.'));
    const first = await b.worker('worker-1');
    await first.worker.runOnce();
    await first.close();
    const second = await b.worker('worker-2');
    for (let i = 0; i < 5 && (await second.worker.runOnce()).kind !== 'idle'; i += 1);
    const all = await runs(b, taskId);
    expect(all.map((r) => r.status)).toEqual(['completed', 'suspended']);
    expect((await snapshotItems(b, all[1]!.run_id)).get(`memory:${(await input(b, 'wamid.r72-56b')).memory_entry_id}`)).toBe('included');
    expect(await events(b, taskId, 'turn.closure.reconsider')).toEqual([]);
  });
});

describe('bounded reconsideration and recovery (R7-1 dispositions, never a silent ending)', () => {
  const notices = (b: LiveOpsTestbed) => b.provider.sends.filter((s) => s.text === SALES_RUN_FAILURE_FALLBACK_TEXT);

  it('budget exhausted during the reconsideration: platform contingency (handoff + one notice), no closing recorded', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r72-b1', 'Necesito cotizar un rack');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(waitInput(), ...Array.from({ length: 19 }, () => focusUnknownGoal()));
    await b.runAgent();
    await b.deliver();
    expect(await task(b, taskId)).toEqual({ status: 'blocked', status_reason: 'run_budget_exhausted' });
    expect(await events(b, taskId, 'turn.closure.reconsider')).toHaveLength(1);
    expect(await events(b, taskId, 'turn.closed_without_reply')).toEqual([]);
    expect(notices(b)).toHaveLength(1);
  });

  it('a provider error in the run after a deferral: ADR-028 recovery; the recovery run still sees the episode and replies', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r72-b2', 'Mándame el precio del rack');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(complete(), { type: 'provider_error', retryable: true }, say('El rack R-300 cuesta $389.990.'));
    await b.runAgent();
    await b.deliver();
    const all = await runs(b, taskId);
    expect(all.map((r) => [r.status, r.termination_reason])).toEqual([['completed', 'completed'], ['failed', 'model_failure'], ['suspended', 'waiting']]);
    const [reconsider] = await events(b, taskId, 'turn.closure.reconsider');
    expect((await snapshotItems(b, all[2]!.run_id)).get(`turn_closure:${reconsider!.event_id}`)).toBe('included');
    expect(await outbound(b, taskId)).toEqual([{ origin: 'agent', status: 'accepted' }]);
  });

  it('a persistence failure while recording the reconsideration rolls the closing back whole: contingency, never completed', async () => {
    const b = await start();
    // Fails exactly once (a sequence is not transactional): the first reconsideration insert raises.
    await b.rows(`create sequence r72_fail_once`);
    await b.rows(`create function r72_fail() returns trigger language plpgsql as $$
      begin if new.event_type = 'turn.closure.reconsider' and nextval('r72_fail_once') = 1 then raise exception 'injected persistence failure'; end if; return new; end $$`);
    await b.rows(`create trigger r72_fail before insert on temporal_events for each row execute function r72_fail()`);
    await b.customer(CUSTOMER, 'wamid.r72-b3', 'Quiero agregar dos discos');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(complete());
    await b.runAgent();
    await b.deliver();
    expect(await events(b, taskId, 'turn.closure.reconsider')).toEqual([]);
    expect(await task(b, taskId)).toEqual({ status: 'blocked', status_reason: 'run_internal_failure' });
    expect(await runs(b, taskId)).toEqual([expect.objectContaining({ status: 'failed', termination_code: 'ending_refused' })]);
    expect(notices(b)).toHaveLength(1);
  });
});

describe('observe mode (R4_TURN_GUARD=observe): first canary gate and rollback', () => {
  it('S32: records what it would do and behaves as R7-1 (complete completes, wait waits)', async () => {
    const b = await start();
    await b.worker('worker-1', { turnGuard: 'observe' });
    await b.customer(CUSTOMER, 'wamid.r72-32a', 'Necesito cotizar un rack');
    await b.customer(OTHER, 'wamid.r72-32b', '¿Tienen garantía?');
    b.next(complete(), waitInput());
    await b.runAgent();
    const [completed, waiting] = [await b.taskOf(CUSTOMER).catch(() => null), await b.taskOf(OTHER)];
    const completedTask = completed ?? (await input(b, 'wamid.r72-32a')).task_id;
    expect(await task(b, completedTask)).toMatchObject({ status: 'completed' });
    expect((await events(b, completedTask, 'turn.closure.would_defer')).map((e) => e.data.code)).toEqual(['turn_reply_pending']);
    expect(await task(b, waiting)).toMatchObject({ status: 'waiting' });
    expect((await events(b, waiting, 'turn.closure.would_refuse')).map((e) => e.data.code)).toEqual(['turn_reply_pending']);
    for (const t of [completedTask, waiting]) {
      expect(await events(b, t, 'turn.closure.reconsider')).toEqual([]);
      expect(await events(b, t, 'turn.closed_without_reply')).toEqual([]);
    }
  });
});
