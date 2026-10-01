import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextSnapshotSchema, systemClock, uuidV7Generator, type Principal } from '@r4/contracts';
import { AgentKernel, type KernelOutcome } from '@r4/agent-kernel';
import { AgentRegistry } from '@r4/agent-registry';
import { ContextCompiler, DeterministicCompactor, MemoryContextSource, contentHashOf, platformContextSources, snapshotComposition, type ContextSource } from '@r4/context-compiler';
import { DefaultModelGateway, FakeModelProvider, type FakeModelScript } from '@r4/model-gateway';
import { createSilentLogger } from '@r4/observability';
import {
  PostgresAgentDefinitionStore,
  PostgresContextSnapshotStore,
  PostgresExecutionStore,
  PostgresMemoryStore,
  PostgresObservationStore,
  type Pool,
} from '@r4/persistence-postgres';
import { ExecutionRuntime } from '@r4/task-runtime';
import { DurableKernelSession, type WorkerCycle } from '@r4/worker';
import type { Platform } from '@r4/api';
import { GET_TEST_FACT_ID } from '../fixtures/capabilities/get-test-fact.js';
import { createMigratedTestDatabase, openPool, type TestDatabase } from '../support/database.js';
import { compiledOf, complete, completeFromObservations, read, sequence } from '../support/decisions.js';
import { captureLogs } from '../support/logs.js';
import { startTestPlatform, validTaskBody } from '../support/platform.js';
import { TEST_CONTEXT_POLICY, TEST_POLICY, expireLease, startTestWorker, stepsOf, testCapabilities, waitFor, type TestWorker, type TestWorkerOptions } from '../support/worker.js';

const actor: Principal = { kind: 'service', ref: 'context-it' };
let db: TestDatabase;
let platform: Platform;
const cleanups: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  db = await createMigratedTestDatabase();
  platform = await startTestPlatform(db.url);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await platform?.close();
  await db?.drop();
});

async function worker(options: Omit<TestWorkerOptions, 'workerId'> & { workerId?: string }): Promise<TestWorker> {
  const w = await startTestWorker(db.url, { workerId: options.workerId ?? `ctx-worker-${cleanups.length + 1}`, ...options });
  cleanups.push(() => w.platform.close());
  return w;
}

async function createTask(): Promise<{ taskId: string; correlationId: string }> {
  const { view } = await platform.tasks.createTask({
    request: validTaskBody({ taskType: 'probe.fact_lookup', goal: { description: 'Retrieve test fact and complete task' }, input: { factKey: 'platform.name' } }),
    requestedBy: actor,
    correlationId: 'context-it',
  });
  return { taskId: view.task.taskId, correlationId: view.task.correlationId };
}

async function runUntilExecuted(w: TestWorker): Promise<Extract<WorkerCycle, { kind: 'executed' }>> {
  return waitFor(async () => {
    const cycle = await w.platform.worker.runOnce();
    return cycle.kind === 'executed' ? cycle : null;
  }, 15_000, 50);
}

const snapshots = () => new PostgresContextSnapshotStore(platform.pool);
const memory = () => new PostgresMemoryStore(platform.pool);

async function remember(taskId: string, text: string, occurredAt = new Date().toISOString()) {
  return memory().append({
    entryId: uuidV7Generator().next(),
    taskId,
    memoryType: 'CONVERSATIONAL',
    occurredAt,
    recordedAt: occurredAt,
    recordedBy: { kind: 'service', ref: 'channel-adapter' },
    correlationId: 'context-it',
    content: { actor: { role: 'requester', ref: 'participant-1' }, text, interactionRef: 'interaction-1' },
  });
}

/**
 * A worker that dies during its model call: own pool and runtime, same
 * context compiler composition as the platform, no heartbeat. Its lease is
 * expired on the database clock at the moment of "death".
 */
