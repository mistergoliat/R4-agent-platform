import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemClock, uuidV7Generator, type LeaseToken, type Principal, type TerminationReason } from '@r4/contracts';
import { createSilentLogger } from '@r4/observability';
import { PostgresExecutionStore } from '@r4/persistence-postgres';
import { ExecutionRuntime, TemporalRuntime, type ClaimOutcome, type RunFailureHandoff } from '@r4/task-runtime';
import type { Platform } from '@r4/api';
import { SALES_RUN_FAILURE_FALLBACK_TEXT } from '@r4-sales/agent/production';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';
import { LiveOpsTestbed, invalid, say } from '../support/live-ops.js';
import { startTestPlatform, validTaskBody } from '../support/platform.js';
import { expireLease } from '../support/worker.js';

/**
 * R4-J4-R7-1 — runtime contingency (ADR-028 amendment, ADR-041 generalized).
 * A task that cannot continue autonomously is never left terminal in silence:
 * it is handed to a human durably (blocked + platform handoff, visible in
 * attention) and, on a channel, the contact gets the pack's one fixed notice.
 * Scenario ids refer to R4_J4_R7_TEST_PLAN.md §3.1 / §3.4.
 */

// ---------------------------------------------------------------------------
// Runtime level: the Execution Runtime with (and without) the human runtime
// ---------------------------------------------------------------------------

