import {
  PlatformError,
  humanRequestSchema,
  scheduleSchema,
  taskWaitSchema,
  type ApprovalRequest,
  type Handoff,
  type HumanRequest,
  type Schedule,
  type ScheduleToken,
  type TaskWait,
  type TemporalEvent,
  type WaitResolution,
} from '@r4/contracts';
import type { InteractionRecords, TemporalPersistence, TerminalIntent } from '@r4/task-runtime';
import { executionFromRow, one } from './action-store.js';
import type { PoolClient } from './pool.js';
import { goalFromRow, iso, jsonb, stepFromRow, type Row } from './rows.js';

/**
 * SQL only (R4-E). The Temporal and Action runtimes decide every transition;
 * callers hold the task row lock. Every temporal comparison uses `r4_now()`,
 * the temporal clock: C1 lease SQL is untouched and keeps its own clock.
 */
export class PostgresTemporalPersistence implements TemporalPersistence {
  constructor(private readonly client: PoolClient) {}

  async now(): Promise<string> {
    const r = await this.client.query<{ now: Date }>('select r4_now() as now');
    return iso(r.rows[0]!.now);
  }

  async listGoals(taskId: string) {
    const r = await this.client.query<Row>('select * from goals where task_id = $1 order by created_at, goal_id', [taskId]);
    return r.rows.map(goalFromRow);
  }

  async insertWait(w: TaskWait): Promise<void> {
    await this.client.query(
      'insert into task_waits (wait_id, task_id, run_id, kind, status, resolution, reference_id, due_at, created_at, completed_at, correlation_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      [w.waitId, w.taskId, w.runId, w.kind, w.status, w.resolution, w.referenceId, w.dueAt, w.createdAt, w.completedAt, w.correlationId],
    );
  }

  async activeWait(taskId: string): Promise<TaskWait | null> {
    const r = await this.client.query<Row>("select * from task_waits where task_id = $1 and status = 'waiting'", [taskId]);
    return r.rows[0] ? waitFromRow(r.rows[0]) : null;
  }

  async finishWait(waitId: string, status: 'completed' | 'cancelled', resolution: WaitResolution, at: string): Promise<void> {
    await this.client.query("update task_waits set status = $2, resolution = $3, completed_at = $4 where wait_id = $1 and status = 'waiting'", [waitId, status, resolution, at]);
  }

  async listWaits(taskId: string): Promise<TaskWait[]> {
    const r = await this.client.query<Row>('select * from task_waits where task_id = $1 order by created_at, wait_id', [taskId]);
    return r.rows.map(waitFromRow);
  }

  async insertHuman(r: HumanRequest): Promise<void> {
    await this.client.query(
      'insert into human_requests (request_id, task_id, run_id, kind, status, human_ref, payload, proposal_id, created_at, updated_at, expires_at, correlation_id) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)',
      [r.requestId, r.taskId, r.runId, r.kind, r.status, r.humanRef, jsonb(r.payload), r.kind === 'approval' ? r.payload.proposalId : null, r.createdAt, r.updatedAt, r.expiresAt, r.correlationId],
    );
  }

  async human(requestId: string): Promise<HumanRequest | null> {
    const r = await this.client.query<Row>('select * from human_requests where request_id = $1', [requestId]);
    return r.rows[0] ? humanFromRow(r.rows[0]) : null;
  }

  async humanByProposal(proposalId: string): Promise<ApprovalRequest | null> {
    const r = await this.client.query<Row>('select * from human_requests where proposal_id = $1', [proposalId]);
    const value = r.rows[0] ? humanFromRow(r.rows[0]) : null;
    return value?.kind === 'approval' ? value : null;
  }

  async activeHandoff(taskId: string): Promise<Handoff | null> {
    const r = await this.client.query<Row>("select * from human_requests where task_id = $1 and kind = 'handoff' and status in ('requested', 'active')", [taskId]);
    const value = r.rows[0] ? humanFromRow(r.rows[0]) : null;
    return value?.kind === 'handoff' ? value : null;
  }

  async listHumans(taskId?: string): Promise<HumanRequest[]> {
    const r = await this.client.query<Row>('select * from human_requests where ($1::uuid is null or task_id = $1) order by created_at, request_id', [taskId ?? null]);
    return r.rows.map(humanFromRow);
  }

  async updateHuman(r: HumanRequest): Promise<void> {
    await this.client.query('update human_requests set status = $2, human_ref = $3, updated_at = $4 where request_id = $1', [r.requestId, r.status, r.humanRef, r.updatedAt]);
  }

  async insertSchedule(s: Schedule): Promise<Schedule> {
    const r = await this.client.query<Row>(
      `insert into schedules (schedule_id, task_id, kind, reference_id, status, due_at, deadline_at, policy, attempts, owner, generation, lease_expires_at, created_at, updated_at, correlation_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15) on conflict (kind, reference_id) do nothing returning *`,
      [s.scheduleId, s.taskId, s.kind, s.referenceId, s.status, s.dueAt, s.deadlineAt, jsonb(s.policy), s.attempts, s.owner, s.generation, s.leaseExpiresAt, s.createdAt, s.updatedAt, s.correlationId],
    );
    if (r.rows[0]) return scheduleFromRow(r.rows[0]);
    return (await this.scheduleFor(s.kind, s.referenceId))!;
  }