async function dyingWorker(script: FakeModelScript) {
  const pool: Pool = openPool(db.url);
  const logger = createSilentLogger();
  const ids = uuidV7Generator();
  const execution = new ExecutionRuntime({ store: new PostgresExecutionStore(pool), ids, clock: systemClock, logger, maxRunRecoveries: 3 });
  const claim = await execution.claimNext({ workerId: 'worker-a', leaseDurationMs: 60_000 });
  if (!claim || claim.kind === 'abandoned') throw new Error('dying worker could not claim');
  const provider = new FakeModelProvider(script);
  const kernel = new AgentKernel({ gateway: new DefaultModelGateway({ provider, logger }), logger });
  const session = new DurableKernelSession({
    lease: claim.lease,
    execution,
    agents: new AgentRegistry({ store: new PostgresAgentDefinitionStore(pool), clock: systemClock, logger }),
    capabilities: testCapabilities(),
    observations: new PostgresObservationStore(pool),
    policy: { ...TEST_POLICY, modelCallTimeoutMs: 3_000 },
    context: new ContextCompiler({ sources: [...platformContextSources(), new MemoryContextSource(new PostgresMemoryStore(pool))], policy: TEST_CONTEXT_POLICY, logger }),
    ids,
    clock: systemClock,
    logger,
  });
  const outcome: Promise<KernelOutcome> = kernel.run(session, { workerId: 'worker-a' });
  cleanups.push(async () => {
    await outcome;
    await pool.end();
  });
  return { claim, provider, outcome };
}

describe('ContextSnapshot per model call', () => {
  it('ties every step to the exact, durable, schema-valid context its model call received', async () => {
    const { taskId } = await createTask();
    const logs = captureLogs();
    const w = await worker({ script: sequence([read(GET_TEST_FACT_ID, { factKey: 'platform.name' }), completeFromObservations('done')]), logger: logs.logger });
    const cycle = await runUntilExecuted(w);
    expect(cycle.outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'completed' } });

    const steps = await stepsOf(platform.pool, cycle.runId);
    const stored = await snapshots().listForRun(cycle.runId);
    expect(stored.map((s) => [s.iteration, s.attempt, s.supersedesSnapshotId])).toEqual([[1, 1, null], [2, 1, null]]);
    expect(steps.map((s) => s.contextSnapshotId)).toEqual(stored.map((s) => s.snapshotId));

    for (const [index, snapshot] of stored.entries()) {
      expect(contextSnapshotSchema.parse(snapshot)).toEqual(snapshot);
      // Reconstruction: the stored snapshot IS what the model received.
      expect(snapshot.compiledContext).toEqual(compiledOf(w.provider.requests[index]!));
      expect(contentHashOf(snapshot.compiledContext)).toBe(snapshot.contentHash);
      expect(snapshot.budget.mode === 'fixed' && snapshot.estimatedTokens <= snapshot.budget.maxEstimatedTokens).toBe(true);
      // The worker policy is unbounded (default); the agent definition's own ceiling (8000) makes it FIXED(8000).
      expect(snapshot.budget).toEqual({ mode: 'fixed', maxEstimatedTokens: 8_000 });
      expect(snapshot.compiledContext.budget.policy).toEqual(snapshot.budget);
      expect(snapshot.decisions.length).toBeGreaterThan(0);
    }
    // New evidence → new snapshot: the observation appears in iteration 2 only.
    const [observation] = await new PostgresObservationStore(platform.pool).listByTask(taskId);
    expect(stored[0]!.compiledContext.sections.observations).toEqual([]);
    expect(stored[1]!.compiledContext.sections.observations.map((o) => o.itemId)).toEqual([`observation:${observation!.observationId}`]);
    expect(stored[1]!.decisions.find((d) => d.kind === 'observation')).toMatchObject({ decision: 'included', section: 'observations', freshness: 'fresh' });

    // The run points at its latest snapshot.
    expect((await platform.tasks.getRun(cycle.runId)).contextSnapshotRef).toBe(stored[1]!.snapshotId);
    expect(logs.events('context.snapshot.persisted').map((e) => [e.iteration, e.attempt, e.snapshotId])).toEqual(stored.map((s) => [s.iteration, 1, s.snapshotId]));
  });

  it('persists the snapshot BEFORE calling the model', async () => {
    await createTask();
    const w = await worker({ script: [{ type: 'timeout' }], policy: { modelCallTimeoutMs: 20_000 } });
    w.platform.worker.start();
    await waitFor(() => w.provider.callCount === 1);
    // The model is being called right now: its context is already durable, no step exists yet.
    const [row] = (await platform.pool.query<{ run_id: string; iteration: number }>('select run_id, iteration from context_snapshots')).rows;
    expect(row).toMatchObject({ iteration: 1 });
    expect(await stepsOf(platform.pool, row!.run_id)).toEqual([]);
    const [stored] = await snapshots().listForRun(row!.run_id);
    expect(stored!.compiledContext).toEqual(compiledOf(w.provider.requests[0]!));
  });

  it('snapshots and their item decisions are immutable in the database', async () => {
    await createTask();
    const w = await worker({ script: [complete('done')] });
    const cycle = await runUntilExecuted(w);
    const [snapshot] = await snapshots().listForRun(cycle.runId);
    await expect(platform.pool.query('update context_snapshots set estimated_tokens = 0 where snapshot_id = $1', [snapshot!.snapshotId])).rejects.toThrow(/immutable/);
    await expect(platform.pool.query('delete from context_snapshots where snapshot_id = $1', [snapshot!.snapshotId])).rejects.toThrow(/immutable/);
    await expect(platform.pool.query('update context_snapshot_items set decision = $2 where snapshot_id = $1', [snapshot!.snapshotId, 'excluded'])).rejects.toThrow(/immutable/);
    await expect(platform.pool.query('delete from context_snapshot_items where snapshot_id = $1', [snapshot!.snapshotId])).rejects.toThrow(/immutable/);
    expect(await snapshots().get(snapshot!.snapshotId)).toEqual(snapshot);
  });

  it('terminates with budget_exhausted — without calling the model — when required context cannot fit', async () => {
    await createTask();
    const w = await worker({ script: [complete('never')], context: { budget: { mode: 'fixed', maxEstimatedTokens: 200 } } });
    const cycle = await runUntilExecuted(w);
    expect(cycle.outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'budget_exhausted', code: 'max_context_tokens', details: { dimension: 'maxContextTokens', limit: 200 } } });
    expect(w.provider.callCount).toBe(0);
    expect(await stepsOf(platform.pool, cycle.runId)).toEqual([]);
    expect(await snapshots().listForRun(cycle.runId)).toEqual([]);
  });
});

