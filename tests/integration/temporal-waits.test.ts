import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Platform } from '@r4/api';
import type { CompiledContextItem } from '@r4/contracts';
import type { ModelRequest } from '@r4/model-gateway';
import { PostgresExecutionStore, PostgresMemoryStore } from '@r4/persistence-postgres';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { createActionTask, startActionPlatform } from '../support/actions.js';
import { startTestWorker, type TestWorker } from '../support/worker.js';
import { complete, compiledOf, read, respond, sequence } from '../support/decisions.js';
import { PARTICIPANT, drain, input, manageGoal, setTemporalOffset, shiftedClock, testScheduler, tokenOf, waitInput, waitRows, waitUntil } from '../support/temporal.js';
import { GET_TEST_FACT_ID } from '../fixtures/capabilities/get-test-fact.js';

let db: TestDatabase;
let platform: Platform;
const workers: TestWorker[] = [];

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  platform = await startActionPlatform(db.url);
});
afterEach(async () => {
  for (const w of workers.splice(0)) await w.platform.close();
  await platform?.close();
  await db?.drop();
});

async function worker(options: Omit<Parameters<typeof startTestWorker>[1], 'workerId'>): Promise<TestWorker> {
  const w = await startTestWorker(db.url, { workerId: `temporal-worker-${workers.length}`, ...options });
  workers.push(w);
  return w;
}
async function stop(w: TestWorker): Promise<void> {
  await w.platform.close();
  workers.splice(workers.indexOf(w), 1);
}
const events = async (taskId: string, type: string) => (await platform.temporal.inspect(taskId)).events.filter((e) => e.type === type);
const items = (request: ModelRequest, section: keyof ReturnType<typeof compiledOf>['sections']): CompiledContextItem[] => compiledOf(request).sections[section];
const text = (request: ModelRequest, section: keyof ReturnType<typeof compiledOf>['sections']) => JSON.stringify(items(request, section));

