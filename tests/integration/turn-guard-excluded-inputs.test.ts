import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_PRODUCTS, FixtureCatalog } from '@r4-adapters/domains';
import { DeterministicCompactor, type ContextCompilationPolicyInput } from '@r4/context-compiler';
import type { FakeModelStep, ModelRequest } from '@r4/model-gateway';
import type { WorkerPlatform } from '@r4/worker';
import { SALES_RUN_FAILURE_FALLBACK_TEXT } from '@r4-sales/agent/production';
import { LiveOpsTestbed, complete, say, waitInput } from '../support/live-ops.js';

/**
 * R4-J4-R7 G2, Part B — a closing rests on what the model RECEIVED, not on what
 * the compiler EVALUATED (`context_snapshot_items` records excluded items too).
 *
 * The acceptance criterion: no input counts as seen only because the compiler
 * evaluated it, if its content reached no model call and no sufficient,
 * verifiable memory represents it. Waking keeps the wider rule on purpose
 * (`hasUnseenInput`): a wake for an excluded input would recompile, exclude it
 * again and wake again.
 *
 * Every scenario records what the model actually received (the request of each
 * call), what `turnObligation` made of it (events, statuses) and the durable
 * way out (handoff + notice). The budgets are `fixed`: production runs
 * `unbounded`, where none of this exclusion happens.
 */

const CUSTOMER = '56933336666';
const SCOUT = '56933337777';
let bed: LiveOpsTestbed | null = null;
afterEach(async () => {
  await bed?.close();
  bed = null;
});

/** A marker past the deterministic compactor's 60-character excerpt, so a summary cannot carry it. */
const LONG = (marker: string, chars = 4_000) => `${'x'.repeat(chars)} ${marker}`;
const RACK = 'Necesito cotizar un rack';

/**
 * A bed whose worker has a `fixed` budget of what a one-turn conversation takes
 * (measured by an unbounded scout on another conversation) plus `slack` tokens.
 */
async function bounded(slack: number, policy: Partial<ContextCompilationPolicyInput> = {}, compactor = false, catalog = false): Promise<{ b: LiveOpsTestbed; worker: WorkerPlatform }> {
  const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER, SCOUT], autonomy: true, ...(catalog ? { env: { R4_PROD_POLICY_PROFILE: 'sales-production@2' }, catalog: Object.assign(new FixtureCatalog({ products: FIXTURE_PRODUCTS }), { bindingKind: 'real' }) } : {}) }));
  await b.customer(SCOUT, 'wamid.gx-scout', 'Hola');
  b.next(say('Hola.'));
  await b.runAgent();
  const [{ tokens } = { tokens: 0 }] = await b.rows<{ tokens: number }>('select max(estimated_tokens)::int as tokens from context_snapshots');
  const worker = await b.worker('bounded', { context: { ...policy, budget: { mode: 'fixed', maxEstimatedTokens: tokens + slack } }, ...(compactor ? { compactor: new DeterministicCompactor() } : {}) });
  return { b, worker };
}
const drive = async (worker: WorkerPlatform, cycles = 20) => {
  for (let i = 0; i < cycles && (await worker.worker.runOnce()).kind !== 'idle'; i += 1);
};
/** Scripted decisions that keep each request the model received. */
const recording = (received: string[], step: FakeModelStep) => (request: ModelRequest) => (received.push(JSON.stringify(request.context)), step);

const task = async (b: LiveOpsTestbed, taskId: string) => (await b.rows<{ status: string; status_reason: string }>('select status, status_reason from agent_tasks where task_id = $1', [taskId]))[0];
const eventCount = async (b: LiveOpsTestbed, taskId: string, type: string) => (await b.rows('select 1 from temporal_events where task_id = $1 and event_type = $2', [taskId, type])).length;
const inputOf = async (b: LiveOpsTestbed, providerId: string) =>
  (await b.rows<{ input_id: string; memory_entry_id: string; task_id: string }>('select i.input_id, i.memory_entry_id, i.task_id from inbound_events e join task_inputs i on i.input_id = e.input_id where e.provider_event_id = $1', [providerId]))[0]!;
/** The decision the latest snapshot of the task recorded for an input. */
const lastDecision = async (b: LiveOpsTestbed, taskId: string, memoryEntryId: string) =>
  (await b.rows<{ decision: string; reason: string | null; represented_by: string | null }>(
    `select i.decision, i.exclusion_reason as reason, i.represented_by from context_snapshot_items i join context_snapshots s on s.snapshot_id = i.snapshot_id
      where s.task_id = $1 and i.item_id = $2 order by s.created_at desc, s.attempt desc limit 1`, [taskId, `memory:${memoryEntryId}`]))[0];