describe('recovery semantics', () => {
  it('reuses the snapshot of a logical attempt that died during its model call', async () => {
    const { taskId } = await createTask();
    const a = await dyingWorker([{ type: 'timeout', ignoreAbort: true }]);
    await waitFor(() => a.provider.callCount === 1);
    const [attempt] = await snapshots().listForRun(a.claim.run.runId);
    await expireLease(platform.pool, taskId);

    const logs = captureLogs();
    const b = await worker({ workerId: 'worker-b', script: [complete('recovered')], logger: logs.logger });
    const cycle = await runUntilExecuted(b);
    expect(cycle).toMatchObject({ claim: 'resumed', takeover: true, outcome: { kind: 'terminated', termination: { reason: 'completed' } } });

    // Same logical iteration → same snapshot: no second attempt, byte-identical model input.
    expect(await snapshots().listForRun(a.claim.run.runId)).toEqual([attempt]);
    expect(compiledOf(b.provider.requests[0]!)).toEqual(attempt!.compiledContext);
    expect(compiledOf(b.provider.requests[0]!)).toEqual(compiledOf(a.provider.requests[0]!));
    expect((await stepsOf(platform.pool, cycle.runId)).map((s) => [s.iteration, s.contextSnapshotId, s.leaseGeneration])).toEqual([[1, attempt!.snapshotId, 2]]);
    expect(logs.events('context.snapshot.reused')).toEqual([expect.objectContaining({ iteration: 1, attempt: 1, snapshotId: attempt!.snapshotId, workerId: 'worker-b' })]);
    expect(logs.events('context.snapshot.persisted')).toEqual([]);
    // Accounting reported on reuse is the reused snapshot's own (what the model actually receives).
    expect(logs.events('context.compile.completed')).toEqual([
      expect.objectContaining({ snapshotId: attempt!.snapshotId, reused: true, compiledEstimatedTokens: snapshotComposition(attempt!).compiledEstimatedTokens }),
    ]);
    expect(await a.outcome).toEqual({ kind: 'interrupted', cause: 'lease_lost' });
  });

  it('compiles a new attempt when the effective budget policy changed, never reusing an incompatible snapshot', async () => {
    const { taskId } = await createTask();
    // A: operator policy UNBOUNDED; the probe agent's own ceiling (8000) makes it FIXED(8000).
    const a = await dyingWorker([{ type: 'timeout', ignoreAbort: true }]);
    await waitFor(() => a.provider.callCount === 1);
    const [first] = await snapshots().listForRun(a.claim.run.runId);
    expect(first!.budget).toEqual({ mode: 'fixed', maxEstimatedTokens: 8_000 });
    await expireLease(platform.pool, taskId);

    // B: same durable state, but the operator now runs FIXED(6000) → effective FIXED(6000).
    const b = await worker({ workerId: 'worker-b', script: [complete('recovered')], context: { budget: { mode: 'fixed', maxEstimatedTokens: 6_000 } } });
    const cycle = await runUntilExecuted(b);
    expect(cycle.outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'completed' } });
    const stored = await snapshots().listForRun(cycle.runId);
    expect(stored.map((s) => [s.attempt, s.budget, s.supersedesSnapshotId])).toEqual([
      [1, { mode: 'fixed', maxEstimatedTokens: 8_000 }, null],
      [2, { mode: 'fixed', maxEstimatedTokens: 6_000 }, first!.snapshotId],
    ]);
    expect(stored[0]).toEqual(first);
    expect(compiledOf(b.provider.requests[0]!).budget.policy).toEqual({ mode: 'fixed', maxEstimatedTokens: 6_000 });
  });

  it('compiles a new attempt when a durable transition happened in between, superseding (not rewriting) the old one', async () => {
    const { taskId } = await createTask();
    const a = await dyingWorker([{ type: 'timeout', ignoreAbort: true }]);
    await waitFor(() => a.provider.callCount === 1);
    const [first] = await snapshots().listForRun(a.claim.run.runId);
    // New information arrives while the attempt is orphaned.
    const turn = await remember(taskId, 'please also check the phase');
    await expireLease(platform.pool, taskId);

    const b = await worker({ workerId: 'worker-b', script: [complete('recovered')] });
    const cycle = await runUntilExecuted(b);
    expect(cycle.outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'completed' } });

    const stored = await snapshots().listForRun(cycle.runId);
    expect(stored.map((s) => [s.iteration, s.attempt, s.supersedesSnapshotId])).toEqual([[1, 1, null], [1, 2, first!.snapshotId]]);
    expect(stored[0]).toEqual(first);
    expect(stored[1]!.compiledContext.sections.conversation.map((i) => i.itemId)).toEqual([`memory:${turn.entryId}`]);
    expect(compiledOf(b.provider.requests[0]!)).toEqual(stored[1]!.compiledContext);
    expect((await stepsOf(platform.pool, cycle.runId))[0]!.contextSnapshotId).toBe(stored[1]!.snapshotId);
  });

  it('is fenced: a worker that lost its lease cannot record a snapshot', async () => {
    const { taskId } = await createTask();
    const execution = new ExecutionRuntime({ store: new PostgresExecutionStore(platform.pool), ids: uuidV7Generator(), clock: systemClock, logger: createSilentLogger(), maxRunRecoveries: 3 });
    const claim = await execution.claimNext({ workerId: 'fenced-worker', leaseDurationMs: 60_000 });
    if (!claim || claim.kind === 'abandoned') throw new Error('no claim');
    const b = await worker({ workerId: 'worker-b', script: [complete('done')] });
    await expireLease(platform.pool, taskId);
    await runUntilExecuted(b);
    const [valid] = await snapshots().listForRun(claim.run.runId);
    await expect(
      execution.recordContextSnapshot(claim.lease, {
        runId: claim.run.runId,
        iteration: 1,
        compilerVersion: valid!.compilerVersion,
        policyVersion: valid!.policyVersion,
        compiledContext: valid!.compiledContext,
        contentHash: valid!.contentHash,
        inputFingerprint: valid!.inputFingerprint,
        estimatedTokens: valid!.estimatedTokens,
        budget: valid!.budget,
        decisions: valid!.decisions,
        newSummaries: [],
      }),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    expect(await snapshots().listForRun(claim.run.runId)).toHaveLength(1);
  });
});

