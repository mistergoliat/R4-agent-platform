import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Platform } from '@r4/api';
import type { ResponseAuthorityInput, ResponseAuthorityValidator, ResponseAuthorityVerdict } from '@r4/contracts';
import type { ModelRequest } from '@r4/model-gateway';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { createActionTask, startActionPlatform } from '../support/actions.js';
import { startTestWorker, stepsOf, type TestWorker } from '../support/worker.js';
import { complete, respond, sequence } from '../support/decisions.js';
import { drain, setTemporalOffset, testScheduler, waitRows } from '../support/temporal.js';
import { GET_TEST_FACT_ID } from '../fixtures/capabilities/get-test-fact.js';

/**
 * R4-J1E-R2 (ADR-031) over the real runtime: a draft whose owner evidence is
 * about to expire is deferred on a durable WAIT_UNTIL (no sleep, no refresh
 * inside the owner's window); the worker process may die while waiting; the
 * scheduler wakes the task and a NEW worker revalidates and records the SAME
 * draft before any model call — the draft, the intent and the evidence live
 * only in PostgreSQL.
 */
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
  const w = await startTestWorker(db.url, { workerId: `authority-worker-${workers.length}`, ...options });
  workers.push(w);
  return w;
}

/** Domain-free validator: evidence is "near expiry" until the platform refreshed it with a READ. */
class NearExpiryValidator implements ResponseAuthorityValidator {
  readonly notBefore = new Date(Date.now() + 1_000).toISOString();
  checks = 0;
  constructor(private readonly afterRefresh: (input: ResponseAuthorityInput) => ResponseAuthorityVerdict = () => ({ kind: 'allow' })) {}
  validate(input: ResponseAuthorityInput): ResponseAuthorityVerdict {
    this.checks += 1;
    const refreshed = input.observations.some((o) => o.outcome === 'succeeded' && o.source.kind === 'capability' && o.source.capabilityId === GET_TEST_FACT_ID);
    return refreshed ? this.afterRefresh(input) : { kind: 'revalidation_required', notBefore: this.notBefore, reads: [{ capabilityId: GET_TEST_FACT_ID, arguments: { factKey: 'alpha' } }] };
  }
  degraded(): string {
    return 'safe degraded reply';
  }
}

const modelCalls = async (runId: string) => (await platform.pool.query<{ model_calls: number }>('select model_calls from agent_runs where run_id = $1', [runId])).rows[0]!.model_calls;
const shape = (steps: Awaited<ReturnType<typeof stepsOf>>) => steps.map((s) => [s.decision?.type ?? null, s.outcome, s.origin, s.error?.code ?? null]);

