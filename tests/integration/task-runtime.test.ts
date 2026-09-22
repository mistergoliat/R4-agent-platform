import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PlatformError,
  agentRunSchema,
  agentTaskSchema,
  goalSchema,
  taskViewSchema,
  type Principal,
} from '@r4/contracts';
import type { Platform } from '@r4/api';
import { PostgresTaskRuntimeStore } from '@r4/persistence-postgres';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { PROBE_AGENT, startTestPlatform, validTaskBody } from '../support/platform.js';

const actor: Principal = { kind: 'service', ref: 'integration-test' };
let db: TestDatabase;
let platform: Platform;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  platform = await startTestPlatform(db.url);
});

afterAll(async () => {
  await platform?.close();
  await db?.drop();
});

async function createTask(overrides: Record<string, unknown> = {}, idempotencyKey?: string, principal: Principal = actor) {
  return platform.tasks.createTask({ request: validTaskBody(overrides), requestedBy: principal, correlationId: 'it-corr', idempotencyKey });
}

function expectPlatformError(error: unknown, code: string) {
  expect(error).toBeInstanceOf(PlatformError);
  expect((error as PlatformError).code).toBe(code);
}

describe('task creation', () => {
  it('persists a pending task with its root goal, pinned agent version and creation transition', async () => {
    const { view, replayed } = await createTask({ budget: { maxModelCalls: 3 } });
    expect(replayed).toBe(false);
    expect(taskViewSchema.safeParse(view).success).toBe(true);

    const { task, goals, runs } = view;
    expect(task).toMatchObject({
      status: 'pending',
      agentId: PROBE_AGENT,
      agentVersion: 1,
      version: 1,
      requestedBy: actor,
      correlationId: 'it-corr',
      input: { message: 'hello' },
      // Requested limit kept, other limits inherited from the agent ceilings.
      budget: { maxModelCalls: 3, maxTokens: 20_000, maxWrites: 0 },
    });
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ goalId: task.rootGoalId, parentGoalId: null, origin: 'requester', status: 'active' });
    expect(task.currentGoalId).toBe(task.rootGoalId);
    expect(runs).toEqual([]);

    const transitions = await new PostgresTaskRuntimeStore(platform.pool).listTransitions(task.taskId);
    expect(transitions).toMatchObject([{ fromStatus: null, toStatus: 'pending', reason: 'created', taskVersion: 1, actor }]);
  });

  it('refuses unknown agents, unsupported task types and budgets above the ceiling', async () => {
    await createTask({ agentId: 'ghost-agent' }).then(() => expect.unreachable(), (e: unknown) => expectPlatformError(e, 'agent_not_found'));
    await createTask({ agentVersion: 99 }).then(() => expect.unreachable(), (e: unknown) => expectPlatformError(e, 'agent_not_found'));
    await createTask({ taskType: 'probe.unknown' }).then(() => expect.unreachable(), (e: unknown) => expectPlatformError(e, 'task_type_not_supported'));
    await createTask({ budget: { maxModelCalls: 1_000 } }).then(() => expect.unreachable(), (e: unknown) => expectPlatformError(e, 'budget_exceeds_agent_limit'));
    await createTask({ deadlineAt: '2000-01-01T00:00:00Z' }).then(() => expect.unreachable(), (e: unknown) => expectPlatformError(e, 'deadline_in_past'));
  });

  it('links child tasks to open parents only', async () => {
    const parent = (await createTask()).view.task;
    const child = (await createTask({ parentTaskId: parent.taskId })).view.task;
    expect(child.parentTaskId).toBe(parent.taskId);

    await createTask({ parentTaskId: '0190a0a0-0000-7000-8000-000000000000' }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'parent_task_not_found'),
    );
    await platform.tasks.transitionTask({ taskId: parent.taskId, to: 'cancelled', actor, correlationId: 'c' });
    await createTask({ parentTaskId: parent.taskId }).then(() => expect.unreachable(), (e: unknown) => expectPlatformError(e, 'parent_task_terminal'));
  });
});

