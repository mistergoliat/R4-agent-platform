import { randomUUID } from 'node:crypto';
import { PlatformError, sha256Hex } from '@r4/contracts';
import {
  conversationLockKey,
  statusAfterEvidence,
  statusAfterOperatorResolution,
  type AutonomyControlChange,
  type AutonomyControlRecord,
  type AutonomyControlsState,
  type ClaimOutboundCommand,
  type ConversationBindingRecord,
  type ConversationSummary,
  type DeliveryAttemptRecord,
  type DeliveryEventRecord,
  type DispatchClaim,
  type DispatchToken,
  type InboundEventRecord,
  type InboundSettlement,
  type InspectedInbound,
  type InspectionDecision,
  type NewConversationBinding,
  type NewInboundEvent,
  type NewOperatorOutbound,
  type OutboundRecord,
  type OutboundStatus,
  type ProductionAttention,
  type ProductionMetrics,
  type ProductionStore,
  type ProviderStatusEvent,
  type SubmissionDisposition,
  type SubmissionResult,
  type TaskStateFacts,
  type ThreadEntry,
} from '@r4/live-ops';
import { query, withTransaction, type Pool, type PoolClient } from './pool.js';
import { iso, type Row } from './rows.js';

type Db = Pool | PoolClient;

const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

function controlFromRow(r: Row): AutonomyControlRecord {
  return { scope: r.scope as string, autonomyEnabled: r.autonomy_enabled as boolean, reason: r.reason as string, changedBy: r.changed_by as string, changedAt: iso(r.changed_at), version: r.version as number };
}

function inboundFromRow(r: Row): InboundEventRecord {
  return {
    inboundId: r.inbound_id as string, channel: r.channel as string, providerEventId: r.provider_event_id as string, status: r.status as InboundEventRecord['status'],
    contentKind: r.content_kind as string, contentType: (r.content_type as string | null) ?? null, content: (r.content as string | null) ?? null, contentSha256: (r.content_sha256 as string | null) ?? null,
    conversationKey: (r.conversation_key as string | null) ?? null, accountRef: (r.account_ref as string | null) ?? null, conversationRef: (r.conversation_ref as string | null) ?? null,
    bindingId: (r.binding_id as string | null) ?? null, taskId: (r.task_id as string | null) ?? null, inputId: (r.input_id as string | null) ?? null,
    disposition: (r.disposition as string | null) ?? null, failureCode: (r.failure_code as string | null) ?? null, occurredAt: isoOrNull(r.occurred_at),
    receivedAt: iso(r.received_at), settledAt: isoOrNull(r.settled_at), correlationId: r.correlation_id as string,
  };
}

function bindingFromRow(r: Row): ConversationBindingRecord {
  return {
    bindingId: r.binding_id as string, channel: r.channel as string, conversationKey: r.conversation_key as string, accountRef: r.account_ref as string, recipientRef: r.recipient_ref as string,
    taskId: (r.task_id as string | null) ?? null, status: r.status as 'open' | 'closed', autonomy: r.autonomy as 'autonomous' | 'excluded', eligibilityReason: r.eligibility_reason as string,
    rolloutFingerprint: r.rollout_fingerprint as string, profile: r.profile as string, profileFingerprint: r.profile_fingerprint as string, createdAt: iso(r.created_at),
    lastInboundAt: isoOrNull(r.last_inbound_at), closedAt: isoOrNull(r.closed_at), closedReason: (r.closed_reason as string | null) ?? null,
  };
}

function outboundFromRow(r: Row): OutboundRecord {
  return {
    outboundId: r.outbound_id as string, origin: r.origin as OutboundRecord['origin'], responseStepId: (r.response_step_id as string | null) ?? null, taskId: r.task_id as string,
    runId: (r.run_id as string | null) ?? null, bindingId: r.binding_id as string, channel: r.channel as string, idempotencyKey: r.idempotency_key as string,
    contentSha256: r.content_sha256 as string, status: r.status as OutboundStatus, holdReason: (r.hold_reason as string | null) ?? null, cancelReason: (r.cancel_reason as string | null) ?? null,
    duplicateOf: (r.duplicate_of as string | null) ?? null, providerMessageId: (r.provider_message_id as string | null) ?? null, attempts: r.attempts as number,
    nextAttemptAt: isoOrNull(r.next_attempt_at), leaseOwner: (r.lease_owner as string | null) ?? null, leaseGeneration: r.lease_generation as number, leaseExpiresAt: isoOrNull(r.lease_expires_at),
    errorClass: (r.error_class as string | null) ?? null, errorCode: (r.error_code as string | null) ?? null, humanRef: (r.human_ref as string | null) ?? null, resolvedBy: (r.resolved_by as string | null) ?? null,
    profile: r.profile as string, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), dispatchedAt: isoOrNull(r.dispatched_at), acceptedAt: isoOrNull(r.accepted_at),
    deliveredAt: isoOrNull(r.delivered_at), readAt: isoOrNull(r.read_at), failedAt: isoOrNull(r.failed_at), correlationId: r.correlation_id as string,
  };
}

function attemptFromRow(r: Row): DeliveryAttemptRecord {
  return {
    outboundId: r.outbound_id as string, attempt: r.attempt as number, leaseGeneration: r.lease_generation as number, owner: r.owner as string, startedAt: iso(r.started_at),
    finishedAt: isoOrNull(r.finished_at), outcome: (r.outcome as string | null) ?? null, providerMessageId: (r.provider_message_id as string | null) ?? null,
    httpStatus: (r.http_status as number | null) ?? null, errorClass: (r.error_class as string | null) ?? null, errorCode: (r.error_code as string | null) ?? null, latencyMs: (r.latency_ms as number | null) ?? null,
  };
}