describe('goal continuity across a durable wait', () => {
  it('keeps root and current focus through worker restart and input; the new run sees its own question and the answer', async () => {
    const taskId = await createActionTask(platform);
    const { task: original } = await platform.tasks.getTask(taskId);
    const first = await worker({
      script: sequence([
        manageGoal({ operation: 'create', parentGoalId: original.rootGoalId, description: 'Obtain the missing dimension', successCriteria: [], makeCurrent: true }),
        respond('Which dimension should the deliverable use?'),
        waitInput('I need the dimension before continuing'),
      ]),
    });
    await first.platform.worker.runOnce();
    const waiting = await platform.tasks.getTask(taskId);
    expect(waiting.task.status).toBe('waiting');
    expect(waiting.runs.map((r) => r.status)).toEqual(['suspended']);
    expect(waiting.task.rootGoalId).toBe(original.rootGoalId);
    const focus = waiting.task.currentGoalId;
    expect(focus).not.toBe(original.rootGoalId);

    await stop(first); // the worker process is gone; only PostgreSQL remembers
    await platform.temporal.submitInput(taskId, input('in-1'), PARTICIPANT, 'input-1');

    const seen: ModelRequest[] = [];
    const second = await worker({ script: sequence([(r) => (seen.push(r), complete('continued'))]) });
    await second.platform.worker.runOnce();
    const request = seen[0]!;
    const goals = items(request, 'goals').map((i) => i.content as Record<string, unknown>);
    expect(goals).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalId: original.rootGoalId, isRoot: true, isCurrent: false, status: 'active' }),
      expect.objectContaining({ goalId: focus, isRoot: false, isCurrent: true, status: 'active', parentGoalId: original.rootGoalId }),
    ]));
    // Cross-run continuity: the agent's own question (earlier run) AND the answer, in order.
    const conversation = items(request, 'conversation');
    const question = conversation.findIndex((i) => i.sourceId === 'platform.interaction' && JSON.stringify(i.content).includes('Which dimension should the deliverable use?'));
    const answer = conversation.findIndex((i) => i.sourceId === 'platform.memory' && JSON.stringify(i.content).includes('The missing dimension is 10.'));
    expect(question).toBeGreaterThanOrEqual(0);
    expect(answer).toBeGreaterThan(question);
    expect(conversation[question]).toMatchObject({ authority: 'CONVERSATIONAL', content: { actor: { role: 'agent' }, earlierRun: true } });
    // The wait between the runs, with the agent's stated reason and how it ended.
    expect(items(request, 'episodicMemory').map((i) => i.content)).toContainEqual(expect.objectContaining({ event: 'task.wait', kind: 'WAIT_FOR_INPUT', resolution: 'input', statedReason: 'I need the dimension before continuing' }));

    const done = await platform.tasks.getTask(taskId);
    expect(done.runs).toHaveLength(2);
    expect(done.task.status).toBe('completed');
    expect(await events(taskId, 'task.woken')).toHaveLength(1);
  });

  it('keeps a completed incidental goal alongside the unfinished root and returns focus explicitly', async () => {
    const taskId = await createActionTask(platform);
    const root = (await platform.tasks.getTask(taskId)).task.rootGoalId;
    let incidental = '';
    const seen: ModelRequest[] = [];
    const w = await worker({
      script: sequence([
        manageGoal({ operation: 'create', parentGoalId: root, description: 'Answer a prerequisite question', successCriteria: [], makeCurrent: true }),
        (r) => {
          incidental = (items(r, 'goals').map((i) => i.content as { goalId: string; isCurrent?: boolean }).find((g) => g.isCurrent)!).goalId;
          return manageGoal({ operation: 'complete', goalId: incidental });
        },
        manageGoal({ operation: 'focus', goalId: root }),
        (r) => (seen.push(r), waitInput()),
      ]),
    });
    await w.platform.worker.runOnce();
    const view = await platform.tasks.getTask(taskId);
    expect(view.task.currentGoalId).toBe(root);
    expect(view.goals.find((g) => g.goalId === root)?.status).toBe('active');
    expect(view.goals.find((g) => g.goalId === incidental)).toMatchObject({ status: 'achieved', parentGoalId: root });
    // The closed incidental goal is history, never a privileged objective; the root is the live goal.
    expect(items(seen[0]!, 'goals').map((i) => i.itemId)).toEqual([`goal:${root}`]);
    expect(items(seen[0]!, 'episodicMemory').map((i) => i.content)).toContainEqual(expect.objectContaining({ event: 'goal.achieved', goalId: incidental }));
    const history = await platform.pool.query<{ kind: string; goal_id: string }>('select kind, goal_id from goal_transitions where task_id = $1 order by occurred_at, transition_id', [taskId]);
    expect(history.rows.map((r) => r.kind)).toEqual(['created', 'created', 'focused', 'achieved', 'focused']);
  });

  it('refuses invalid goal references recoverably: foreign, unknown and closed goals never fail the task', async () => {
    const taskId = await createActionTask(platform);
    const other = await createActionTask(platform);
    const foreign = (await platform.tasks.getTask(other)).task.rootGoalId;
    const root = (await platform.tasks.getTask(taskId)).task.rootGoalId;
    const seen: ModelRequest[] = [];
    const w = await worker({
      script: sequence([
        manageGoal({ operation: 'complete', goalId: foreign }),
        (r) => (seen.push(r), manageGoal({ operation: 'focus', goalId: '0190a0a0-0000-7000-8000-000000000000' })),
        manageGoal({ operation: 'create', parentGoalId: root, description: 'A subgoal', successCriteria: [], makeCurrent: false }),
        (r) => {
          const sub = items(r, 'goals').map((i) => i.content as { goalId: string; parentGoalId: string | null }).find((g) => g.parentGoalId === root)!;
          return manageGoal({ operation: 'abandon', goalId: sub.goalId });
        },
        (r) => {
          const sub = (r.context!.sections.episodicMemory.map((i) => i.content as { event: string; goalId: string }).find((e) => e.event === 'goal.abandoned'))!;
          return manageGoal({ operation: 'focus', goalId: sub.goalId });
        },
        (r) => (seen.push(r), complete('recovered')),
      ]),
    });
    await w.platform.worker.runOnce();
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
    expect((await platform.tasks.getTask(other)).goals[0]?.status).toBe('active');
    const runId = (await platform.tasks.getTask(taskId)).runs[0]!.runId;
    const steps = await new PostgresExecutionStore(platform.pool).transaction((uow) => uow.listRunSteps(runId));
    expect(steps.map((s) => [s.outcome, s.error?.code ?? null])).toEqual([
      ['refused', 'goal_task_mismatch'], ['refused', 'goal_not_found'], ['recorded', null], ['recorded', null], ['refused', 'goal_not_active'], ['recorded', null],
    ]);
    // The refusal reached the agent's next context as observed evidence it can act on.
    expect(text(seen[0]!, 'episodicMemory')).toContain('goal_task_mismatch');
    expect(text(seen[1]!, 'episodicMemory')).toContain('goal_not_active');
    expect(await events(taskId, 'goal.change.rejected')).toHaveLength(3);
  });
});

