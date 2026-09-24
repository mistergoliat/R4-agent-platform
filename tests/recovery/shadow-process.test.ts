import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlatform, type Platform } from '@r4/api';
import { PostgresTrajectoryReader } from '@r4/evaluator';
import { PostgresExecutionStore } from '@r4/persistence-postgres';
import { assertShadowComposition, buildSideEffectManifest, evaluateShadowSafety, loadShadowExecutionConfig, sideEffectRecordSchema, ShadowOutboundSink, type SideEffectRecord } from '@r4/shadow';
import { PostgresSalesStore, SALES_AGENT_DIR, SALES_AGENT_ID, SALES_ROOT_GOAL, SALES_TASK_TYPE, createScenarioDatabase, type ScenarioDatabase } from '@r4-sales/agent';
import { salesWorkspaceProjection } from '@r4-sales/agent/evaluations';
import { SALES_EXTERNAL_WRITE_CAPABILITIES, SALES_SHADOW_BINDINGS, SALES_SHADOW_OUTBOUND, workloadById } from '@r4-sales/agent/shadow';
import { testAdminDatabaseUrl } from '../support/env.js';
import { waitFor } from '../support/worker.js';

/**
 * R4-H multi-process shadow E2E (real OS processes, built dist code):
 *
 *   API (this process) ── canonical ingress ──► PostgreSQL ◄── shadow Sales worker A (process)
 *                                                    ▲      ◄── scheduler (apps/scheduler main, process)
 *   turn 1: a quote whose outcome is unknown and cannot be established in the run
 *           → needs_reconciliation → the scheduler PROCESS dispatches → worker A
 *           reconciles by the same key → receipt → the agent answers and waits
 *   worker A is SIGKILLed while the conversation waits for the customer
 *   turn 2 arrives → a NEW worker process B picks the task up and continues
 *
 * Asserts one shadow quote effect, one receipt (obtained via reconcile),
 * zero production effects, zero deliveries and every safety check green —
 * built from what the processes emitted plus durable state. Requires
 * `npm run build`.
 */
const WORKER = fileURLToPath(new URL('../../agents/sales/dist/shadow/worker-process.js', import.meta.url));
const SCHEDULER_MAIN = fileURLToPath(new URL('../../apps/scheduler/dist/main.js', import.meta.url));
const CUSTOMER = 'cust-demo-001';

let db: ScenarioDatabase;
let api: Platform;
const children: ChildProcess[] = [];

beforeAll(() => {
  for (const path of [WORKER, SCHEDULER_MAIN]) if (!existsSync(path)) throw new Error(`${path} is missing: run "npm run build" before "npm run test:recovery"`);
});
beforeEach(async () => {
  db = await createScenarioDatabase(testAdminDatabaseUrl(), 'r4_shadow_e2e');
  api = await createPlatform({ databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: SALES_AGENT_DIR, dbPoolMax: 4 });
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await api?.close();
  await db?.drop();
});