  async claimDueSchedule(owner: string, leaseMs: number): Promise<Schedule | null> {
    const r = await this.client.query<Row>(
      `with candidate as (
         select schedule_id from schedules
          where due_at <= r4_now() and (status = 'pending' or (status = 'claimed' and lease_expires_at <= r4_now()))
          order by due_at, schedule_id limit 1 for update skip locked)
       update schedules s set status = 'claimed', owner = $1, generation = s.generation + 1,
              lease_expires_at = r4_now() + $2::int * interval '1 millisecond', updated_at = r4_now()
         from candidate c where s.schedule_id = c.schedule_id returning s.*`,
      [owner, leaseMs],
    );
    return r.rows[0] ? scheduleFromRow(r.rows[0]) : null;
  }

  async claimReconciliation(owner: string, leaseMs: number): Promise<Schedule | null> {
    const r = await this.client.query<Row>(
      `with candidate as (
         select schedule_id from schedules
          where kind = 'reconciliation' and (status = 'dispatched' or (status = 'in_progress' and lease_expires_at <= r4_now()))
          order by updated_at, schedule_id limit 1 for update skip locked)
       update schedules s set status = 'in_progress', owner = $1, generation = s.generation + 1,
              lease_expires_at = r4_now() + $2::int * interval '1 millisecond', updated_at = r4_now()
         from candidate c where s.schedule_id = c.schedule_id returning s.*`,
      [owner, leaseMs],
    );
    return r.rows[0] ? scheduleFromRow(r.rows[0]) : null;
  }

  async lockSchedule(token: ScheduleToken): Promise<Schedule> {
    const r = await this.client.query<Row & { held: boolean }>('select *, lease_expires_at > r4_now() as held from schedules where schedule_id = $1 for update', [token.scheduleId]);
    const row = r.rows[0];
    const s = row ? scheduleFromRow(row) : null;
    if (!s || !row?.held || s.taskId !== token.taskId || (s.status !== 'claimed' && s.status !== 'in_progress') || s.owner !== token.owner || s.generation !== token.generation) {
      throw new PlatformError('conflict', 'schedule_lease_lost', 'schedule ownership is no longer held');
    }
    return s;
  }

  async scheduleFor(kind: Schedule['kind'], referenceId: string): Promise<Schedule | null> {
    const r = await this.client.query<Row>('select * from schedules where kind = $1 and reference_id = $2', [kind, referenceId]);
    return r.rows[0] ? scheduleFromRow(r.rows[0]) : null;
  }

  async updateSchedule(s: Schedule): Promise<void> {
    await this.client.query(
      'update schedules set status = $2, due_at = $3, deadline_at = $4, policy = $5::jsonb, attempts = $6, owner = $7, generation = $8, lease_expires_at = $9, updated_at = $10 where schedule_id = $1',
      [s.scheduleId, s.status, s.dueAt, s.deadlineAt, jsonb(s.policy), s.attempts, s.owner, s.generation, s.leaseExpiresAt, s.updatedAt],
    );
  }

  async listSchedules(taskId: string): Promise<Schedule[]> {
    const r = await this.client.query<Row>('select * from schedules where task_id = $1 order by created_at, schedule_id', [taskId]);
    return r.rows.map(scheduleFromRow);
  }

  async event(e: TemporalEvent): Promise<void> {
    await this.client.query(
      'insert into temporal_events (event_id, task_id, entity_id, event_type, occurred_at, correlation_id, actor_ref, response_key, data) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)',
      [e.eventId, e.taskId, e.entityId, e.type, e.occurredAt, e.correlationId, e.actorRef, e.responseKey, jsonb(e.data)],
    );
  }

  async response(entityId: string, responseKey: string): Promise<TemporalEvent | null> {
    const r = await this.client.query<Row>('select * from temporal_events where entity_id = $1 and response_key = $2', [entityId, responseKey]);
    return r.rows[0] ? eventFromRow(r.rows[0]) : null;
  }

  async events(taskId: string): Promise<TemporalEvent[]> {
    const r = await this.client.query<Row>('select * from temporal_events where task_id = $1 order by occurred_at, event_id', [taskId]);
    return r.rows.map(eventFromRow);
  }

  async input(taskId: string, sourceRef: string, externalKey: string) {
    const r = await this.client.query<{ input_id: string; request_hash: string }>(
      'select input_id, request_hash from task_inputs where task_id = $1 and source_ref = $2 and external_key = $3',
      [taskId, sourceRef, externalKey],
    );
    return r.rows[0] ? { inputId: r.rows[0].input_id, requestHash: r.rows[0].request_hash } : null;
  }