describe('context accounting (ADR-015)', () => {
  it('is derivable from durable item decisions, matches telemetry, and aggregates in plain SQL', async () => {
    const { taskId } = await createTask();
    await remember(taskId, 'a remark that becomes part of the context');
    const logs = captureLogs();
    const w = await worker({ script: sequence([read(GET_TEST_FACT_ID, { factKey: 'platform.name' }), completeFromObservations('done')]), logger: logs.logger });
    const cycle = await runUntilExecuted(w);
    const stored = await snapshots().listForRun(cycle.runId);
    const events = logs.events('context.compile.completed');
    expect(events.map((e) => e.snapshotId)).toEqual(stored.map((s) => s.snapshotId));

    for (const [index, snapshot] of stored.entries()) {
      const c = snapshotComposition(snapshot);
      // Telemetry reports exactly the durable accounting (aggregated, no content).
      expect(events[index]).toMatchObject({
        taskId,
        runId: cycle.runId,
        iteration: snapshot.iteration,
        reused: false,
        budgetMode: 'fixed',
        maxEstimatedTokens: 8_000,
        rawEstimatedTokens: c.rawEstimatedTokens,
        compiledEstimatedTokens: c.compiledEstimatedTokens,
        includedEstimatedTokens: c.includedEstimatedTokens,
        excludedEstimatedTokens: c.excludedEstimatedTokens,
        includedCount: c.includedCount,
        excludedCount: c.excludedCount,
        compactedCount: c.compactedCount,
        includedTokensByKind: Object.fromEntries(Object.entries(c.byKind).map(([k, t]) => [k, t.included.estimatedTokens])),
        includedTokensByAuthority: Object.fromEntries(Object.entries(c.byAuthority).map(([k, t]) => [k, t.included.estimatedTokens])),
      });
      expect(c.compiledEstimatedTokens).toBe(snapshot.compiledContext.budget.estimatedTokens);
      expect(c.byKind.conversation_turn?.included.count).toBe(1);

      // The same numbers straight from the rows: analytics need no denormalized columns.
      const rows = await platform.pool.query<{ kind: string; decision: string; n: number; tokens: number }>(
        `select kind, decision, count(*)::int as n, sum(estimated_tokens)::int as tokens
           from context_snapshot_items where snapshot_id = $1 group by kind, decision order by kind, decision`,
        [snapshot.snapshotId],
      );
      for (const row of rows.rows) {
        const tally = (c.byKind as Record<string, { included: { count: number; estimatedTokens: number }; excluded: { count: number; estimatedTokens: number } }>)[row.kind]!;
        expect(tally[row.decision as 'included' | 'excluded']).toEqual({ count: row.n, estimatedTokens: row.tokens });
      }
      const [totals] = (await platform.pool.query<{ raw: number; compiled: number }>(
        `select (select sum(estimated_tokens)::int from context_snapshot_items where snapshot_id = s.snapshot_id) as raw, s.estimated_tokens as compiled
           from context_snapshots s where s.snapshot_id = $1`,
        [snapshot.snapshotId],
      )).rows;
      expect(totals).toEqual({ raw: c.rawEstimatedTokens, compiled: c.compiledEstimatedTokens });
    }
    expect(logs.raw()).not.toContain('a remark that becomes part of the context');
  });
});