interface Child {
  readonly process: ChildProcess;
  readonly lines: Record<string, unknown>[];
  readonly stderr: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(script: string, env: Record<string, string>): Child {
  const child = spawn(process.execPath, [script], { env: { ...process.env, R4_DATABASE_URL: db.url, R4_LOG_LEVEL: 'warn', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const lines: Record<string, unknown>[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('{')) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { process: child, lines, stderr: () => stderr, exited };
}

const WORKER_ENV = { R4_EXECUTION_MODE: 'shadow', R4_SHADOW_CASE: 'H09', R4_WORKER_POLL_MS: '50', R4_WORKER_LEASE_MS: '2000', R4_WORKER_HEARTBEAT_MS: '300', R4_EXEC_MAX_WRITE_ACTIONS: '20', R4_EXEC_MODEL_CALL_TIMEOUT_MS: '10000' };
const SCHEDULER_ENV = { R4_SCHEDULER_ID: 'shadow-scheduler-process', R4_SCHEDULER_LEASE_MS: '2000', R4_SCHEDULER_POLL_MS: '50', R4_RECONCILIATION_MAX_ATTEMPTS: '5', R4_RECONCILIATION_INITIAL_BACKOFF_MS: '0', R4_RECONCILIATION_MAX_BACKOFF_MS: '0', R4_RECONCILIATION_DEADLINE_MS: '86400000' };

async function responses(taskId: string) {
  const execution = new PostgresExecutionStore(api.pool);
  const out: { stepId: string; text: string; at: string }[] = [];
  for (const run of (await api.tasks.getTask(taskId)).runs) for (const s of await execution.transaction((uow) => uow.listRunSteps(run.runId))) if (s.decision?.type === 'respond') out.push({ stepId: s.stepId, text: s.decision.content, at: s.createdAt });
  return out;
}
const say = (taskId: string, n: number, text: string) => api.temporal.submitInput(taskId, { externalKey: `turn-${n}`, content: text, sourceRef: 'shadow', occurredAt: new Date().toISOString() }, { kind: 'user', ref: CUSTOMER }, `turn-${n}`);

describe('shadow E2E across real processes', () => {
  it('unknown quote outcome reconciled by the scheduler process; worker killed while waiting; a new worker process continues — one effect, zero production effects', async () => {
    const workload = workloadById('H09');
    const [turn1, turn2] = workload.events.flatMap((e) => (e.kind === 'input' ? [e.text] : []));
    const { view } = await api.tasks.createTask({ request: { taskType: SALES_TASK_TYPE, agentId: SALES_AGENT_ID, goal: SALES_ROOT_GOAL, input: { channel: 'shadow' } }, requestedBy: { kind: 'service', ref: 'shadow-ingress' }, correlationId: 'shadow-e2e' });
    const taskId = view.task.taskId;
    await new PostgresSalesStore(api.pool).bindConversation({ taskId, customerRef: CUSTOMER, channelRef: 'shadow' });
    await say(taskId, 1, turn1!);

    const scheduler = start(SCHEDULER_MAIN, SCHEDULER_ENV);
    const workerA = start(WORKER, { ...WORKER_ENV, R4_WORKER_ID: 'shadow-worker-a', R4_SHADOW_FAULTS: JSON.stringify([{ target: 'quote', fault: 'connection-lost-after-issue-once' }, { target: 'quote', fault: 'lookup-timeout-x3' }]) });
    await waitFor(async () => (await api.tasks.getTask(taskId)).task.status === 'waiting' && (await responses(taskId)).length === 1, 60_000, 100).catch((error: unknown) => {
      throw new Error(`turn 1 never completed; worker: ${workerA.stderr().slice(0, 2000)} scheduler: ${scheduler.stderr().slice(0, 1000)}`, { cause: error });
    });
    const temporal = await api.temporal.inspect(taskId);
    // Dispatched by the scheduler process (its durable policy is stamped on the work), then completed by the worker.
    expect(temporal.schedules.filter((s) => s.kind === 'reconciliation')).toEqual([expect.objectContaining({ status: 'completed', attempts: 1, policy: expect.objectContaining({ maxAttempts: 5 }) })]);
    expect(temporal.events.filter((e) => /^(schedule.|reconciliation.)/.test(e.type)).map((e) => [e.type, e.actorRef])).toEqual([
      ['reconciliation.scheduled', 'temporal-runtime'],
      ['schedule.claimed', 'shadow-scheduler-process'],
      ['schedule.fired', 'shadow-scheduler-process'],
      ['reconciliation.attempted', 'shadow-worker-a'],
      ['reconciliation.resolved', 'shadow-worker-a'],
    ]);

    workerA.process.kill('SIGKILL');
    expect((await workerA.exited).signal).toBe('SIGKILL');

    await say(taskId, 2, turn2!);
    const workerB = start(WORKER, { ...WORKER_ENV, R4_WORKER_ID: 'shadow-worker-b', R4_SHADOW_SCRIPT_FROM: '6' });
    await waitFor(async () => (await api.tasks.getTask(taskId)).task.status === 'waiting' && (await responses(taskId)).length === 2, 60_000, 100).catch((error: unknown) => {
      throw new Error(`turn 2 never completed; worker B: ${workerB.stderr().slice(0, 2000)}`, { cause: error });
    });
    expect(workerB.lines.some((l) => l.event === 'shadow.model_call')).toBe(true);
    scheduler.process.kill('SIGTERM');
    workerB.process.kill('SIGTERM');

    // Evidence: what the processes emitted + durable state.
    const records: SideEffectRecord[] = [...workerA.lines, ...workerB.lines].filter((l) => l.event === 'shadow.side_effect').map(({ event: _event, ...r }) => sideEffectRecordSchema.parse(r));
    const reader = new PostgresTrajectoryReader(api.pool, { projections: [salesWorkspaceProjection(new PostgresSalesStore(api.pool))] });
    const subject = await reader.subject(taskId, { sourceRef: 'shadow-e2e' });
    const sink = new ShadowOutboundSink({ salt: 'e2e' });
    for (const r of await responses(taskId)) sink.deliver({ taskRef: taskId, turnIndex: null, responseRef: r.stepId, recipient: CUSTOMER, text: r.text, respondedAt: r.at });
    const config = loadShadowExecutionConfig({ R4_EXECUTION_MODE: 'shadow' });
    const composition = assertShadowComposition(config, SALES_SHADOW_BINDINGS, SALES_SHADOW_OUTBOUND);
    const manifest = buildSideEffectManifest({ records, subject, outbound: sink.delivered });
    const safety = evaluateShadowSafety({ records, subject, outbound: sink.delivered, manifest, composition, externalWriteCapabilities: SALES_EXTERNAL_WRITE_CAPABILITIES });

    expect(safety.filter((c) => !c.passed)).toEqual([]);
    expect(manifest).toMatchObject({ productionEffectsExecuted: 0, outboundActuallyDelivered: 0, outboundWouldDeliver: 2, shadowEffectsExecuted: 1 });
    const quote = subject.actions.executions.filter((e) => e.capabilityId === 'quote.create');
    expect(quote).toEqual([expect.objectContaining({ status: 'succeeded' })]);
    const receipts = subject.actions.receipts.filter((r) => r.capabilityId === 'quote.create');
    expect(receipts).toEqual([expect.objectContaining({ status: 'succeeded', executionKey: quote[0]!.executionKey, evidence: expect.objectContaining({ obtainedVia: 'reconcile' }) })]);
    // Execute + three in-run lookups by worker A, then the scheduled reconciliation — all under one execution key, by worker A.
    expect(subject.actions.attempts.filter((a) => a.executionId === quote[0]!.executionId).map((a) => [a.kind, a.workerId])).toEqual([['execute', 'shadow-worker-a'], ['reconcile', 'shadow-worker-a'], ['reconcile', 'shadow-worker-a'], ['reconcile', 'shadow-worker-a'], ['reconcile', 'shadow-worker-a']]);
    expect(records.filter((r) => r.operation === 'create')).toEqual([expect.objectContaining({ idempotencyKey: quote[0]!.executionKey, bindingKind: 'shadow' })]);
    // The conversation survived the worker process: goal intact, both turns answered, still waiting for the customer.
    expect(subject.task.status).toBe('waiting');
    expect(subject.goals.find((g) => g.goalId === subject.task.rootGoalId)?.status).toBe('active');
    expect((await responses(taskId))[1]!.text).toMatch(/COT-9\d{5}/);
  }, 120_000);

  it('the shadow worker process refuses to start without an explicit shadow declaration', async () => {
    const child = start(WORKER, { ...WORKER_ENV, R4_EXECUTION_MODE: '', R4_WORKER_ID: 'shadow-worker-undeclared' });
    const { code } = await child.exited;
    expect(code).not.toBe(0);
    expect(child.stderr()).toMatch(/shadow run must be declared explicitly|not set/);
  });
});
