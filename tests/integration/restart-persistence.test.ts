import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, uuidV7Generator } from '@r4/contracts';
import { CapabilityInvoker, CapabilityRegistry } from '@r4/capability-runtime';
import { createSilentLogger } from '@r4/observability';
import { PostgresObservationStore, PostgresTaskRuntimeStore } from '@r4/persistence-postgres';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { startTestPlatform, validTaskBody } from '../support/platform.js';
import { GET_TEST_FACT_ID, getTestFactCapability } from '../fixtures/capabilities/get-test-fact.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

/**
 * Simulates a process restart: the first platform instance is fully torn down
 * (HTTP server closed, every connection released, all in-memory objects
 * dropped). A brand-new instance must see exactly the same durable state.
 */
describe('state survives a process restart', () => {
  it('tasks, goals, runs, transitions and observations are recovered by a fresh process', async () => {
    const actor = { kind: 'service', ref: 'restart-test' } as const;
    const first = await startTestPlatform(db.url);
    const created = await first.app.inject({ method: 'POST', url: '/v1/tasks', payload: validTaskBody({ taskType: 'probe.fact_lookup' }), headers: { 'idempotency-key': 'restart-1' } });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.taskId as string;
    const rootGoalId = created.json().task.rootGoalId as string;

    const sub = await first.tasks.addSubgoal({ taskId, parentGoalId: rootGoalId, goal: { description: 'survive restart' }, makeCurrent: true, correlationId: 'c' });
    const { run } = await first.tasks.startRun({ taskId, actor, correlationId: 'c' });
    const registry = new CapabilityRegistry();
    registry.register(getTestFactCapability());
    const invoker = new CapabilityInvoker({ registry, observations: new PostgresObservationStore(first.pool), ids: uuidV7Generator(), clock: systemClock, logger: createSilentLogger() });
    const observation = await invoker.invoke(
      { capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } },
      { taskId, runId: run.runId, agentId: 'platform-probe', agentVersion: 1, correlationId: 'c', grantedScopes: ['platform_test.read'] },
    );
    const before = (await first.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}` })).json();
    const transitionsBefore = await new PostgresTaskRuntimeStore(first.pool).listTransitions(taskId);
    await first.close();

    const second = await startTestPlatform(db.url);
    try {
      const after = await second.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}` });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual(before);
      expect(after.json().task).toMatchObject({ status: 'running', currentGoalId: sub.goalId });

      expect((await second.app.inject({ method: 'GET', url: `/v1/runs/${run.runId}` })).json()).toEqual(run);
      expect(await new PostgresTaskRuntimeStore(second.pool).listTransitions(taskId)).toEqual(transitionsBefore);
      expect(await new PostgresObservationStore(second.pool).listByTask(taskId)).toEqual([observation]);

      // Invariants still enforced after restart: the pre-crash run is still the active one.
      await expect(second.tasks.startRun({ taskId, actor, correlationId: 'c' })).rejects.toMatchObject({ code: 'run_already_active' });
      // Idempotency survives restart: the same key replays the original task.
      const replay = await second.app.inject({ method: 'POST', url: '/v1/tasks', payload: validTaskBody({ taskType: 'probe.fact_lookup' }), headers: { 'idempotency-key': 'restart-1' } });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().task.taskId).toBe(taskId);
      // Work continues where it left off.
      const finished = await second.tasks.finishRun({ runId: run.runId, status: 'completed', correlationId: 'c' });
      expect(finished.status).toBe('completed');
      expect((await second.tasks.startRun({ taskId, actor, correlationId: 'c' })).run.sequence).toBe(2);
    } finally {
      await second.close();
    }
  });
});