  async insertInput(i: Parameters<TemporalPersistence['insertInput']>[0]): Promise<void> {
    await this.client.query(
      'insert into task_inputs (input_id, task_id, external_key, source_ref, actor_kind, actor_ref, request_hash, memory_entry_id, received_at, correlation_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [i.inputId, i.taskId, i.externalKey, i.sourceRef, i.actorKind, i.actorRef, i.requestHash, i.memoryEntryId, i.receivedAt, i.correlationId],
    );
  }

  async hasUnseenInput(taskId: string, snapshotId: string | null): Promise<boolean> {
    // Every evaluated item is recorded in the snapshot, excluded ones included (ADR-015).
    const r = await this.client.query(
      `select 1 from task_inputs i where i.task_id = $1 and not exists (
         select 1 from context_snapshot_items c where c.snapshot_id = $2 and c.item_id = 'memory:' || i.memory_entry_id::text) limit 1`,
      [taskId, snapshotId],
    );
    return r.rowCount !== 0;
  }

  async terminalIntent(taskId: string): Promise<TerminalIntent | null> {
    const r = await this.client.query<Row>('select * from task_terminal_intents where task_id = $1', [taskId]);
    const row = r.rows[0];
    return row
      ? { targetStatus: row.target_status as TerminalIntent['targetStatus'], reason: row.reason as string, actorKind: row.actor_kind as string, actorRef: row.actor_ref as string, requestedAt: iso(row.requested_at) }
      : null;
  }

  async unresolved(taskId?: string) {
    const r = await this.client.query<Row>(
      "select * from action_executions where status in ('executing', 'needs_reconciliation') and ($1::uuid is null or task_id = $1) order by created_at, execution_id",
      [taskId ?? null],
    );
    return r.rows.map(executionFromRow);
  }

  execution(executionId: string) {
    return one(this.client, 'select * from action_executions where execution_id = $1', [executionId], executionFromRow);
  }

  async pendingApprovalProposal(taskId: string): Promise<string | null> {
    const r = await this.client.query<{ proposal_id: string }>(
      `select h.proposal_id from human_requests h
         left join action_executions e on e.proposal_id = h.proposal_id
        where h.task_id = $1 and h.kind = 'approval' and (
              (h.status = 'approved' and (
                 e.status in ('prepared', 'executing') or
                 (e.execution_id is null and not exists (
                    select 1 from policy_decisions d where d.proposal_id = h.proposal_id and d.decision_id <> (h.payload->>'policyDecisionId')::uuid))))
           or (h.status in ('rejected', 'expired', 'cancelled') and not exists (
                 select 1 from observations o where o.approval_request_id = h.request_id)))
        order by h.created_at limit 1`,
      [taskId],
    );
    return r.rows[0]?.proposal_id ?? null;
  }

  async interactionRecords(taskId: string): Promise<InteractionRecords> {
    const steps = await this.client.query<Row>(
      "select * from agent_run_steps where task_id = $1 and decision_type in ('respond', 'wait', 'request_consultation', 'request_handoff', 'manage_goal') order by created_at, step_id",
      [taskId],
    );
    const responses = await this.client.query<Row>('select * from temporal_events where task_id = $1 and response_key is not null order by occurred_at, event_id', [taskId]);
    return {
      steps: steps.rows.map(stepFromRow),
      humans: await this.listHumans(taskId),
      responses: responses.rows.map(eventFromRow),
      waits: await this.listWaits(taskId),
    };
  }
}

function waitFromRow(r: Row): TaskWait {
  return taskWaitSchema.parse({
    waitId: r.wait_id, taskId: r.task_id, runId: r.run_id, kind: r.kind, status: r.status, resolution: r.resolution, referenceId: r.reference_id,
    dueAt: r.due_at ? iso(r.due_at) : null, createdAt: iso(r.created_at), completedAt: r.completed_at ? iso(r.completed_at) : null, correlationId: r.correlation_id,
  });
}

function humanFromRow(r: Row): HumanRequest {
  return humanRequestSchema.parse({
    requestId: r.request_id, taskId: r.task_id, runId: r.run_id, kind: r.kind, status: r.status, humanRef: r.human_ref, payload: r.payload,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), expiresAt: r.expires_at ? iso(r.expires_at) : null, correlationId: r.correlation_id,
  });
}

function scheduleFromRow(r: Row): Schedule {
  return scheduleSchema.parse({
    scheduleId: r.schedule_id, taskId: r.task_id, kind: r.kind, referenceId: r.reference_id, status: r.status, dueAt: iso(r.due_at),
    deadlineAt: r.deadline_at ? iso(r.deadline_at) : null, policy: r.policy, attempts: r.attempts, owner: r.owner, generation: r.generation,
    leaseExpiresAt: r.lease_expires_at ? iso(r.lease_expires_at) : null, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), correlationId: r.correlation_id,
  });
}

function eventFromRow(r: Row): TemporalEvent {
  return {
    eventId: r.event_id as string, taskId: r.task_id as string, entityId: r.entity_id as string, type: r.event_type as string, occurredAt: iso(r.occurred_at),
    correlationId: r.correlation_id as string, actorRef: r.actor_ref as string, responseKey: (r.response_key as string | null) ?? null, data: r.data as Record<string, unknown>,
  };
}