describe('idempotent creation', () => {
  it('returns the original task for a repeated identical request', async () => {
    const first = await createTask({}, 'idem-1');
    const again = await createTask({}, 'idem-1');
    expect(again.replayed).toBe(true);
    expect(again.view.task.taskId).toBe(first.view.task.taskId);
  });

  it('rejects reuse of a key with a different request', async () => {
    await createTask({}, 'idem-2');
    await createTask({ input: { message: 'different' } }, 'idem-2').then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'idempotency_key_reused'),
    );
  });

  it('scopes keys per principal', async () => {
    const a = await createTask({}, 'idem-3', { kind: 'service', ref: 'caller-a' });
    const b = await createTask({}, 'idem-3', { kind: 'service', ref: 'caller-b' });
    expect(a.view.task.taskId).not.toBe(b.view.task.taskId);
  });

  it('creates exactly one task under concurrent duplicate requests', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => createTask({}, 'idem-race')));
    const ids = new Set(results.map((r) => r.view.task.taskId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const count = await platform.pool.query("select count(*)::int as n from agent_tasks where idempotency_key = 'idem-race'");
    expect(count.rows[0].n).toBe(1);
  });
});

describe('task lifecycle persistence', () => {
  it('persists valid transitions with full history and increments the version', async () => {
    const { task } = (await createTask()).view;
    const blocked = await platform.tasks.transitionTask({ taskId: task.taskId, to: 'blocked', reason: 'awaiting.input', actor, correlationId: 'c1' });
    expect(blocked).toMatchObject({ status: 'blocked', statusReason: 'awaiting.input', version: 2 });
    const pending = await platform.tasks.transitionTask({ taskId: task.taskId, to: 'pending', actor, correlationId: 'c2', expectedVersion: 2 });
    expect(pending).toMatchObject({ status: 'pending', statusReason: null, version: 3 });

    const stored = (await platform.tasks.getTask(task.taskId)).task;
    expect(agentTaskSchema.safeParse(stored).success).toBe(true);
    expect(stored).toMatchObject({ status: 'pending', version: 3 });
    const history = await new PostgresTaskRuntimeStore(platform.pool).listTransitions(task.taskId);
    expect(history.map((t) => [t.fromStatus, t.toStatus, t.taskVersion])).toEqual([
      [null, 'pending', 1],
      ['pending', 'blocked', 2],
      ['blocked', 'pending', 3],
    ]);
  });

  it('rejects invalid transitions and leaves durable state untouched', async () => {
    const { task } = (await createTask()).view;
    await platform.tasks.transitionTask({ taskId: task.taskId, to: 'cancelled', actor, correlationId: 'c' });
    for (const to of ['running', 'pending', 'completed'] as const) {
      await platform.tasks.transitionTask({ taskId: task.taskId, to, actor, correlationId: 'c' }).then(
        () => expect.unreachable(),
        (e: unknown) => expectPlatformError(e, 'invalid_transition'),
      );
    }
    await platform.tasks.transitionTask({ taskId: task.taskId, to: 'waiting', actor, correlationId: 'c' }).catch(() => undefined);
    const stored = (await platform.tasks.getTask(task.taskId)).task;
    expect(stored).toMatchObject({ status: 'cancelled', version: 2 });
    expect(await new PostgresTaskRuntimeStore(platform.pool).listTransitions(task.taskId)).toHaveLength(2);
  });

  it('enforces optimistic concurrency with expectedVersion', async () => {
    const { task } = (await createTask()).view;
    await platform.tasks.transitionTask({ taskId: task.taskId, to: 'blocked', actor, correlationId: 'c', expectedVersion: 1 });
    await platform.tasks.transitionTask({ taskId: task.taskId, to: 'cancelled', actor, correlationId: 'c', expectedVersion: 1 }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'version_conflict'),
    );
  });

  it('refuses transitions on unknown tasks', async () => {
    await platform.tasks.transitionTask({ taskId: '0190a0a0-0000-7000-8000-000000000000', to: 'running', actor, correlationId: 'c' }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'task_not_found'),
    );
  });

  it('rejects malformed reason codes', async () => {
    const { task } = (await createTask()).view;
    await platform.tasks.transitionTask({ taskId: task.taskId, to: 'blocked', reason: 'Free text!', actor, correlationId: 'c' }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'validation_failed'),
    );
  });
});