describe('memory boundaries end to end', () => {
  it('memory needed for continuation survives a worker restart and enters the next context with its authority', async () => {
    const { taskId } = await createTask();
    const turn = await remember(taskId, 'the requester prefers short answers');
    const note = await memory().append({
      entryId: uuidV7Generator().next(),
      taskId,
      memoryType: 'WORKING',
      occurredAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      recordedBy: { kind: 'system', ref: 'fixture' },
      correlationId: 'context-it',
      content: { category: 'open_question', text: 'is the fact still current?' },
    });

    // Worker 1 reads, then stops (process "restart") mid-run. (A reply would end the turn: R4-J1E-R2.2.)
    const w1 = await startTestWorker(db.url, { workerId: 'worker-1', script: sequence([read(GET_TEST_FACT_ID, { factKey: 'alpha' }), { type: 'timeout' }]), policy: { modelCallTimeoutMs: 20_000 } });
    try {
      w1.platform.worker.start();
      await waitFor(() => w1.provider.callCount === 2);
    } finally {
      await w1.platform.close();
    }

    // Worker 2: a new composition with its own pool; only PostgreSQL is shared.
    const w2 = await worker({ workerId: 'worker-2', script: [complete('done')] });
    const cycle = await runUntilExecuted(w2);
    expect(cycle).toMatchObject({ claim: 'resumed', outcome: { kind: 'terminated', termination: { reason: 'completed' } } });
    const context = compiledOf(w2.provider.requests[0]!);
    expect(context.sections.conversation.map((i) => [i.itemId, i.authority, i.sourceId])).toEqual([[`memory:${turn.entryId}`, 'CONVERSATIONAL', 'platform.memory']]);
    // What worker 1 observed before the restart is evidence of the resumed run.
    expect(context.sections.observations.length).toBe(1);
    expect(context.sections.workingMemory.map((i) => [i.itemId, i.authority])).toEqual([[`memory:${note.entryId}`, 'COGNITIVE']]);
    expect(context.sections.authoritativeState).toEqual([]);
  });

  it('keeps memory append-only: no rewrite, no delete; expiry is recorded once and removes the item from context', async () => {
    const { taskId } = await createTask();
    const turn = await remember(taskId, 'temporary remark');
    await expect(platform.pool.query('update memory_entries set content = $2 where entry_id = $1', [turn.entryId, JSON.stringify({ text: 'rewritten' })])).rejects.toThrow(/immutable/);
    await expect(platform.pool.query('delete from memory_entries where entry_id = $1', [turn.entryId])).rejects.toThrow(/append-only/);
    const past = new Date(Date.now() - 1_000).toISOString();
    expect(await memory().expire(turn.entryId, past)).toBe(true);
    expect(await memory().expire(turn.entryId, past)).toBe(false);
    await expect(platform.pool.query('update memory_entries set expired_at = now() where entry_id = $1', [turn.entryId])).rejects.toThrow(/immutable/);

    const w = await worker({ script: [complete('done')] });
    const cycle = await runUntilExecuted(w);
    const [snapshot] = await snapshots().listForRun(cycle.runId);
    expect(snapshot!.compiledContext.sections.conversation).toEqual([]);
    expect(snapshot!.decisions.find((d) => d.itemId === `memory:${turn.entryId}`)).toMatchObject({ decision: 'excluded', reason: 'expired' });
    expect(await memory().listForTask(taskId)).toHaveLength(1);
  });

  it('refuses invalid memory at the boundary (SECRET, authority claims, unknown fields)', async () => {
    const { taskId } = await createTask();
    const base = { entryId: uuidV7Generator().next(), taskId, occurredAt: new Date().toISOString(), recordedAt: new Date().toISOString(), recordedBy: { kind: 'system' as const, ref: 'x' }, correlationId: 'c' };
    await expect(memory().append({ ...base, memoryType: 'WORKING', sensitivity: 'SECRET' as never, content: { category: 'note', text: 'k' } })).rejects.toMatchObject({ code: 'invalid_memory_entry' });
    await expect(memory().append({ ...base, memoryType: 'WORKING', content: { category: 'note', text: 'k', authority: 'AUTHORITATIVE' } as never })).rejects.toMatchObject({ code: 'invalid_memory_entry' });
  });
});