describe('inbound input', () => {
  it('retains two concurrent inputs, deduplicates a re-delivered one, and wakes exactly once with one owner', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([waitInput()]) });
    await w.platform.worker.runOnce();
    const at = new Date().toISOString(); // a re-delivered event carries its original identity and time
    await Promise.all([
      platform.temporal.submitInput(taskId, input('one', undefined, undefined, at), PARTICIPANT, 'one'),
      platform.temporal.submitInput(taskId, input('two', 'Another input'), PARTICIPANT, 'two'),
    ]);
    expect(await platform.temporal.submitInput(taskId, input('one', undefined, undefined, at), PARTICIPANT, 'replay')).toMatchObject({ replayed: true });
    await expect(platform.temporal.submitInput(taskId, input('one', 'changed', undefined, at), PARTICIPANT, 'reuse')).rejects.toMatchObject({ code: 'idempotency_key_reused' });
    expect((await new PostgresMemoryStore(platform.pool).listForTask(taskId)).filter((m) => m.memoryType === 'CONVERSATIONAL')).toHaveLength(2);
    expect(await events(taskId, 'task.woken')).toHaveLength(1);
    const claimers = await Promise.all(Array.from({ length: 6 }, (_, i) => w.platform.execution.claimNext({ workerId: `claim-${i}`, leaseDurationMs: 60_000 })));
    expect(claimers.filter(Boolean)).toHaveLength(1);
  });

  it('never strands input that arrives while the model is still deciding to wait', async () => {
    const taskId = await createActionTask(platform);
    let submitted = false;
    const seen: ModelRequest[] = [];
    const w = await worker({
      script: sequence([
        async () => {
          // The model call is in flight: the input becomes durable before its decision is recorded.
          await platform.temporal.submitInput(taskId, input('during-model', 'Arrived mid-decision'), PARTICIPANT, 'during-model');
          submitted = true;
          return waitInput();
        },
        (r) => (seen.push(r), complete('saw it')),
      ]),
    });
    await w.platform.worker.runOnce();
    expect(submitted).toBe(true);
    // The stale wait was satisfied at once by the unseen input: the task is runnable, not stranded.
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('running');
    expect(await waitRows(platform.pool, taskId)).toEqual([{ kind: 'WAIT_FOR_INPUT', status: 'completed', resolution: 'input' }]);
    await w.platform.worker.runOnce();
    expect(text(seen[0]!, 'conversation')).toContain('Arrived mid-decision');
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
    expect(await events(taskId, 'task.woken')).toHaveLength(1);
  });
});

describe('WAIT_UNTIL', () => {
  it('wakes when the durable timer is due — on the temporal clock, without real sleeps', async () => {
    const taskId = await createActionTask(platform);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const w = await worker({ script: sequence([waitUntil(until, 'follow up in an hour'), complete('woke on time')]) });
    await w.platform.worker.runOnce();
    const { scheduler } = testScheduler(platform.pool);
    expect(await drain(scheduler)).toBe(0); // not due yet
    await setTemporalOffset(platform.pool, 3_600_000 + 1_000);
    expect(await drain(scheduler)).toBe(1);
    expect(await waitRows(platform.pool, taskId)).toEqual([{ kind: 'WAIT_UNTIL', status: 'completed', resolution: 'timer' }]);
    await w.platform.worker.runOnce();
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
    const lag = (await events(taskId, 'schedule.fired'))[0]!.data.lagMs as number;
    expect(lag).toBeGreaterThanOrEqual(0);
  });

  it('is interruptible: input before the timer wakes the task now, and the timer can never wake it again', async () => {
    const taskId = await createActionTask(platform);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const w = await worker({ script: sequence([waitUntil(tomorrow), complete('answered early'), waitInput()]) });
    await w.platform.worker.runOnce();
    await platform.temporal.submitInput(taskId, input('early', 'Replying today'), PARTICIPANT, 'early');
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('running');
    expect(await waitRows(platform.pool, taskId)).toEqual([{ kind: 'WAIT_UNTIL', status: 'completed', resolution: 'input' }]);
    const schedules = (await platform.temporal.inspect(taskId)).schedules;
    expect(schedules.map((s) => [s.kind, s.status])).toEqual([['wake', 'cancelled']]);
    await w.platform.worker.runOnce();
    await setTemporalOffset(platform.pool, 2 * 86_400_000);
    expect(await drain(testScheduler(platform.pool).scheduler)).toBe(0);
    expect(await events(taskId, 'task.woken')).toHaveLength(1);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
  });
});