describe('runs', () => {
  it('starts a run by moving the task to running atomically', async () => {
    const { task } = (await createTask()).view;
    const { run, task: running } = await platform.tasks.startRun({ taskId: task.taskId, actor, correlationId: 'run-c' });
    expect(agentRunSchema.safeParse(run).success).toBe(true);
    expect(run).toMatchObject({ taskId: task.taskId, sequence: 1, status: 'running', agentId: PROBE_AGENT, agentVersion: 1, finishedAt: null, usage: { modelCalls: 0 } });
    expect(running).toMatchObject({ status: 'running', version: 2 });
    expect(await platform.tasks.getRun(run.runId)).toEqual(run);
    const view = await platform.tasks.getTask(task.taskId);
    expect(view.runs).toEqual([{ runId: run.runId, sequence: 1, status: 'running' }]);
  });

  it('allows at most one active run per task', async () => {
    const { task } = (await createTask()).view;
    await platform.tasks.startRun({ taskId: task.taskId, actor, correlationId: 'c' });
    await platform.tasks.startRun({ taskId: task.taskId, actor, correlationId: 'c' }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'run_already_active'),
    );
  });

  it('enforces the single-active-run invariant under concurrency', async () => {
    const { task } = (await createTask()).view;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => platform.tasks.startRun({ taskId: task.taskId, actor, correlationId: 'c' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const active = await platform.pool.query("select count(*)::int as n from agent_runs where task_id = $1 and status = 'running'", [task.taskId]);
    expect(active.rows[0].n).toBe(1);
  });

  it('finishes runs with usage and structured result, then numbers the next run sequentially', async () => {
    const { task } = (await createTask()).view;
    const { run } = await platform.tasks.startRun({ taskId: task.taskId, actor, correlationId: 'c' });
    const finished = await platform.tasks.finishRun({
      runId: run.runId,
      status: 'completed',
      usage: { modelCalls: 2, inputTokens: 120, outputTokens: 40, capabilityCalls: 1 },
      result: { summary: 'structured outcome only' },
      correlationId: 'c',
      expectedVersion: 1,
    });
    expect(finished).toMatchObject({ status: 'completed', version: 2, usage: { modelCalls: 2 }, result: { summary: 'structured outcome only' } });
    expect(finished.finishedAt).not.toBeNull();

    await platform.tasks.finishRun({ runId: run.runId, status: 'completed', correlationId: 'c' }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'run_not_active'),
    );
    const second = await platform.tasks.startRun({ taskId: task.taskId, actor, correlationId: 'c' });
    expect(second.run.sequence).toBe(2);
  });

  it('requires a failure exactly for failed runs', async () => {
    const { task } = (await createTask()).view;
    const { run } = await platform.tasks.startRun({ taskId: task.taskId, actor, correlationId: 'c' });
    await platform.tasks.finishRun({ runId: run.runId, status: 'failed', correlationId: 'c' }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'validation_failed'),
    );
    const failed = await platform.tasks.finishRun({ runId: run.runId, status: 'failed', failure: { code: 'model.timeout', message: 'gateway timeout' }, correlationId: 'c' });
    expect(failed.failure).toEqual({ code: 'model.timeout', message: 'gateway timeout' });
  });

  it('does not let a task leave running while a run is active, except by cancellation', async () => {
    const { task } = (await createTask()).view;
    const { run } = await platform.tasks.startRun({ taskId: task.taskId, actor, correlationId: 'c' });
    await platform.tasks.transitionTask({ taskId: task.taskId, to: 'completed', actor, correlationId: 'c' }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'active_run_in_progress'),
    );
    const cancelled = await platform.tasks.transitionTask({ taskId: task.taskId, to: 'cancelled', actor, correlationId: 'c' });
    expect(cancelled.status).toBe('cancelled');
    expect((await platform.tasks.getRun(run.runId)).status).toBe('cancelled');
  });

  it('does not start runs for blocked, approval-gated or terminal tasks', async () => {
    const { task } = (await createTask()).view;
    await platform.tasks.transitionTask({ taskId: task.taskId, to: 'blocked', actor, correlationId: 'c' });
    await platform.tasks.startRun({ taskId: task.taskId, actor, correlationId: 'c' }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'task_not_runnable'),
    );
  });
});