const notices = (b: LiveOpsTestbed) => b.provider.sends.filter((s) => s.text === SALES_RUN_FAILURE_FALLBACK_TEXT);
const handoffs = (b: LiveOpsTestbed, taskId: string) => b.rows<{ status: string }>(`select status from human_requests where task_id = $1 and kind = 'handoff'`, [taskId]);

/** Handed to a person, with the notice: never closed over an input the model did not receive. */
async function expectHandedOff(b: LiveOpsTestbed, taskId: string): Promise<void> {
  await b.deliver();
  expect(await task(b, taskId)).toEqual({ status: 'blocked', status_reason: 'run_internal_failure' });
  expect(await handoffs(b, taskId)).toEqual([{ status: 'requested' }]);
  expect(await eventCount(b, taskId, 'turn.closed_without_reply')).toBe(0);
  expect(notices(b)).toHaveLength(1);
}

describe('G2 Part B: a closing rests on what the model received', () => {
  it('X1 input included in the snapshot: reached the model, reconsidered, ratified', async () => {
    const { b, worker } = await bounded(800);
    await b.customer(CUSTOMER, 'wamid.gx-1', RACK);
    const taskId = await b.taskOf(CUSTOMER);
    const received: string[] = [];
    b.next(recording(received, waitInput()), recording(received, waitInput()));
    await drive(worker);
    expect(received.every((c) => c.includes(RACK))).toBe(true);
    expect(await lastDecision(b, taskId, (await inputOf(b, 'wamid.gx-1')).memory_entry_id)).toMatchObject({ decision: 'included' });
    expect(await eventCount(b, taskId, 'turn.closed_without_reply')).toBe(1);
  });

  it('X2a evaluated but excluded by budget, complete: never ratified nor deferred forever; a person gets it', async () => {
    const { b, worker } = await bounded(200);
    await b.customer(CUSTOMER, 'wamid.gx-2a', LONG('MARKER-2A'));
    const taskId = await b.taskOf(CUSTOMER);
    const received: string[] = [];
    b.next(recording(received, complete()), recording(received, complete()), recording(received, complete()));
    await drive(worker);
    expect(received.length).toBeGreaterThan(0);
    expect(received.some((c) => c.includes('MARKER-2A'))).toBe(false);
    expect(await lastDecision(b, taskId, (await inputOf(b, 'wamid.gx-2a')).memory_entry_id)).toMatchObject({ decision: 'excluded', reason: 'budget' });
    await expectHandedOff(b, taskId);
    expect(await eventCount(b, taskId, 'turn.closure.reconsider')).toBe(0);
  });

  it('X2b evaluated but excluded by budget, agent wait: same way out', async () => {
    const { b, worker } = await bounded(200);
    await b.customer(CUSTOMER, 'wamid.gx-2b', LONG('MARKER-2B'));
    const taskId = await b.taskOf(CUSTOMER);
    const received: string[] = [];
    b.next(recording(received, waitInput()), recording(received, waitInput()), recording(received, waitInput()));
    await drive(worker);
    expect(received.some((c) => c.includes('MARKER-2B'))).toBe(false);
    await expectHandedOff(b, taskId);
  });

  it('X2c evaluated but excluded by budget, respond: a reply that never received the input covers nothing', async () => {
    const { b, worker } = await bounded(200);
    await b.customer(CUSTOMER, 'wamid.gx-2c', LONG('MARKER-2C'));
    const taskId = await b.taskOf(CUSTOMER);
    const received: string[] = [];
    b.next(recording(received, say('Hola, ¿en qué te ayudo?')));
    await drive(worker);
    expect(received.some((c) => c.includes('MARKER-2C'))).toBe(false);
    await expectHandedOff(b, taskId);
  });

  it('X2d an older input excluded behind a newer one: the reply covers the frontier, not what it never received', async () => {
    const { b, worker } = await bounded(200);
    await b.customer(CUSTOMER, 'wamid.gx-2d1', LONG('MARKER-2D'));
    await b.customer(CUSTOMER, 'wamid.gx-2d2', 'Hola');
    const taskId = await b.taskOf(CUSTOMER);
    const received: string[] = [];
    b.next(recording(received, say('Hola, ¿en qué te ayudo?')));
    await drive(worker);
    expect(received.some((c) => c.includes('MARKER-2D'))).toBe(false);
    expect(received.some((c) => c.includes('Hola'))).toBe(true);
    await expectHandedOff(b, taskId);
  });

  it('X2e no false positive: an input the model received earlier may leave the context later (a long conversation still closes)', async () => {
    const { b, worker } = await bounded(650);
    await b.customer(CUSTOMER, 'wamid.gx-2e1', `${'a'.repeat(2_000)} primera`);
    const taskId = await b.taskOf(CUSTOMER);
    b.next(say('Recibido.'));
    await drive(worker);
    await b.deliver();
    await b.customer(CUSTOMER, 'wamid.gx-2e2', `${'b'.repeat(2_000)} segunda`);
    b.next(say('Recibido también.'));
    await drive(worker);
    await b.deliver();
    expect(await lastDecision(b, taskId, (await inputOf(b, 'wamid.gx-2e1')).memory_entry_id)).toMatchObject({ decision: 'excluded', reason: 'budget' });
    expect(await task(b, taskId)).toMatchObject({ status: 'waiting' });
    expect(await handoffs(b, taskId)).toEqual([]);
    // A silent closing of the included frontier is still the ordinary reconsideration and ratification.
    await b.customer(CUSTOMER, 'wamid.gx-2e3', 'Gracias');
    b.next(waitInput(), waitInput());
    await drive(worker);
    expect(await eventCount(b, taskId, 'turn.closed_without_reply')).toBe(1);
    expect(await task(b, taskId)).toMatchObject({ status: 'waiting' });
  });

  it('X2g received earlier, left out of the reply: an observation pushed the frontier out, so the reply that followed does not cover it', async () => {
    const { b, worker } = await bounded(450, {}, false, true);
    await b.customer(CUSTOMER, 'wamid.gx-2g', LONG('MARKER-2G', 1_000));
    const taskId = await b.taskOf(CUSTOMER);
    const received: string[] = [];
    b.next(recording(received, { type: 'structured', data: { type: 'read_capability', capabilityId: 'catalog.search', arguments: { query: 'disco' } } }), recording(received, say('Tenemos discos.')));
    await drive(worker);
    expect(received[0]).toContain('MARKER-2G');
    expect(received[1]).not.toContain('MARKER-2G');
    await expectHandedOff(b, taskId);
  });

  it('X2f a temporal wait is no closing and the wake rule stays wider: no handoff and no wake loop on an excluded input', async () => {
    const { b, worker } = await bounded(200);
    await b.customer(CUSTOMER, 'wamid.gx-2f', LONG('MARKER-2F'));
    const taskId = await b.taskOf(CUSTOMER);
    b.next({ type: 'structured', data: { type: 'wait', condition: { kind: 'WAIT_UNTIL', until: '2099-01-01T00:00:00.000Z' }, reason: 'later' } });
    await drive(worker);
    expect(await task(b, taskId)).toMatchObject({ status: 'waiting' });
    expect(b.pendingSteps).toBe(0);
    expect((await b.rows(`select 1 from agent_runs where task_id = $1`, [taskId]))).toHaveLength(1);
    expect(await handoffs(b, taskId)).toEqual([]);
  });

  it('X3a compacted after the model received it: the summary may represent it; the conversation closes normally', async () => {
    const { b, worker } = await bounded(1_250, { conversation: { recentTurns: 2, compaction: { enabled: true, chunkTurns: 2 } } }, true);
    let taskId = '';
    for (const i of [1, 2, 3]) {
      await b.customer(CUSTOMER, `wamid.gx-3a${i}`, `${'c'.repeat(1_000)} turno ${i}`);
      taskId ||= await b.taskOf(CUSTOMER);
      b.next(say(`Recibido ${i}.`));
      await drive(worker);
      await b.deliver();
    }
    const decision = await lastDecision(b, taskId, (await inputOf(b, 'wamid.gx-3a1')).memory_entry_id);
    expect(decision).toMatchObject({ decision: 'excluded', reason: 'compacted' });
    expect(decision!.represented_by).toMatch(/^summary:/);
    expect(await task(b, taskId)).toMatchObject({ status: 'waiting' });
    expect(await handoffs(b, taskId)).toEqual([]);
  });

  it('X3b compacted before the model ever received it: an excerpt is no delivery (the summary cannot carry the request)', async () => {
    const { b, worker } = await bounded(1_250, { conversation: { recentTurns: 2, compaction: { enabled: true, chunkTurns: 2 } } }, true);
    for (const i of [1, 2, 3, 4, 5]) await b.customer(CUSTOMER, `wamid.gx-3b${i}`, LONG(`MARKER-3B${i}`, 800));
    const taskId = await b.taskOf(CUSTOMER);
    const received: string[] = [];
    b.next(recording(received, say('Recibido.')));
    await drive(worker);
    const decision = await lastDecision(b, taskId, (await inputOf(b, 'wamid.gx-3b1')).memory_entry_id);
    expect(decision).toMatchObject({ decision: 'excluded', reason: 'compacted' });
    expect(decision!.represented_by).toMatch(/^summary:/);
    // The summary reached the model; the request it stands for did not.
    expect(received[0]).toContain('deterministic-extractive');
    expect(received[0]).not.toContain('MARKER-3B1');
    expect(received[0]).toContain('MARKER-3B5');
    await expectHandedOff(b, taskId);
  });

  it('X4a the reconsideration episode excluded, complete: the closing does not repeat across runs and is not ratified uninformed', async () => {
    const { b, worker } = await bounded(30);
    await b.customer(CUSTOMER, 'wamid.gx-4a', RACK);
    const taskId = await b.taskOf(CUSTOMER);
    const received: string[] = [];
    b.next(...Array.from({ length: 8 }, () => recording(received, complete())));
    await drive(worker, 12);
    // The input reached the model; the reconsideration never did.
    expect(received.length).toBe(2);
    expect(received.every((c) => c.includes(RACK))).toBe(true);
    expect(received.some((c) => c.includes('turn.closure.reconsider'))).toBe(false);
    expect(await eventCount(b, taskId, 'turn.closure.reconsider')).toBe(1);
    await expectHandedOff(b, taskId);
  });

  it('X4b the reconsideration episode excluded, agent wait: handed over at once, not refused until the budget runs out', async () => {
    const { b, worker } = await bounded(30);
    await b.customer(CUSTOMER, 'wamid.gx-4b', RACK);
    const taskId = await b.taskOf(CUSTOMER);
    const received: string[] = [];
    b.next(...Array.from({ length: 20 }, () => recording(received, waitInput())));
    await drive(worker);
    expect(received.length).toBe(2);
    expect(received.some((c) => c.includes('turn.closure.reconsider'))).toBe(false);
    await expectHandedOff(b, taskId);
  });

  it('X5 a new input during the reconsideration that does not fit: the old ratification is void and the new input is not closed over', async () => {
    const { b, worker } = await bounded(800);
    await b.customer(CUSTOMER, 'wamid.gx-5a', RACK);
    const taskId = await b.taskOf(CUSTOMER);
    const received: string[] = [];
    b.next(
      recording(received, waitInput()),
      async (request: ModelRequest) => {
        received.push(JSON.stringify(request.context));
        await b.customer(CUSTOMER, 'wamid.gx-5b', LONG('MARKER-5'));
        return waitInput();
      },
      recording(received, waitInput()),
    );
    await drive(worker);
    expect(received.some((c) => c.includes('MARKER-5'))).toBe(false);
    expect(await eventCount(b, taskId, 'turn.closure.reconsider')).toBe(1);
    await expectHandedOff(b, taskId);
  });

  it('X6 observe mode records the undelivered closing and behaves as R7-1', async () => {
    const b = (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER, SCOUT], autonomy: true }));
    await b.customer(SCOUT, 'wamid.gx-6s', 'Hola');
    b.next(say('Hola.'));
    await b.runAgent();
    const [{ tokens } = { tokens: 0 }] = await b.rows<{ tokens: number }>('select max(estimated_tokens)::int as tokens from context_snapshots');
    const worker = await b.worker('bounded', { turnGuard: 'observe', context: { budget: { mode: 'fixed', maxEstimatedTokens: tokens + 200 } } });
    await b.customer(CUSTOMER, 'wamid.gx-6', LONG('MARKER-6'));
    const { task_id: taskId } = await inputOf(b, 'wamid.gx-6');
    b.next(complete());
    await drive(worker);
    expect(await task(b, taskId)).toMatchObject({ status: 'completed' });
    expect(await b.rows(`select data->>'code' as code from temporal_events where task_id = $1 and event_type = 'turn.closure.would_defer'`, [taskId])).toEqual([{ code: 'turn_closure_undelivered' }]);
  });
});