describe('R4-J1E-R2 durable revalidation wait (PostgreSQL, scheduler, worker restart)', () => {
  it('M. defers without an owner READ, survives the worker process, wakes on the durable timer, then sends the same draft', async () => {
    const taskId = await createActionTask(platform);
    const validator = new NearExpiryValidator();
    const first = await worker({ script: sequence([respond('the price is 84.990')]), responseAuthority: validator });
    await first.platform.worker.runOnce();

    const waiting = await platform.tasks.getTask(taskId);
    expect(waiting.task.status).toBe('waiting');
    expect(waiting.runs.map((r) => r.status)).toEqual(['suspended']);
    const run1 = await stepsOf(platform.pool, waiting.runs[0]!.runId);
    expect(shape(run1)).toEqual([
      ['respond', 'refused', 'model', 'response_authority_deferred'],
      ['wait', 'recorded', 'platform', null],
    ]);
    expect(run1[1]!.decision).toEqual({ type: 'wait', condition: { kind: 'WAIT_UNTIL', until: validator.notBefore }, reason: expect.any(String) });
    expect(run1[1]!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(await modelCalls(waiting.runs[0]!.runId)).toBe(1); // the platform wait is not a model call
    expect((await platform.pool.query('select count(*)::int as n from observations where task_id = $1', [taskId])).rows[0].n).toBe(0);
    expect(await waitRows(platform.pool, taskId)).toEqual([{ kind: 'WAIT_UNTIL', status: 'waiting', resolution: null }]);

    // The worker process is gone while the task waits; only PostgreSQL remembers the draft.
    await first.platform.close();
    workers.splice(workers.indexOf(first), 1);

    const { scheduler } = testScheduler(platform.pool);
    expect(await drain(scheduler)).toBe(0); // not before notBefore
    await setTemporalOffset(platform.pool, 5_000);
    expect(await drain(scheduler)).toBe(1);
    expect(await waitRows(platform.pool, taskId)).toEqual([{ kind: 'WAIT_UNTIL', status: 'completed', resolution: 'timer' }]);

    const seen: ModelRequest[] = [];
    const second = await worker({ script: sequence([(r) => (seen.push(r), complete('done'))]), responseAuthority: new NearExpiryValidator() });
    await second.platform.worker.runOnce();

    const done = await platform.tasks.getTask(taskId);
    expect(done.task.status).toBe('completed');
    expect(done.runs).toHaveLength(2);
    const run2 = await stepsOf(platform.pool, done.runs[1]!.runId);
    expect(shape(run2)).toEqual([
      ['read_capability', 'observed', 'platform', null],
      ['respond', 'recorded', 'platform', null],
      ['complete', 'recorded', 'model', null],
    ]);
    expect(run2[1]!.decision).toEqual({ type: 'respond', content: 'the price is 84.990' });
    // L: the response names a snapshot of its OWN (run, iteration) — enforced by the durable FK as well.
    const snapshot = await platform.pool.query('select run_id, iteration from context_snapshots where snapshot_id = $1', [run2[1]!.contextSnapshotId]);
    expect(snapshot.rows[0]).toMatchObject({ run_id: done.runs[1]!.runId, iteration: run2[1]!.iteration });
    // The model was asked only after the reply was recorded, and sees it as said.
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).toContain('the price is 84.990');
    expect(await modelCalls(done.runs[1]!.runId)).toBe(1);
    // Exactly one recorded response for the task: nothing duplicated across the runs.
    const said = await platform.pool.query(`select count(*)::int as n from agent_run_steps where task_id = $1 and decision_type = 'respond' and outcome = 'recorded'`, [taskId]);
    expect(said.rows[0].n).toBe(1);
  });

  it('the run-scoped budget survives the wait: a draft already corrected once is degraded (once) if the truth changed at wake-up', async () => {
    const taskId = await createActionTask(platform);
    const changed = (input: ResponseAuthorityInput): ResponseAuthorityVerdict =>
      input.content.startsWith('corrected') || input.content === 'bad' ? { kind: 'reject', code: 'response_authority_contradiction', feedback: 'changed' } : { kind: 'allow' };
    const first = await worker({
      script: sequence([respond('bad'), respond('corrected draft')]),
      responseAuthority: {
        validate: (input) => (input.content === 'bad' ? { kind: 'reject', code: 'response_authority_contradiction', feedback: 'wrong' } : new NearExpiryValidator().validate(input)),
        degraded: () => 'safe degraded reply',
      },
    });
    await first.platform.worker.runOnce();
    await setTemporalOffset(platform.pool, 5_000);
    expect(await drain(testScheduler(platform.pool).scheduler)).toBe(1);
    const second = await worker({ script: sequence([complete('done')]), responseAuthority: new NearExpiryValidator(changed) });
    await second.platform.worker.runOnce();
    const { runs } = await platform.tasks.getTask(taskId);
    expect(shape(await stepsOf(platform.pool, runs[0]!.runId))).toEqual([
      ['respond', 'refused', 'model', 'response_authority_contradiction'],
      ['respond', 'refused', 'model', 'response_authority_deferred'],
      ['wait', 'recorded', 'platform', null],
    ]);
    expect(shape(await stepsOf(platform.pool, runs[1]!.runId))).toEqual([
      ['read_capability', 'observed', 'platform', null],
      ['respond', 'refused', 'platform', 'response_authority_degraded'],
      ['respond', 'recorded', 'platform', null],
      ['complete', 'recorded', 'model', null],
    ]);
    const said = await platform.pool.query(`select decision->>'content' as content from agent_run_steps where task_id = $1 and decision_type = 'respond' and outcome = 'recorded'`, [taskId]);
    expect(said.rows).toEqual([{ content: 'safe degraded reply' }]);
  });
});