describe('durable scheduler', () => {
  it('fires a due schedule once under concurrent schedulers; recovers a dead one and fences its token', async () => {
    const taskId = await createActionTask(platform);
    const w = await worker({ script: sequence([waitUntil('2020-01-01T00:00:00.000Z')]) });
    await w.platform.worker.runOnce();
    const schedulers = Array.from({ length: 8 }, (_, i) => testScheduler(platform.pool, { owner: `s-${i}` }).temporal);
    const claims = await Promise.all(schedulers.map((t, i) => t.claimSchedule(`s-${i}`, 60_000)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const dead = claims.find(Boolean)!;
    // The claimer "dies": its lease expires on the temporal clock; a replacement reclaims with a higher generation.
    await setTemporalOffset(platform.pool, 61_000);
    const { temporal: replacement } = testScheduler(platform.pool, { owner: 'replacement' });
    const recovered = await replacement.claimSchedule('replacement', 60_000);
    expect(recovered?.generation).toBe(dead.generation + 1);
    await expect(schedulers[0]!.fireSchedule(tokenOf(dead))).rejects.toMatchObject({ code: 'schedule_lease_lost' });
    await replacement.fireSchedule(tokenOf(recovered!));
    await expect(replacement.fireSchedule(tokenOf(recovered!))).rejects.toMatchObject({ code: 'schedule_lease_lost' });
    expect(await events(taskId, 'task.woken')).toHaveLength(1);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('running');
  });
});

describe('long wait (deterministic temporal time)', () => {
  it('recompiles a fresh context after days: goal survives, expired evidence is history, never current', async () => {
    const taskId = await createActionTask(platform);
    const root = (await platform.tasks.getTask(taskId)).task.rootGoalId;
    const clock = shiftedClock();
    const threeDays = 3 * 86_400_000;
    const seen: ModelRequest[] = [];
    const first = await worker({
      clock,
      script: sequence([read(GET_TEST_FACT_ID, { factKey: 'alpha' }), (r) => (seen.push(r), waitUntil(new Date(Date.now() + threeDays).toISOString(), 'check again in three days'))]),
    });
    await first.platform.worker.runOnce();
    const fresh = items(seen[0]!, 'observations');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ freshness: 'fresh' });
    await stop(first);

    // Three days pass: the temporal clock (schedules) and the process clock (C2 freshness) both move.
    clock.offsetMs = threeDays + 60_000;
    await setTemporalOffset(platform.pool, threeDays + 60_000);
    expect(await drain(testScheduler(platform.pool).scheduler)).toBe(1);

    const second = await worker({ clock, script: sequence([(r) => (seen.push(r), complete('rechecked'))]) });
    await second.platform.worker.runOnce();
    const later = seen[1]!;
    expect(items(later, 'observations')).toEqual([]);
    expect(items(later, 'history')).toEqual([expect.objectContaining({ kind: 'observation', freshness: 'expired' })]);
    expect(items(later, 'goals').map((i) => (i.content as { goalId: string }).goalId)).toEqual([root]);
    expect(Date.parse(compiledOf(later).asOf) - Date.parse(compiledOf(seen[0]!).asOf)).toBeGreaterThanOrEqual(threeDays);
    // A new run, a new snapshot: nothing from before the wait is reused as if time had not passed.
    const snapshots = await platform.pool.query<{ run_id: string; input_fingerprint: string }>('select run_id, input_fingerprint from context_snapshots where task_id = $1 order by created_at', [taskId]);
    const runs = new Set(snapshots.rows.map((r) => r.run_id));
    expect(runs.size).toBe(2);
    expect(snapshots.rows.at(-1)!.input_fingerprint).not.toBe(snapshots.rows[1]!.input_fingerprint);
    expect((await platform.tasks.getTask(taskId)).task.status).toBe('completed');
  });
});