describe('compaction end to end', () => {
  it('compacts long conversation into a durable DERIVED_SUMMARY with provenance, keeps raw evidence, and reuses it', async () => {
    const { taskId } = await createTask();
    const start = Date.now() - 3_600_000;
    for (let i = 0; i < 120; i += 1) await remember(taskId, `turn ${i}: ${'filler words '.repeat(10)}`, new Date(start + i * 1_000).toISOString());

    const w = await worker({
      // Two model calls in one run (a reply would end the turn, R4-J1E-R2.2): iteration 2 must reuse the summary.
      script: sequence([read(GET_TEST_FACT_ID, { factKey: 'alpha' }), complete('done')]),
      compactor: new DeterministicCompactor(),
      context: { budget: { mode: 'fixed', maxEstimatedTokens: 6_000 }, conversation: { recentTurns: 10, compaction: { enabled: true, chunkTurns: 10 } } },
    });
    const cycle = await runUntilExecuted(w);
    expect(cycle.outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'completed' } });

    const entries = await memory().listForTask(taskId);
    const summaries = entries.filter((e) => e.memoryType === 'DERIVED_SUMMARY');
    expect(entries.filter((e) => e.memoryType === 'CONVERSATIONAL')).toHaveLength(120);
    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    expect(summary).toMatchObject({ recordedBy: { kind: 'system', ref: 'context-compiler' }, content: { derivation: { compactorId: 'deterministic-extractive', compactorVersion: '1' } } });
    if (summary!.memoryType !== 'DERIVED_SUMMARY') throw new Error('unreachable');
    expect(summary!.content.derivation.sourceItemIds).toEqual(entries.filter((e) => e.memoryType === 'CONVERSATIONAL').slice(0, 110).map((e) => `memory:${e.entryId}`));

    const stored = await snapshots().listForRun(cycle.runId);
    for (const snapshot of stored) {
      expect(snapshot.estimatedTokens).toBeLessThanOrEqual(6_000);
      expect(snapshot.compiledContext.sections.derivedMemory.map((i) => [i.itemId, i.authority])).toEqual([[`summary:${summary!.content.derivation.derivationKey}`, 'DERIVED']]);
      expect(snapshot.compiledContext.omissions.compacted).toBe(110);
    }
    // Iteration 2 found the stored summary: nothing was recompacted or duplicated.
    expect(stored).toHaveLength(2);
  });
});