function eventFromRow(r: Row): DeliveryEventRecord {
  return {
    eventId: r.event_id as string, channel: r.channel as string, eventKey: r.event_key as string, outboundId: (r.outbound_id as string | null) ?? null, providerMessageId: r.provider_message_id as string,
    status: r.status as string, occurredAt: iso(r.occurred_at), receivedAt: iso(r.received_at), effect: r.effect as string, fromStatus: (r.from_status as string | null) ?? null,
    toStatus: (r.to_status as string | null) ?? null, errorCode: (r.error_code as string | null) ?? null,
  };
}

function controlsState(rows: readonly Row[]): AutonomyControlsState {
  const global = rows.find((r) => r.scope === 'global');
  const channels: Record<string, boolean> = {};
  for (const r of rows) if (typeof r.scope === 'string' && r.scope.startsWith('channel:')) channels[r.scope.slice('channel:'.length)] = r.autonomy_enabled as boolean;
  // A missing global row reads as DISABLED (fail closed).
  return { globalEnabled: global?.autonomy_enabled === true, channels, version: rows.map((r) => `${r.scope as string}:${String(r.version)}`).sort().join(',') || 'none' };
}

const STATUS_TIMESTAMP: Partial<Record<OutboundStatus, string>> = { accepted: 'accepted_at', delivered: 'delivered_at', read: 'read_at', failed: 'failed_at' };

/**
 * PostgreSQL implementation of the R4-I ProductionStore (tables of 0007).
 * Every invariant that concurrency could break lives in the database:
 * unique provider event identity (inbound dedupe), one open binding per
 * conversation, one outbound per accepted response, claims with
 * `FOR UPDATE SKIP LOCKED` + fencing generation, row locks around status
 * evidence. No in-memory check is ever the authority.
 */