describe('goals', () => {
  it('persists root → subgoal relationships and an explicit current goal', async () => {
    const { task } = (await createTask()).view;
    const sub = await platform.tasks.addSubgoal({ taskId: task.taskId, parentGoalId: task.rootGoalId, goal: { description: 'look up a test fact' }, correlationId: 'c' });
    expect(goalSchema.safeParse(sub).success).toBe(true);
    expect(sub).toMatchObject({ parentGoalId: task.rootGoalId, origin: 'agent', status: 'active' });

    const nested = await platform.tasks.addSubgoal({ taskId: task.taskId, parentGoalId: sub.goalId, goal: { description: 'nested', successCriteria: ['fact found'] }, makeCurrent: true, correlationId: 'c' });
    let view = await platform.tasks.getTask(task.taskId);
    expect(view.task.currentGoalId).toBe(nested.goalId);
    expect(view.task.rootGoalId).toBe(task.rootGoalId);
    expect(view.goals.map((g) => [g.goalId, g.parentGoalId])).toEqual([
      [task.rootGoalId, null],
      [sub.goalId, task.rootGoalId],
      [nested.goalId, sub.goalId],
    ]);

    const closed = await platform.tasks.closeGoal({ taskId: task.taskId, goalId: nested.goalId, status: 'achieved', correlationId: 'c' });
    expect(closed).toMatchObject({ status: 'achieved', version: 2 });
    // Closing never moves the pointer implicitly; focus is set explicitly.
    view = await platform.tasks.getTask(task.taskId);
    expect(view.task.currentGoalId).toBe(nested.goalId);
    const refocused = await platform.tasks.setCurrentGoal({ taskId: task.taskId, goalId: sub.goalId, correlationId: 'c' });
    expect(refocused.currentGoalId).toBe(sub.goalId);
  });

  it('rejects goals from another task, closed parents, reopening and focus on closed goals', async () => {
    const a = (await createTask()).view.task;
    const b = (await createTask()).view.task;
    await platform.tasks.addSubgoal({ taskId: a.taskId, parentGoalId: b.rootGoalId, goal: { description: 'x' }, correlationId: 'c' }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'goal_not_found'),
    );
    const sub = await platform.tasks.addSubgoal({ taskId: a.taskId, parentGoalId: a.rootGoalId, goal: { description: 'x' }, correlationId: 'c' });
    await platform.tasks.closeGoal({ taskId: a.taskId, goalId: sub.goalId, status: 'abandoned', correlationId: 'c' });
    await platform.tasks.addSubgoal({ taskId: a.taskId, parentGoalId: sub.goalId, goal: { description: 'y' }, correlationId: 'c' }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'parent_goal_not_active'),
    );
    await platform.tasks.closeGoal({ taskId: a.taskId, goalId: sub.goalId, status: 'achieved', correlationId: 'c' }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'invalid_goal_transition'),
    );
    await platform.tasks.setCurrentGoal({ taskId: a.taskId, goalId: sub.goalId, correlationId: 'c' }).then(
      () => expect.unreachable(),
      (e: unknown) => expectPlatformError(e, 'goal_not_active'),
    );
  });

  it('enforces one root goal per task and same-task parents in the database itself', async () => {
    const a = (await createTask()).view.task;
    const b = (await createTask()).view.task;
    const insert = (goalId: string, taskId: string, parent: string | null) =>
      platform.pool.query(
        `insert into goals (goal_id, task_id, parent_goal_id, description, success_criteria, status, origin, correlation_id, version, created_at, updated_at)
         values ($1, $2, $3, 'direct', '{}', 'active', 'agent', 'c', 1, now(), now())`,
        [goalId, taskId, parent],
      );
    await expect(insert('0190a0a0-0000-7000-8000-0000000000a1', a.taskId, null)).rejects.toMatchObject({ code: '23505' });
    await expect(insert('0190a0a0-0000-7000-8000-0000000000a2', a.taskId, b.rootGoalId)).rejects.toMatchObject({ code: '23503' });
  });
});