describe('domain extension and secrets end to end', () => {
  it('registers an extra (domain) source without touching the compiler; SECRET items never reach the model or the database', async () => {
    const { taskId } = await createTask();
    const domain: ContextSource = {
      id: 'external.record_state',
      load: (request) =>
        Promise.resolve([
          { itemId: 'state:record:1.status', kind: 'state', authority: 'AUTHORITATIVE', temporality: 'live', content: { status: 'open' }, assertions: [{ subject: 'record:1.status', value: 'open' }], provenance: { recordType: 'external_record', recordId: 'record:1', recordVersion: '3' }, createdAt: request.execution.task.createdAt, taskId },
          { itemId: 'state:record:1.access_key', kind: 'state', authority: 'AUTHORITATIVE', temporality: 'live', content: { key: 'TOP-SECRET-KEY-42' }, provenance: { recordType: 'external_record', recordId: 'record:1' }, createdAt: request.execution.task.createdAt, sensitivity: 'SECRET', required: true, taskId },
        ]),
    };
    const logs = captureLogs();
    const w = await worker({ script: [complete('done')], contextSources: [domain], logger: logs.logger });
    const cycle = await runUntilExecuted(w);
    expect(cycle.outcome).toMatchObject({ kind: 'terminated', termination: { reason: 'completed' } });

    const request = w.provider.requests[0]!;
    expect(compiledOf(request).sections.authoritativeState.map((i) => [i.itemId, i.sourceId])).toEqual([['state:record:1.status', 'external.record_state']]);
    expect(JSON.stringify(request)).not.toContain('TOP-SECRET-KEY-42');
    const dump = await platform.pool.query<{ doc: string }>('select compiled_context::text as doc from context_snapshots');
    expect(dump.rows.map((r) => r.doc).join('\n')).not.toContain('TOP-SECRET-KEY-42');
    const rows = await platform.pool.query('select item_id, sensitivity, decision, exclusion_reason from context_snapshot_items where item_id = $1', ['state:record:1.access_key']);
    expect(rows.rows).toEqual([{ item_id: 'state:record:1.access_key', sensitivity: 'SECRET', decision: 'excluded', exclusion_reason: 'sensitivity' }]);
    expect(logs.raw()).not.toContain('TOP-SECRET-KEY-42');
  });
});