export class PostgresProductionStore implements ProductionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  // ---------------------------------------------------------------------------
  // Autonomy controls
  // ---------------------------------------------------------------------------

  async readControls() {
    const rows = (await query<Row>(this.#pool, 'select * from autonomy_controls order by scope')).rows;
    return { state: controlsState(rows), records: rows.map(controlFromRow) };
  }

  setControl(change: AutonomyControlChange): Promise<AutonomyControlRecord> {
    return withTransaction(this.#pool, async (c) => {
      const current = (await c.query<Row>('select * from autonomy_controls where scope = $1 for update', [change.scope])).rows[0];
      const version = current ? (current.version as number) + 1 : 1;
      const row = current
        ? (await c.query<Row>('update autonomy_controls set autonomy_enabled = $2, reason = $3, changed_by = $4, changed_at = clock_timestamp(), version = $5 where scope = $1 returning *', [change.scope, change.autonomyEnabled, change.reason, change.changedBy, version])).rows[0]!
        : (await c.query<Row>('insert into autonomy_controls (scope, autonomy_enabled, reason, changed_by, changed_at, version) values ($1, $2, $3, $4, clock_timestamp(), 1) returning *', [change.scope, change.autonomyEnabled, change.reason, change.changedBy])).rows[0]!;
      await c.query('insert into autonomy_control_events (scope, autonomy_enabled, reason, changed_by, version, correlation_id) values ($1, $2, $3, $4, $5, $6)', [change.scope, change.autonomyEnabled, change.reason, change.changedBy, version, change.correlationId]);
      return controlFromRow(row);
    });
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  async recordInbound(e: NewInboundEvent): Promise<{ record: InboundEventRecord; created: boolean }> {
    // One statement: a concurrent or repeated delivery of the same provider event only increments the counter.
    const r = (await query<Row>(
      this.#pool,
      `insert into inbound_events (inbound_id, channel, provider_event_id, status, content_kind, content_type, content, content_sha256, conversation_key, account_ref, conversation_ref, occurred_at, failure_code, settled_at, correlation_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, case when $4 = 'received' then null else clock_timestamp() end, $14)
       on conflict (channel, provider_event_id) do update set duplicate_deliveries = inbound_events.duplicate_deliveries + 1
       returning *, (xmax = 0) as inserted`,
      [e.inboundId, e.channel, e.providerEventId, e.status, e.contentKind, e.contentType, e.content, e.contentSha256, e.conversationKey, e.accountRef, e.conversationRef, e.occurredAt, e.failureCode, e.correlationId],
    )).rows[0]!;
    return { record: inboundFromRow(r), created: r.inserted === true };
  }

  recordInboundInspected(e: NewInboundEvent, inspected: InspectedInbound): Promise<{ record: InboundEventRecord; created: boolean }> {
    const { conversationKey, accountRef, conversationRef, occurredAt, content } = e;
    if (conversationKey === null || accountRef === null || conversationRef === null || occurredAt === null || content === null) {
      return Promise.reject(new PlatformError('validation', 'incomplete_inbound_record', 'an inspected inbound needs its conversation, time and content'));
    }
    return withTransaction(this.#pool, async (c) => {
      // R4-I.1: serialized per conversation BEFORE the duplicate check, so a re-delivery is never inspected.
      await c.query('select pg_advisory_xact_lock($1::bigint)', [conversationLockKey(e.channel, conversationKey)]);
      const duplicate = (await c.query<Row>(
        'update inbound_events set duplicate_deliveries = duplicate_deliveries + 1 where channel = $1 and provider_event_id = $2 returning *',
        [e.channel, e.providerEventId],
      )).rows[0];
      if (duplicate) return { record: inboundFromRow(duplicate), created: false };
      const binding = (await c.query<Row>(`select * from channel_conversation_bindings where channel = $1 and conversation_key = $2 and status = 'open'`, [e.channel, conversationKey])).rows[0];
      const taskId = (binding?.task_id as string | null | undefined) ?? null;
      const state = taskId ? await taskStateOf(c, taskId) : null;
      const now = iso((await c.query<Row>('select clock_timestamp() as now')).rows[0]!.now);
      let decision: InspectionDecision = { kind: 'pass' };
      if (inspected.inspectable) {
        // A throw aborts the transaction: nothing is persisted and the provider re-delivers (ADR-040 inv. 5).
        decision = await inspected.inspector.inspect({ kind: 'text', text: content }, {
          channel: e.channel, accountRef, conversationRef, senderRef: inspected.senderRef, direct: inspected.direct, conversationKey,
          providerEventId: e.providerEventId, occurredAt, now,
          binding: binding
            ? {
                bindingId: binding.binding_id as string,
                recipientRef: binding.recipient_ref as string,
                taskId,
                taskAcceptsInput: state !== null && !state.terminalIntent && !['completed', 'cancelled', 'failed'].includes(state.status),
                humanOwned: state?.humanOwned ?? false,
              }
            : null,
        }, c);
      }
      // The decided text is the only one persisted and hashed.
      const text = decision.kind === 'replace' ? decision.text : content;
      const r = (await c.query<Row>(
        `insert into inbound_events (inbound_id, channel, provider_event_id, status, content_kind, content_type, content, content_sha256, conversation_key, account_ref, conversation_ref, occurred_at, failure_code, settled_at, correlation_id)
         values ($1, $2, $3, 'received', $4, $5, $6, $7, $8, $9, $10, $11, null, null, $12) returning *`,
        [e.inboundId, e.channel, e.providerEventId, e.contentKind, e.contentType, text, sha256Hex(text), conversationKey, accountRef, conversationRef, occurredAt, e.correlationId],
      )).rows[0]!;
      return { record: inboundFromRow(r), created: true };
    });
  }

  async settleInbound(inboundId: string, s: InboundSettlement): Promise<void> {
    // Settled: the canonical text and the address are no longer kept here (the task input and the binding hold them).
    await query(
      this.#pool,
      `update inbound_events set status = $2, binding_id = coalesce($3, binding_id), task_id = coalesce($4, task_id), input_id = coalesce($5, input_id),
              disposition = $6, failure_code = $7, settled_at = clock_timestamp(), content = null, conversation_ref = null
        where inbound_id = $1 and status = 'received'`,
      [inboundId, s.status, s.bindingId ?? null, s.taskId ?? null, s.inputId ?? null, s.disposition ?? null, s.failureCode ?? null],
    );
  }

  async unsettledInbound(olderThanMs: number, limit: number): Promise<InboundEventRecord[]> {
    const r = await query<Row>(this.#pool, `select * from inbound_events where status = 'received' and received_at <= clock_timestamp() - $1::int * interval '1 millisecond' order by received_at limit $2`, [olderThanMs, limit]);
    return r.rows.map(inboundFromRow);
  }

  // ---------------------------------------------------------------------------
  // Conversation bindings
  // ---------------------------------------------------------------------------

  async findOpenBinding(channel: string, conversationKey: string): Promise<ConversationBindingRecord | null> {
    const r = await query<Row>(this.#pool, `select * from channel_conversation_bindings where channel = $1 and conversation_key = $2 and status = 'open'`, [channel, conversationKey]);
    return r.rows[0] ? bindingFromRow(r.rows[0]) : null;
  }

  async openBinding(b: NewConversationBinding): Promise<ConversationBindingRecord> {
    const inserted = await query<Row>(
      this.#pool,
      `insert into channel_conversation_bindings (binding_id, channel, conversation_key, account_ref, recipient_ref, status, autonomy, eligibility_reason, rollout_fingerprint, profile, profile_fingerprint)
       values ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, $10)
       on conflict (channel, conversation_key) where status = 'open' do nothing returning *`,
      [b.bindingId, b.channel, b.conversationKey, b.accountRef, b.recipientRef, b.autonomy, b.eligibilityReason, b.rolloutFingerprint, b.profile, b.profileFingerprint],
    );
    if (inserted.rows[0]) return bindingFromRow(inserted.rows[0]);
    const winner = await this.findOpenBinding(b.channel, b.conversationKey);
    if (!winner) throw new PlatformError('conflict', 'binding_race_unresolved', 'a concurrent binding was created and closed; retry');
    return winner;
  }

  async attachTask(bindingId: string, taskId: string): Promise<ConversationBindingRecord> {
    const r = await query<Row>(this.#pool, 'update channel_conversation_bindings set task_id = $2 where binding_id = $1 and (task_id is null or task_id = $2) returning *', [bindingId, taskId]);
    if (!r.rows[0]) throw new PlatformError('conflict', 'binding_task_mismatch', 'the binding already serves another task');
    return bindingFromRow(r.rows[0]);
  }

  async closeBinding(bindingId: string, reason: string): Promise<void> {
    await query(this.#pool, `update channel_conversation_bindings set status = 'closed', closed_at = clock_timestamp(), closed_reason = $2 where binding_id = $1 and status = 'open'`, [bindingId, reason]);
  }

  async touchBinding(bindingId: string, at: string): Promise<void> {
    await query(this.#pool, 'update channel_conversation_bindings set last_inbound_at = greatest(coalesce(last_inbound_at, $2::timestamptz), $2::timestamptz) where binding_id = $1', [bindingId, at]);
  }

  async bindingByTask(taskId: string): Promise<ConversationBindingRecord | null> {
    const r = await query<Row>(this.#pool, 'select * from channel_conversation_bindings where task_id = $1', [taskId]);
    return r.rows[0] ? bindingFromRow(r.rows[0]) : null;
  }

  async taskState(taskId: string): Promise<TaskStateFacts | null> {
    return taskStateOf(this.#pool, taskId);
  }

  // ---------------------------------------------------------------------------
  // Outbound — creation
  // ---------------------------------------------------------------------------

  async materializeResponses(command: { limit: number }): Promise<OutboundRecord[]> {
    const steps = (await query<Row>(
      this.#pool,
      `select s.step_id, s.run_id, s.task_id, s.context_snapshot_id, s.decision->>'content' as content, b.binding_id, b.channel, b.profile, t.correlation_id
         from channel_conversation_bindings b
         join agent_run_steps s on s.task_id = b.task_id and s.decision_type = 'respond' and s.outcome = 'recorded'
         join agent_tasks t on t.task_id = s.task_id
        where not exists (select 1 from outbound_messages o where o.response_step_id = s.step_id)
        order by s.created_at, s.step_id limit $1`,
      [command.limit],
    )).rows;
    const created: OutboundRecord[] = [];
    for (const s of steps) {
      const content = typeof s.content === 'string' ? s.content : '';
      const sha = sha256Hex(content);
      const row = await withTransaction(this.#pool, async (c) => {
        // Serialize materialization with task input writes and sibling responses.
        // This keeps both the causal frontier and the duplicate check stable.
        await c.query('select task_id from agent_tasks where task_id = $1 for update', [s.task_id]);
        // Text equality is only a secondary check: the existing live response
        // must represent the same latest inbound input, and this snapshot must
        // have evaluated every input currently durable for the task.
        const live = (await c.query<Row>(
          `with response_frontier as (
             select i.input_id
               from task_inputs i
              where i.task_id = $1
                and exists (
                  select 1 from context_snapshot_items current_item
                   where current_item.snapshot_id = $3
                     and current_item.item_id = 'memory:' || i.memory_entry_id::text)
              order by i.received_at desc, i.input_id desc
              limit 1
           )
           select o.outbound_id
             from outbound_messages o
             join agent_run_steps previous_step
               on previous_step.step_id = o.response_step_id and previous_step.task_id = o.task_id
             cross join response_frontier frontier
            where o.task_id = $1 and o.origin = 'agent' and o.content_sha256 = $2
              and o.status <> 'cancelled'
              and (o.status <> 'failed' or o.provider_message_id is not null)
              and exists (
                select 1 from task_inputs previous_input
                 join context_snapshot_items previous_item
                   on previous_item.snapshot_id = previous_step.context_snapshot_id
                  and previous_item.item_id = 'memory:' || previous_input.memory_entry_id::text
                where previous_input.task_id = $1 and previous_input.input_id = frontier.input_id)
              and not exists (
                select 1 from task_inputs unseen_input
                 where unseen_input.task_id = $1
                   and not exists (
                     select 1 from context_snapshot_items current_item
                      where current_item.snapshot_id = $3
                        and current_item.item_id = 'memory:' || unseen_input.memory_entry_id::text))
            order by o.created_at, o.outbound_id limit 1`,
          [s.task_id, sha, s.context_snapshot_id],
        )).rows[0];
        const outboundId = randomUUID();
        const r = await c.query<Row>(
          `insert into outbound_messages (outbound_id, origin, response_step_id, task_id, run_id, binding_id, channel, idempotency_key, content_sha256, status, cancel_reason, duplicate_of, profile, correlation_id)
           values ($1, 'agent', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           on conflict (response_step_id) do nothing returning *`,
          [outboundId, s.step_id, s.task_id, s.run_id, s.binding_id, s.channel, `r4-out:${s.step_id as string}`, sha, live ? 'cancelled' : 'pending', live ? 'duplicate_content' : null, live?.outbound_id ?? null, s.profile, s.correlation_id],
        );
        return r.rows[0] ?? null;
      });
      if (row) created.push(outboundFromRow(row));
    }
    return created;
  }

  createOperatorOutbound(command: NewOperatorOutbound): Promise<{ record: OutboundRecord; replayed: boolean }> {
    return withTransaction(this.#pool, async (c) => {
      const binding = (await c.query<Row>('select * from channel_conversation_bindings where task_id = $1', [command.taskId])).rows[0];
      if (!binding) throw new PlatformError('precondition', 'task_not_channel_bound', 'the task is not bound to a channel conversation');
      const sha = sha256Hex(command.text);
      const inserted = (await c.query<Row>(
        `insert into outbound_messages (outbound_id, origin, task_id, binding_id, channel, idempotency_key, content_sha256, body, status, human_ref, response_key, profile, correlation_id)
         values ($1, 'operator', $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11)
         on conflict (task_id, response_key) where origin = 'operator' do nothing returning *`,
        [command.outboundId, command.taskId, binding.binding_id, binding.channel, `r4-op:${command.outboundId}`, sha, command.text, command.humanRef, command.responseKey, binding.profile, command.correlationId],
      )).rows[0];
      if (inserted) return { record: outboundFromRow(inserted), replayed: false };
      const existing = (await c.query<Row>(`select * from outbound_messages where task_id = $1 and response_key = $2 and origin = 'operator'`, [command.taskId, command.responseKey])).rows[0]!;
      if (existing.content_sha256 !== sha || existing.human_ref !== command.humanRef) throw new PlatformError('conflict', 'idempotency_key_reused', 'responseKey was already used for a different message');
      return { record: outboundFromRow(existing), replayed: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Outbound — dispatch
  // ---------------------------------------------------------------------------

  claimNextOutbound(command: ClaimOutboundCommand): Promise<DispatchClaim | null> {
    return withTransaction(this.#pool, async (c) => {
      const row = (await c.query<Row>(
        `select * from outbound_messages where status = 'pending' and (next_attempt_at is null or next_attempt_at <= clock_timestamp())
          order by created_at, outbound_id limit 1 for update skip locked`,
      )).rows[0];
      if (!row) return null;
      const outbound = outboundFromRow(row);
      // Inputs and handoffs lock the Task before they commit. Share that lock
      // so the delivery decision and the pending → dispatching transition see
      // one stable ownership and inbound frontier.
      await c.query('select task_id from agent_tasks where task_id = $1 for update', [outbound.taskId]);
      const now = iso((await c.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now);
      const binding = bindingFromRow((await c.query<Row>('select * from channel_conversation_bindings where binding_id = $1', [outbound.bindingId])).rows[0]!);
      const task = (await taskStateOf(c, outbound.taskId))!;
      const controls = controlsState((await c.query<Row>('select * from autonomy_controls')).rows);
      let supersededByNewerInput = false;
      let text: string;
      if (outbound.origin === 'agent') {
        const step = (await c.query<Row>('select context_snapshot_id, decision->>\'content\' as content from agent_run_steps where step_id = $1', [outbound.responseStepId])).rows[0]!;
        text = String(step.content);
        // Causal staleness: a contact input exists that the context which produced this response never evaluated.
        if (step.context_snapshot_id) {
          supersededByNewerInput = (await c.query(
            `select 1 from task_inputs i where i.task_id = $1 and not exists (
               select 1 from context_snapshot_items ci where ci.snapshot_id = $2 and ci.item_id = 'memory:' || i.memory_entry_id::text) limit 1`,
            [outbound.taskId, step.context_snapshot_id],
          )).rowCount !== 0;
        }
      } else {
        text = String(row.body);
      }
      const windowMs = command.customerWindowMs(outbound.channel);
      const windowOpen = windowMs === null ? null : binding.lastInboundAt !== null && Date.parse(now) - Date.parse(binding.lastInboundAt) < windowMs;
      const decision = command.decide({
        origin: outbound.origin,
        channel: outbound.channel,
        createdAt: outbound.createdAt,
        now,
        controls,
        binding: { status: binding.status, autonomous: binding.autonomy === 'autonomous', deniedNow: command.deniedNow(binding.conversationKey) },
        task: { status: task.status, humanOwned: task.humanOwned },
        supersededByNewerInput,
        windowOpen,
      });
      if (decision.kind === 'hold') {
        const held = (await c.query<Row>(
          `update outbound_messages set hold_reason = $2, next_attempt_at = clock_timestamp() + $3::int * interval '1 millisecond', updated_at = clock_timestamp() where outbound_id = $1 returning *`,
          [outbound.outboundId, decision.reason, command.holdRecheckMs],
        )).rows[0]!;
        return { kind: 'held', outbound: outboundFromRow(held), reason: decision.reason };
      }
      if (decision.kind === 'cancel') {
        const cancelled = (await c.query<Row>(
          `update outbound_messages set status = 'cancelled', cancel_reason = $2, hold_reason = null, next_attempt_at = null, updated_at = clock_timestamp() where outbound_id = $1 returning *`,
          [outbound.outboundId, decision.reason],
        )).rows[0]!;
        return { kind: 'cancelled', outbound: outboundFromRow(cancelled), reason: decision.reason };
      }
      const claimed = (await c.query<Row>(
        `update outbound_messages set status = 'dispatching', attempts = attempts + 1, lease_generation = lease_generation + 1, lease_owner = $2,
                lease_expires_at = clock_timestamp() + $3::int * interval '1 millisecond', hold_reason = null, next_attempt_at = null,
                dispatched_at = coalesce(dispatched_at, clock_timestamp()), updated_at = clock_timestamp()
          where outbound_id = $1 returning *`,
        [outbound.outboundId, command.owner, command.leaseMs],
      )).rows[0]!;
      // The attempt exists BEFORE the provider call: an attempt without outcome means "the process died during the call".
      await c.query('insert into outbound_delivery_attempts (outbound_id, attempt, lease_generation, owner) values ($1, $2, $3, $4)', [outbound.outboundId, claimed.attempts, claimed.lease_generation, command.owner]);
      const record = outboundFromRow(claimed);
      return {
        kind: 'dispatch', outbound: record, accountRef: binding.accountRef, recipientRef: binding.recipientRef, text,
        token: { outboundId: record.outboundId, owner: command.owner, generation: record.leaseGeneration, attempt: record.attempts },
      };
    });
  }

  recordSubmission(token: DispatchToken, result: SubmissionResult, disposition: SubmissionDisposition): Promise<{ applied: boolean; outbound: OutboundRecord }> {
    return withTransaction(this.#pool, async (c) => {
      const row = (await c.query<Row>('select * from outbound_messages where outbound_id = $1 for update', [token.outboundId])).rows[0];
      if (!row) throw new PlatformError('not_found', 'outbound_not_found', 'outbound message not found');
      await c.query(
        `update outbound_delivery_attempts set finished_at = clock_timestamp(), outcome = $3, provider_message_id = $4, http_status = $5, error_class = $6, error_code = $7, latency_ms = $8
          where outbound_id = $1 and attempt = $2 and finished_at is null`,
        [token.outboundId, token.attempt, result.outcome, result.providerMessageId, result.httpStatus, result.errorClass, result.errorCode, Math.round(result.latencyMs)],
      );
      const fenced = row.status === 'dispatching' && row.lease_owner === token.owner && row.lease_generation === token.generation;
      if (!fenced) {
        // The lease was lost (e.g. the sweep declared it unknown). A late acceptance is still EVIDENCE: unknown → accepted.
        if (result.outcome === 'accepted' && result.providerMessageId && row.status === 'unknown') {
          const updated = (await c.query<Row>(
            `update outbound_messages set status = 'accepted', provider_message_id = $2, accepted_at = coalesce(accepted_at, clock_timestamp()), updated_at = clock_timestamp() where outbound_id = $1 returning *`,
            [token.outboundId, result.providerMessageId],
          )).rows[0]!;
          await this.#matchPendingEvidence(c, updated.channel as string, result.providerMessageId);
          return { applied: false, outbound: outboundFromRow((await c.query<Row>('select * from outbound_messages where outbound_id = $1', [token.outboundId])).rows[0]!) };
        }
        return { applied: false, outbound: outboundFromRow(row) };
      }
      const set = (status: OutboundStatus, extra: string, params: unknown[]) =>
        c.query<Row>(
          `update outbound_messages set status = '${status}', lease_owner = null, lease_expires_at = null, error_class = $2, error_code = $3, updated_at = clock_timestamp()${extra} where outbound_id = $1 returning *`,
          [token.outboundId, result.errorClass, result.errorCode, ...params],
        );
      let updated: Row;
      switch (disposition.status) {
        case 'accepted':
          updated = (await set('accepted', ', provider_message_id = $4, accepted_at = coalesce(accepted_at, clock_timestamp())', [result.providerMessageId])).rows[0]!;
          await this.#matchPendingEvidence(c, updated.channel as string, result.providerMessageId!);
          updated = (await c.query<Row>('select * from outbound_messages where outbound_id = $1', [token.outboundId])).rows[0]!;
          break;
        case 'pending':
          updated = (await set('pending', ", next_attempt_at = clock_timestamp() + $4::int * interval '1 millisecond'", [Math.max(0, Math.round(disposition.retryInMs))])).rows[0]!;
          break;
        case 'failed':
          updated = (await set('failed', ', failed_at = clock_timestamp()', [])).rows[0]!;
          break;
        case 'unknown':
          updated = (await set('unknown', '', [])).rows[0]!;
          break;
      }
      return { applied: true, outbound: outboundFromRow(updated) };
    });
  }

  expireDispatchLeases(limit: number): Promise<OutboundRecord[]> {
    return withTransaction(this.#pool, async (c) => {
      const rows = (await c.query<Row>(
        `update outbound_messages set status = 'unknown', lease_owner = null, lease_expires_at = null, error_class = 'lease_expired_during_dispatch', updated_at = clock_timestamp()
          where outbound_id in (select outbound_id from outbound_messages where status = 'dispatching' and lease_expires_at <= clock_timestamp() order by lease_expires_at limit $1 for update skip locked)
          returning *`,
        [limit],
      )).rows;
      for (const r of rows) {
        await c.query(
          `update outbound_delivery_attempts set finished_at = clock_timestamp(), outcome = 'unknown', error_class = 'lease_expired_during_dispatch' where outbound_id = $1 and finished_at is null`,
          [r.outbound_id],
        );
      }
      return rows.map(outboundFromRow);
    });
  }

  // ---------------------------------------------------------------------------
  // Provider evidence and operator settlement
  // ---------------------------------------------------------------------------

  applyProviderStatus(event: ProviderStatusEvent) {
    return withTransaction(this.#pool, async (c) => {
      const inserted = (await c.query<Row>(
        `insert into outbound_delivery_events (event_id, channel, event_key, provider_message_id, status, occurred_at, effect, error_code)
         values ($1, $2, $3, $4, $5, $6, 'unmatched', $7) on conflict (channel, event_key) do nothing returning *`,
        [randomUUID(), event.channel, event.eventKey, event.providerMessageId, event.status, event.occurredAt, event.errorCode],
      )).rows[0];
      if (!inserted) return { duplicate: true, effect: 'ignored' as const, outbound: null, from: null, to: null };
      const applied = await this.#applyEvidence(c, inserted);
      return { duplicate: false, ...applied };
    });
  }

  /** Applies one stored evidence row to its outbound (row-locked), recording the effect. */
  async #applyEvidence(c: PoolClient, evidence: Row): Promise<{ effect: 'applied' | 'ignored' | 'unmatched'; outbound: OutboundRecord | null; from: OutboundStatus | null; to: OutboundStatus | null }> {
    const row = (await c.query<Row>('select * from outbound_messages where channel = $1 and provider_message_id = $2 for update', [evidence.channel, evidence.provider_message_id])).rows[0];
    if (!row) return { effect: 'unmatched', outbound: null, from: null, to: null };
    const from = row.status as OutboundStatus;
    const to = statusAfterEvidence(from, evidence.status as 'accepted' | 'delivered' | 'read' | 'failed');
    let updated = row;
    if (to) {
      const column = STATUS_TIMESTAMP[to];
      updated = (await c.query<Row>(
        `update outbound_messages set status = $2, ${column ? `${column} = coalesce(${column}, $3::timestamptz),` : ''} error_code = case when $2 = 'failed' then $4 else error_code end,
                accepted_at = case when $2 in ('delivered', 'read') then coalesce(accepted_at, $3::timestamptz) else accepted_at end, updated_at = clock_timestamp()
          where outbound_id = $1 returning *`,
        [row.outbound_id, to, evidence.occurred_at, evidence.error_code],
      )).rows[0]!;
    }
    await c.query('update outbound_delivery_events set outbound_id = $2, effect = $3, from_status = $4, to_status = $5 where event_id = $1', [evidence.event_id, row.outbound_id, to ? 'applied' : 'ignored', from, to]);
    return { effect: to ? 'applied' : 'ignored', outbound: outboundFromRow(updated), from, to };
  }

  /** Evidence that arrived before the submission recorded its provider id is applied now, in order. */
  async #matchPendingEvidence(c: PoolClient, channel: string, providerMessageId: string): Promise<void> {
    const pending = (await c.query<Row>(`select * from outbound_delivery_events where channel = $1 and provider_message_id = $2 and effect = 'unmatched' order by occurred_at, received_at`, [channel, providerMessageId])).rows;
    for (const evidence of pending) await this.#applyEvidence(c, evidence);
  }

  resolveOutbound(command: { outboundId: string; outcome: 'delivered' | 'failed'; humanRef: string; note: string; correlationId: string }): Promise<OutboundRecord> {
    return withTransaction(this.#pool, async (c) => {
      const row = (await c.query<Row>('select * from outbound_messages where outbound_id = $1 for update', [command.outboundId])).rows[0];
      if (!row) throw new PlatformError('not_found', 'outbound_not_found', 'outbound message not found');
      const to = statusAfterOperatorResolution(row.status as OutboundStatus, command.outcome);
      if (!to) throw new PlatformError('conflict', 'outbound_not_unknown', `only an unknown outcome can be settled by an operator (status: ${row.status as string})`);
      const column = STATUS_TIMESTAMP[to]!;
      return outboundFromRow((await c.query<Row>(
        `update outbound_messages set status = $2, ${column} = clock_timestamp(), resolved_by = $3, resolution_note = $4, updated_at = clock_timestamp() where outbound_id = $1 returning *`,
        [command.outboundId, to, command.humanRef, command.note.slice(0, 1000)],
      )).rows[0]!);
    });
  }

  cancelOutbound(command: { outboundId: string; humanRef: string; reason: string; correlationId: string }): Promise<OutboundRecord> {
    return withTransaction(this.#pool, async (c) => {
      const row = (await c.query<Row>('select * from outbound_messages where outbound_id = $1 for update', [command.outboundId])).rows[0];
      if (!row) throw new PlatformError('not_found', 'outbound_not_found', 'outbound message not found');
      if (row.status !== 'pending') throw new PlatformError('conflict', 'outbound_not_pending', `only a pending outbound can be cancelled (status: ${row.status as string})`);
      return outboundFromRow((await c.query<Row>(
        `update outbound_messages set status = 'cancelled', cancel_reason = $2, hold_reason = null, next_attempt_at = null, resolved_by = $3, updated_at = clock_timestamp() where outbound_id = $1 returning *`,
        [command.outboundId, command.reason, command.humanRef],
      )).rows[0]!);
    });
  }

  async cancelPendingAgentOutbound(taskId: string, reason: string): Promise<number> {
    const r = await query(this.#pool, `update outbound_messages set status = 'cancelled', cancel_reason = $2, hold_reason = null, next_attempt_at = null, updated_at = clock_timestamp() where task_id = $1 and origin = 'agent' and status = 'pending'`, [taskId, reason]);
    return r.rowCount ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Read side
  // ---------------------------------------------------------------------------

  async outbound(outboundId: string): Promise<OutboundRecord | null> {
    const r = await query<Row>(this.#pool, 'select * from outbound_messages where outbound_id = $1', [outboundId]);
    return r.rows[0] ? outboundFromRow(r.rows[0]) : null;
  }

  async outboundForTask(taskId: string): Promise<OutboundRecord[]> {
    return (await query<Row>(this.#pool, 'select * from outbound_messages where task_id = $1 order by created_at, outbound_id', [taskId])).rows.map(outboundFromRow);
  }

  async attempts(outboundId: string): Promise<DeliveryAttemptRecord[]> {
    return (await query<Row>(this.#pool, 'select * from outbound_delivery_attempts where outbound_id = $1 order by attempt', [outboundId])).rows.map(attemptFromRow);
  }

  async deliveryEvents(outboundId: string): Promise<DeliveryEventRecord[]> {
    return (await query<Row>(this.#pool, 'select * from outbound_delivery_events where outbound_id = $1 order by occurred_at, received_at', [outboundId])).rows.map(eventFromRow);
  }

  async thread(taskId: string): Promise<ThreadEntry[]> {
    const entries: ThreadEntry[] = [];
    const inputs = (await query<Row>(this.#pool, `select i.input_id, i.received_at, m.content->>'text' as text from task_inputs i join memory_entries m on m.entry_id = i.memory_entry_id where i.task_id = $1`, [taskId])).rows;
    for (const r of inputs) entries.push(entry(iso(r.received_at), r.input_id as string, 'contact', (r.text as string | null) ?? null, { inputId: r.input_id as string }, null));
    const responses = (await query<Row>(
      this.#pool,
      `select s.step_id as s_step_id, s.run_id as s_run_id, s.created_at as s_created_at, s.decision->>'content' as s_text, o.* from agent_run_steps s left join outbound_messages o on o.response_step_id = s.step_id
        where s.task_id = $1 and s.decision_type = 'respond' and s.outcome = 'recorded'`,
      [taskId],
    )).rows;
    for (const r of responses) {
      entries.push(entry(iso(r.s_created_at), r.s_step_id as string, 'agent', (r.s_text as string | null) ?? null, { stepId: r.s_step_id as string, runId: r.s_run_id as string }, r.outbound_id ? delivery(r) : null));
    }
    const operator = (await query<Row>(this.#pool, `select * from outbound_messages where task_id = $1 and origin = 'operator'`, [taskId])).rows;
    for (const r of operator) entries.push(entry(iso(r.created_at), r.outbound_id as string, 'operator', r.body as string, { humanRef: r.human_ref as string }, delivery(r)));
    const events = (await query<Row>(
      this.#pool,
      `select event_id, event_type, occurred_at, actor_ref, data from temporal_events where task_id = $1 and event_type in ('handoff.requested', 'handoff.activated', 'handoff.released', 'handoff.cancelled', 'task.cancelled')`,
      [taskId],
    )).rows;
    for (const r of events) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      entries.push(entry(iso(r.occurred_at), r.event_id as string, 'event', null, { type: r.event_type as string, actorRef: r.actor_ref as string, initiatedBy: typeof data.initiatedBy === 'string' ? data.initiatedBy : null, reason: typeof data.reason === 'string' ? data.reason : null }, null));
    }
    return entries.sort((a, b) => (a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0));
  }

  async conversations(limit: number): Promise<ConversationSummary[]> {
    const r = await query<Row>(
      this.#pool,
      `select b.*, t.status as task_status,
              exists (select 1 from human_requests h where h.task_id = b.task_id and h.kind = 'handoff' and h.status in ('requested', 'active')) as human_owned
         from channel_conversation_bindings b left join agent_tasks t on t.task_id = b.task_id
        order by coalesce(b.last_inbound_at, b.created_at) desc limit $1`,
      [limit],
    );
    return r.rows.map((row) => ({
      bindingId: row.binding_id as string, channel: row.channel as string, taskId: (row.task_id as string | null) ?? null, taskStatus: (row.task_status as string | null) ?? null,
      bindingStatus: row.status as 'open' | 'closed', autonomy: row.autonomy as 'autonomous' | 'excluded', humanOwned: row.human_owned === true,
      lastInboundAt: isoOrNull(row.last_inbound_at), createdAt: iso(row.created_at),
    }));
  }

  async attention(): Promise<ProductionAttention> {
    const q = (sql: string) => query<Row>(this.#pool, sql).then((r) => r.rows);
    return {
      unknownOutbound: (await q(`select * from outbound_messages where status = 'unknown' order by updated_at`)).map(outboundFromRow),
      heldOutbound: (await q(`select * from outbound_messages where status = 'pending' and hold_reason is not null order by created_at`)).map(outboundFromRow),
      failedOutbound: (await q(`select * from outbound_messages where status = 'failed' order by updated_at desc limit 200`)).map(outboundFromRow),
      failedInbound: (await q(`select * from inbound_events where status = 'failed' order by received_at desc limit 200`)).map(inboundFromRow),
      rejectedInbound: (await q(`select * from inbound_events where status = 'rejected' order by received_at desc limit 200`)).map(inboundFromRow),
      unmatchedStatusEvents: (await q(`select * from outbound_delivery_events where effect = 'unmatched' order by received_at desc limit 200`)).map(eventFromRow),
    };
  }

  async metrics(): Promise<ProductionMetrics> {
    const one = async (sql: string): Promise<number> => Number((await query<Row>(this.#pool, sql)).rows[0]?.n ?? 0);
    const grouped = async (sql: string): Promise<Record<string, number>> => Object.fromEntries((await query<Row>(this.#pool, sql)).rows.map((r) => [String(r.k), Number(r.n)]));
    const pct = async (sql: string) => {
      const r = (await query<Row>(this.#pool, `select percentile_cont(0.5) within group (order by ms) as p50, percentile_cont(0.95) within group (order by ms) as p95, count(*) as n from (${sql}) x`)).rows[0]!;
      return { p50: r.p50 === null ? null : Math.round(Number(r.p50)), p95: r.p95 === null ? null : Math.round(Number(r.p95)), n: Number(r.n) };
    };
    const bound = 'select task_id from channel_conversation_bindings where task_id is not null';
    const held = await grouped(`select substring(disposition from 6) as k, count(*) as n from inbound_events where disposition like 'held:%' group by 1`);
    const heldNow = await grouped(`select hold_reason as k, count(*) as n from outbound_messages where status = 'pending' and hold_reason is not null group by 1`);
    const ingested = await one(`select count(*) as n from inbound_events where status = 'ingested'`);
    const tasksCreated = await one(`select count(*) as n from channel_conversation_bindings where task_id is not null`);
    return {
      inbound_received: await one(`select count(*) as n from inbound_events where content_kind <> 'rejected'`),
      inbound_duplicate: await one('select coalesce(sum(duplicate_deliveries), 0) as n from inbound_events'),
      inbound_rejected: await one(`select count(*) as n from inbound_events where status = 'rejected'`),
      inbound_failed: await one(`select count(*) as n from inbound_events where status = 'failed'`),
      task_created: tasksCreated,
      task_continued: Math.max(0, ingested - tasksCreated),
      inbound_held: held,
      outbound_created: await one('select count(*) as n from outbound_messages'),
      outbound_dispatch_attempted: await one('select count(*) as n from outbound_delivery_attempts'),
      outbound_accepted: await one('select count(*) as n from outbound_messages where accepted_at is not null'),
      outbound_delivered: await one('select count(*) as n from outbound_messages where delivered_at is not null'),
      outbound_read: await one('select count(*) as n from outbound_messages where read_at is not null'),
      outbound_failed: await one(`select count(*) as n from outbound_messages where status = 'failed'`),
      outbound_unknown: await one(`select count(*) as n from outbound_messages where status = 'unknown'`),
      outbound_cancelled: await grouped(`select cancel_reason as k, count(*) as n from outbound_messages where status = 'cancelled' group by 1`),
      outbound_held_now: Object.values(heldNow).reduce((a, b) => a + b, 0),
      kill_switch_blocks: (held.autonomy_disabled ?? 0) + (heldNow.autonomy_disabled ?? 0),
      rollout_blocks: (held.rollout_excluded ?? 0) + (held.autonomy_denied ?? 0) + (heldNow.rollout_excluded ?? 0) + (heldNow.autonomy_denied ?? 0),
      human_handoffs: await one(`select count(*) as n from human_requests where kind = 'handoff' and task_id in (${bound})`),
      approvals: await one(`select count(*) as n from human_requests where kind = 'approval' and task_id in (${bound})`),
      run_failure_recoveries: await one(`select count(*) as n from agent_runs where termination_details->'runFailureRecovery'->>'outcome' = 'continued' and task_id in (${bound})`),
      model_calls: await one(`select count(*) as n from agent_run_steps where origin = 'model' and task_id in (${bound})`),
      writes_by_capability: await grouped(`select capability_id as k, count(*) as n from action_executions where task_id in (${bound}) group by 1`),
      latency: {
        outboundDispatchMs: await pct(`select extract(epoch from (accepted_at - created_at)) * 1000 as ms from outbound_messages where accepted_at is not null`),
        deliveryConfirmationMs: await pct(`select extract(epoch from (delivered_at - accepted_at)) * 1000 as ms from outbound_messages where delivered_at is not null and accepted_at is not null`),
        customerTurnMs: await pct(
          `select extract(epoch from (o.accepted_at - (select max(i.received_at) from task_inputs i where i.task_id = o.task_id and i.received_at <= s.created_at))) * 1000 as ms
             from outbound_messages o join agent_run_steps s on s.step_id = o.response_step_id where o.accepted_at is not null`,
        ),
      },
    };
  }
}

async function taskStateOf(db: Db, taskId: string): Promise<TaskStateFacts | null> {
  const r = await db.query<Row>(
    `select t.status,
            exists (select 1 from task_terminal_intents i where i.task_id = t.task_id) as terminal_intent,
            exists (select 1 from human_requests h where h.task_id = t.task_id and h.kind = 'handoff' and h.status in ('requested', 'active')) as human_owned
       from agent_tasks t where t.task_id = $1`,
    [taskId],
  );
  const row = r.rows[0];
  return row ? { status: row.status as string, terminalIntent: row.terminal_intent === true, humanOwned: row.human_owned === true } : null;
}

function entry(at: string, id: string, kind: ThreadEntry['kind'], text: string | null, refs: Record<string, string | null>, deliveryState: ThreadEntry['delivery']): ThreadEntry {
  return { cursor: `${at}|${id}`, at, kind, text, refs, delivery: deliveryState };
}

function delivery(r: Row): NonNullable<ThreadEntry['delivery']> {
  return { outboundId: r.outbound_id as string, status: r.status as OutboundStatus, holdReason: (r.hold_reason as string | null) ?? null, cancelReason: (r.cancel_reason as string | null) ?? null, providerMessageId: (r.provider_message_id as string | null) ?? null };
}