describe('runtime contingency (Execution Runtime + Temporal Runtime)', () => {
  const actor: Principal = { kind: 'service', ref: 'r7-contingency' };
  let db: TestDatabase;
  let platform: Platform;
  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    platform = await startTestPlatform(db.url);
  });
  afterEach(async () => {
    await platform?.close();
    await db?.drop();
  });

  function runtimes(options: { maxRunRecoveries?: number; human?: boolean } = {}) {
    const store = new PostgresExecutionStore(platform.pool);
    const execution = new ExecutionRuntime({ store, ids: uuidV7Generator(), clock: systemClock, logger: createSilentLogger(), maxRunRecoveries: options.maxRunRecoveries ?? 3 });
    const temporal = options.human === false ? null : new TemporalRuntime({ store, execution, ids: uuidV7Generator(), logger: createSilentLogger() });
    return { execution, temporal };
  }
  async function createTask(): Promise<string> {
    const { view } = await platform.tasks.createTask({ request: validTaskBody({ taskType: 'probe.fact_lookup' }), requestedBy: actor, correlationId: 'r7-contingency' });
    return view.task.taskId;
  }
  const tokenOf = (claim: ClaimOutcome | null): LeaseToken => {
    if (!claim || claim.kind === 'abandoned') throw new Error(`expected a leased claim, got ${claim?.kind ?? 'null'}`);
    return { taskId: claim.lease.taskId, owner: claim.lease.owner, generation: claim.lease.generation };
  };
  const row = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> => (await platform.pool.query<Record<string, unknown>>(sql, params)).rows;
  const taskRow = async (taskId: string): Promise<Record<string, unknown> | undefined> => (await row('select status, status_reason from agent_tasks where task_id = $1', [taskId]))[0];
  const humans = (taskId: string) => row(`select kind, status, payload->>'initiatedBy' as initiated_by, payload->>'reason' as reason from human_requests where task_id = $1`, [taskId]);
  const waits = (taskId: string) => row(`select kind, status from task_waits where task_id = $1 order by created_at`, [taskId]);

  it.each([
    ['S08 budget_exhausted', 'budget_exhausted', 'max_model_calls', 'run_budget_exhausted'],
    ['S11 capability_failure', 'capability_failure', 'capability_execution_error', 'run_capability_failure'],
    ['S12 internal_failure', 'internal_failure', 'action_execution_error', 'run_internal_failure'],
  ] as const)('%s: the run fails, the task is handed to a human (blocked + platform handoff + WAIT_FOR_HUMAN), never failed', async (_id, reason: TerminationReason, code, handoffReason) => {
    const { execution } = runtimes();
    const taskId = await createTask();
    const token = tokenOf(await execution.claimNext({ workerId: 'w-1', leaseDurationMs: 30_000 }));
    const { task, run } = await execution.finishExecution(token, { termination: { reason, code, message: `${reason} in a test`, details: null } });
    expect(run).toMatchObject({ status: 'failed', termination: { reason, code, details: { runFailureRecovery: { outcome: 'handed_off', consecutiveFailures: null } } } });
    expect(task).toMatchObject({ status: 'blocked', statusReason: handoffReason });
    expect(await taskRow(taskId)).toEqual({ status: 'blocked', status_reason: handoffReason });
    expect(await humans(taskId)).toEqual([{ kind: 'handoff', status: 'requested', initiated_by: 'platform', reason: handoffReason }]);
    expect(await waits(taskId)).toEqual([{ kind: 'WAIT_FOR_HUMAN', status: 'waiting' }]);
    // Observable: the platform's attention lists it for an operator.
    expect((await platform.temporal.attention()).requests.map((r) => r.taskId)).toContain(taskId);
    // Durable work, not a failed task: an operator can still take it over.
    expect(await execution.claimNext({ workerId: 'w-2', leaseDurationMs: 30_000 })).toBeNull();
  });

  it('S13 abandonment (lease lost beyond maxRunRecoveries) hands the task to a human in the claim transaction', async () => {
    const { execution } = runtimes({ maxRunRecoveries: 0 });
    const taskId = await createTask();
    tokenOf(await execution.claimNext({ workerId: 'w-1', leaseDurationMs: 30_000 }));
    await expireLease(platform.pool, taskId);
    const abandoned = await execution.claimNext({ workerId: 'w-2', leaseDurationMs: 30_000 });
    expect(abandoned).toMatchObject({ kind: 'abandoned', task: { status: 'blocked', statusReason: 'run_abandoned' }, run: { status: 'abandoned', termination: { reason: 'lease_lost', code: 'max_run_recoveries_exceeded', details: { runFailureRecovery: { outcome: 'handed_off' } } } } });
    expect(await humans(taskId)).toEqual([{ kind: 'handoff', status: 'requested', initiated_by: 'platform', reason: 'run_abandoned' }]);
    expect((await row('select lease_owner from agent_tasks where task_id = $1', [taskId]))[0]).toEqual({ lease_owner: null });
  });

  it('S15 without the human runtime the formerly terminal failures stay terminal (no loop on an unrecordable ending)', async () => {
    const { execution } = runtimes({ human: false });
    const taskId = await createTask();
    const token = tokenOf(await execution.claimNext({ workerId: 'w-1', leaseDurationMs: 30_000 }));
    const { task, run } = await execution.finishExecution(token, { termination: { reason: 'budget_exhausted', code: 'max_iterations', message: 'x', details: null } });
    expect(run.termination?.details).toBeNull();
    expect(task).toMatchObject({ status: 'failed', statusReason: 'budget_exhausted' });
    expect(await humans(taskId)).toEqual([]);
  });

  it('S57 the contingency is atomic: a failure inside the handoff leaves the run running and the lease held; a retry hands over once', async () => {
    const { execution, temporal } = runtimes();
    const taskId = await createTask();
    const token = tokenOf(await execution.claimNext({ workerId: 'w-1', leaseDurationMs: 30_000 }));
    // The handoff writes everything, then the process "dies" before the transaction commits.
    const crashing: RunFailureHandoff = {
      async handOffAfterRunFailureWithin(...args) {
        await temporal!.handOffAfterRunFailureWithin(...args);
        throw new Error('injected crash after the handoff writes');
      },
    };
    execution.attachRunFailureHandoff(crashing);
    const ending = { termination: { reason: 'budget_exhausted' as const, code: 'max_model_calls', message: 'x', details: null } };
    await expect(execution.finishExecution(token, ending)).rejects.toThrow('injected crash');
    expect(await taskRow(taskId)).toEqual({ status: 'running', status_reason: 'run_started' });
    expect(await row(`select status from agent_runs where task_id = $1`, [taskId])).toEqual([{ status: 'running' }]);
    expect(await humans(taskId)).toEqual([]);
    expect(await waits(taskId)).toEqual([]);
    expect((await row('select lease_owner from agent_tasks where task_id = $1', [taskId]))[0]).toEqual({ lease_owner: 'w-1' });
    // Same owner, same run: the ending is applied exactly once.
    execution.attachRunFailureHandoff(temporal!);
    await execution.finishExecution(token, ending);
    expect(await taskRow(taskId)).toEqual({ status: 'blocked', status_reason: 'run_budget_exhausted' });
    expect(await humans(taskId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Channel level: the real production composition (webhook → worker → delivery)
// ---------------------------------------------------------------------------

describe('runtime contingency on a channel conversation (LiveOpsTestbed, Sales gateway with the fallback notice)', () => {
  const CUSTOMER = '56944445555';
  const focusUnknownGoal = () => ({ type: 'structured' as const, data: { type: 'manage_goal', change: { operation: 'focus', goalId: '00000000-0000-4000-8000-000000000000' } } });
  const consult = (expiresAt: string) => ({ type: 'structured' as const, data: { type: 'request_consultation', question: '¿Cuál es la política de devoluciones?', contextRefs: [], expiresAt } });
  let bed: LiveOpsTestbed | null = null;
  afterEach(async () => {
    await bed?.close();
    bed = null;
  });
  const start = async (env: Record<string, string> = {}) => (bed = await LiveOpsTestbed.start({ allowlist: [CUSTOMER], autonomy: true, env }));
  const facts = async (b: LiveOpsTestbed, taskId: string) => ({
    task: (await b.rows<{ status: string; status_reason: string }>('select status, status_reason from agent_tasks where task_id = $1', [taskId]))[0],
    runs: await b.rows<{ status: string; termination_reason: string; termination_code: string; details: Record<string, unknown> | null }>(
      'select status, termination_reason, termination_code, termination_details as details from agent_runs where task_id = $1 order by sequence', [taskId]),
    outbound: await b.rows<{ origin: string; status: string; cancel_reason: string | null }>('select origin, status, cancel_reason from outbound_messages where task_id = $1 order by created_at', [taskId]),
    humans: await b.rows<{ reason: string; status: string }>(`select payload->>'reason' as reason, status from human_requests where task_id = $1`, [taskId]),
    inputs: Number((await b.rows<{ n: string }>('select count(*) as n from task_inputs where task_id = $1', [taskId]))[0]!.n),
  });
  const notices = (b: LiveOpsTestbed) => b.provider.sends.filter((s) => s.text === SALES_RUN_FAILURE_FALLBACK_TEXT);

  it('S08 + S53: a per-run budget exhausted inside a turn → blocked + ONE notice; the follow-up stays on the same task; no duplicate after a gateway redeploy', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r71-08a', 'Busco un rack que aguante 300 kg');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(...Array.from({ length: 20 }, () => focusUnknownGoal()));
    await b.runAgent();
    await b.deliver();
    const f = await facts(b, taskId);
    expect(f.task).toEqual({ status: 'blocked', status_reason: 'run_budget_exhausted' });
    expect(f.runs).toEqual([expect.objectContaining({ status: 'failed', termination_reason: 'budget_exhausted', termination_code: 'max_iterations' })]);
    expect(f.humans).toEqual([{ reason: 'run_budget_exhausted', status: 'requested' }]);
    expect(f.outbound).toEqual([{ origin: 'platform', status: 'accepted', cancel_reason: null }]);
    expect(notices(b)).toHaveLength(1);

    // The conversation is not lost: the next message lands on the same (blocked, human-owned) task.
    await b.customer(CUSTOMER, 'wamid.r71-08b', '¿Sigues ahí?');
    expect(await b.taskOf(CUSTOMER)).toBe(taskId);
    expect((await b.rows<{ disposition: string }>(`select disposition from inbound_events where provider_event_id = 'wamid.r71-08b'`))[0]).toEqual({ disposition: 'human_owned' });
    expect(await b.runAgent()).toEqual([]);
    await b.redeployGateway({ allowlist: [CUSTOMER] });
    await b.deliver();
    await b.deliver();
    expect((await facts(b, taskId)).outbound).toHaveLength(1);
    expect(notices(b)).toHaveLength(1);
  });

  it('S16: an input arriving during the call that ends in budget exhaustion stays on the blocked task (not orphaned); one notice', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r71-16a', 'Hola');
    const taskId = await b.taskOf(CUSTOMER);
    const steps = Array.from({ length: 20 }, (_, i) => (i === 10 ? async () => (await b.customer(CUSTOMER, 'wamid.r71-16b', '¿Tienen discos?'), focusUnknownGoal()) : focusUnknownGoal()));
    b.next(...steps);
    await b.runAgent();
    await b.deliver();
    const f = await facts(b, taskId);
    expect(f.task?.status).toBe('blocked');
    expect(f.inputs).toBe(2);
    expect((await b.rows<{ task_id: string }>(`select task_id from inbound_events where provider_event_id = 'wamid.r71-16b'`))[0]).toEqual({ task_id: taskId });
    expect(notices(b)).toHaveLength(1);
  });

  it('S03: two truncated outputs (finish_reason=length) keep their finish reason, are recovered once, then hand over with one notice', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r71-03a', 'Necesito una cotización');
    const taskId = await b.taskOf(CUSTOMER);
    const truncated = { type: 'text' as const, content: '{"type":"respond","content":"Claro, para cotizar nece', finishReason: 'length' as const };
    b.next(truncated, truncated);
    await b.runAgent();
    await b.deliver();
    const f = await facts(b, taskId);
    expect(f.runs.map((r) => [r.termination_code, r.details?.finishReason, (r.details?.runFailureRecovery as { outcome: string }).outcome])).toEqual([
      ['invalid_structured_output', 'length', 'continued'],
      ['invalid_structured_output', 'length', 'exhausted'],
    ]);
    expect(f.task).toEqual({ status: 'blocked', status_reason: 'run_failure_recovery_exhausted' });
    expect(notices(b)).toHaveLength(1);
  });

  it('S04: a filtered output (finish_reason=content_filter) is a contingency: no recovery run, blocked run_output_filtered, one notice', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r71-04a', 'Hola');
    const taskId = await b.taskOf(CUSTOMER);
    b.next({ type: 'text', content: '', finishReason: 'content_filter' }, say('never asked'));
    await b.runAgent();
    await b.deliver();
    const f = await facts(b, taskId);
    expect(f.runs).toEqual([expect.objectContaining({ status: 'failed', termination_reason: 'invalid_decision', details: expect.objectContaining({ finishReason: 'content_filter', runFailureRecovery: expect.objectContaining({ outcome: 'handed_off' }) }) })]);
    expect(f.task).toEqual({ status: 'blocked', status_reason: 'run_output_filtered' });
    expect(b.pendingSteps).toBe(1);
    expect(notices(b)).toHaveLength(1);
  });

  it('S01 (ADR-041 regression, generalized store): two invalid outputs → one notice; the reason set now includes the R7-1 contingencies', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r71-01a', '¿Hay stock disponible?');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(invalid(), invalid());
    await b.runAgent();
    await b.deliver();
    expect((await facts(b, taskId)).task).toEqual({ status: 'blocked', status_reason: 'run_failure_recovery_exhausted' });
    expect(notices(b)).toHaveLength(1);
  });

  it('S14: a consultation with a past expiry is refused and shown back; the run continues and replies (never internal_failure)', async () => {
    const b = await start();
    await b.customer(CUSTOMER, 'wamid.r71-14a', '¿Tienen garantía extendida?');
    const taskId = await b.taskOf(CUSTOMER);
    let shown = false;
    b.next(consult('2020-01-01T00:00:00.000Z'), (request) => {
      shown = JSON.stringify(request.context).includes('expiry_in_past');
      return say('Sí, ofrecemos garantía extendida en máquinas.');
    });
    await b.runAgent();
    await b.deliver();
    const f = await facts(b, taskId);
    expect(f.task?.status).toBe('waiting');
    expect(f.runs).toEqual([expect.objectContaining({ status: 'suspended', termination_reason: 'waiting' })]);
    const steps = await b.rows<{ decision_type: string; outcome: string; error_code: string | null }>(
      `select s.decision_type, s.outcome, s.error_code from agent_run_steps s where s.task_id = $1 order by s.iteration`, [taskId]);
    expect(steps.slice(0, 2)).toEqual([
      { decision_type: 'request_consultation', outcome: 'refused', error_code: 'expiry_in_past' },
      { decision_type: 'respond', outcome: 'recorded', error_code: null },
    ]);
    expect(shown).toBe(true);
    expect(f.humans).toEqual([]);
    expect(f.outbound).toEqual([{ origin: 'agent', status: 'accepted', cancel_reason: null }]);
  });

  it('S50: a reply cancelled at the gate (expired) is listed in attention; the task is not re-woken', async () => {
    const b = await start({ R4_PROD_OUTBOUND_MAX_AGE_MS: '1000' });
    await b.customer(CUSTOMER, 'wamid.r71-50a', 'Hola, ¿tienen mancuernas de 10 kg?');
    const taskId = await b.taskOf(CUSTOMER);
    b.next(say('Sí, tenemos mancuernas de 10 kg.'));
    await b.runAgent();
    await b.gateway.delivery.materialize();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await b.deliver();
    const attention = (await b.api.production.attention()).production;
    expect(attention.undeliveredOutbound.map((o) => [o.taskId, o.origin, o.cancelReason])).toEqual([[taskId, 'agent', 'expired']]);
    expect((await facts(b, taskId)).task?.status).toBe('waiting');
    expect(await b.runAgent()).toEqual([]);
  });
});
