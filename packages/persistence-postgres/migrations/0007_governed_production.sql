-- R4-I: governed production (ADR-029). 0001–0006 stay byte-for-byte intact.
--
-- Only operational state R4 must own durably to operate a real channel:
-- idempotency (inbound dedupe), conversation binding, the delivery
-- lifecycle of outbound messages and their audit/reconciliation evidence,
-- and the autonomy controls. Conversation text, decisions, ownership and
-- effects stay in their existing tables (task_inputs/memory, step log,
-- human_requests, action ledger) and are only referenced. Analytics stay in
-- artifacts. Owner of every table: @r4/live-ops (through its
-- ProductionStore port; SQL lives here, in persistence-postgres).

-- ---------------------------------------------------------------------------
-- Autonomy controls (kill switch). One row per scope; `global` is born
-- DISABLED: nothing is autonomous until an operator enables it. Every change
-- is an append-only control event (audit).
-- ---------------------------------------------------------------------------
create table autonomy_controls (
  scope            text        primary key check (scope ~ '^(global|channel:[a-z][a-z0-9_.-]{0,63})$'),
  autonomy_enabled boolean     not null,
  reason           text        not null check (length(reason) between 1 and 500),
  changed_by       text        not null,
  changed_at       timestamptz not null,
  version          integer     not null check (version >= 1)
);
insert into autonomy_controls (scope, autonomy_enabled, reason, changed_by, changed_at, version)
values ('global', false, 'initial state: production autonomy is disabled until an operator enables it', 'migration:0007', clock_timestamp(), 1);

create table autonomy_control_events (
  event_id         uuid        primary key default gen_random_uuid(),
  scope            text        not null,
  autonomy_enabled boolean     not null,
  reason           text        not null,
  changed_by       text        not null,
  version          integer     not null,
  correlation_id   text        not null,
  occurred_at      timestamptz not null default clock_timestamp()
);
create trigger autonomy_control_events_immutable before update or delete on autonomy_control_events for each row execute function action_ledger_immutable();

-- ---------------------------------------------------------------------------
-- Conversation binding: channel conversation → the durable task serving it.
-- At most ONE open binding per conversation (partial unique index): two
-- concurrent first messages can never open two active tasks. The conversation
-- key is a keyed hash (no plain address); the delivery address lives only
-- here, where delivery needs it. `autonomy` is decided once (stable cohort).
-- ---------------------------------------------------------------------------
create table channel_conversation_bindings (
  binding_id          uuid        primary key,
  channel             text        not null check (channel ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  conversation_key    text        not null check (conversation_key ~ '^[0-9a-f]{64}$'),
  account_ref         text        not null check (length(account_ref) between 1 and 256),
  recipient_ref       text        not null check (length(recipient_ref) between 1 and 256),
  task_id             uuid        references agent_tasks (task_id),
  status              text        not null check (status in ('open', 'closed')),
  autonomy            text        not null check (autonomy in ('autonomous', 'excluded')),
  eligibility_reason  text        not null,
  rollout_fingerprint text        not null,
  profile             text        not null,
  profile_fingerprint text        not null,
  created_at          timestamptz not null default clock_timestamp(),
  last_inbound_at     timestamptz,
  closed_at           timestamptz,
  closed_reason       text,
  check ((status = 'closed') = (closed_at is not null))
);
create unique index channel_conversation_bindings_one_open on channel_conversation_bindings (channel, conversation_key) where status = 'open';
create unique index channel_conversation_bindings_one_per_task on channel_conversation_bindings (task_id) where task_id is not null;
create index channel_conversation_bindings_recent on channel_conversation_bindings (created_at desc);

-- ---------------------------------------------------------------------------
-- Inbound events: one row per provider event identity (unique): a provider
-- retry, a concurrent duplicate delivery or a replay is one canonical input.
-- Canonical fields only — never the raw provider payload. The text and the
-- address are kept only until the input is durable in R4 (then cleared).
-- ---------------------------------------------------------------------------
create table inbound_events (
  inbound_id        uuid        primary key,
  channel           text        not null,
  provider_event_id text        not null check (length(provider_event_id) between 1 and 256),
  status            text        not null check (status in ('received', 'ingested', 'rejected', 'failed')),
  content_kind      text        not null check (content_kind in ('text', 'unsupported', 'rejected')),
  content_type      text,
  content           text,
  content_sha256    text        check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  conversation_key  text,
  account_ref       text,
  conversation_ref  text,
  binding_id        uuid        references channel_conversation_bindings (binding_id),
  task_id           uuid        references agent_tasks (task_id),
  input_id          uuid        references task_inputs (input_id),
  disposition       text,
  failure_code      text,
  occurred_at       timestamptz,
  received_at       timestamptz not null default clock_timestamp(),
  settled_at        timestamptz,
  -- Re-deliveries of the same provider event (retries, concurrent duplicates): counted, never re-ingested.
  duplicate_deliveries integer  not null default 0 check (duplicate_deliveries >= 0),
  correlation_id    text        not null,
  unique (channel, provider_event_id),
  check ((status = 'received') = (settled_at is null)),
  check (status <> 'ingested' or (task_id is not null and input_id is not null and content is null and conversation_ref is null))
);
create index inbound_events_unsettled on inbound_events (received_at) where status = 'received';
create index inbound_events_attention on inbound_events (received_at) where status in ('failed', 'rejected');
create index inbound_events_task on inbound_events (task_id, received_at);

-- ---------------------------------------------------------------------------
-- Outbound messages: the delivery owner's durable intent. Agent output is
-- identified by the accepted `respond` step (unique): the same response can
-- never become two messages, whatever runs, recoveries or retries happen.
-- Content is referenced (the step's decision), never copied; operator text
-- (which has no other durable record) is stored in `body`.
-- ---------------------------------------------------------------------------
create table outbound_messages (
  outbound_id         uuid        primary key,
  origin              text        not null check (origin in ('agent', 'operator')),
  response_step_id    uuid        unique references agent_run_steps (step_id),
  task_id             uuid        not null references agent_tasks (task_id),
  run_id              uuid        references agent_runs (run_id),
  binding_id          uuid        not null references channel_conversation_bindings (binding_id),
  channel             text        not null,
  idempotency_key     text        not null unique,
  content_sha256      text        not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  body                text,
  status              text        not null check (status in ('pending', 'dispatching', 'accepted', 'delivered', 'read', 'failed', 'unknown', 'cancelled')),
  hold_reason         text,
  cancel_reason       text,
  duplicate_of        uuid        references outbound_messages (outbound_id),
  provider_message_id text,
  attempts            integer     not null default 0 check (attempts >= 0),
  next_attempt_at     timestamptz,
  lease_owner         text,
  lease_generation    integer     not null default 0 check (lease_generation >= 0),
  lease_expires_at    timestamptz,
  error_class         text,
  error_code          text,
  human_ref           text,
  response_key        text,
  resolved_by         text,
  resolution_note     text,
  profile             text        not null,
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp(),
  dispatched_at       timestamptz,
  accepted_at         timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_at           timestamptz,
  correlation_id      text        not null,
  check ((origin = 'agent') = (response_step_id is not null and run_id is not null)),
  check ((origin = 'operator') = (body is not null and human_ref is not null and response_key is not null)),
  check ((status = 'dispatching') = (lease_owner is not null and lease_expires_at is not null)),
  check (status <> 'cancelled' or cancel_reason is not null),
  check (hold_reason is null or status = 'pending'),
  unique (channel, provider_message_id)
);
create unique index outbound_messages_operator_key on outbound_messages (task_id, response_key) where origin = 'operator';
create index outbound_messages_dispatchable on outbound_messages (created_at) where status = 'pending';
create index outbound_messages_dispatching on outbound_messages (lease_expires_at) where status = 'dispatching';
create index outbound_messages_task on outbound_messages (task_id, created_at);
create index outbound_messages_attention on outbound_messages (updated_at) where status in ('unknown', 'failed');
-- Materialization reads accepted responses of bound tasks.
create index agent_run_steps_respond on agent_run_steps (task_id, created_at) where decision_type = 'respond';

-- One row per provider submission attempt, written BEFORE the call (an attempt
-- without outcome = the process died during the call: outcome unknown).
create table outbound_delivery_attempts (
  outbound_id         uuid        not null references outbound_messages (outbound_id),
  attempt             integer     not null check (attempt >= 1),
  lease_generation    integer     not null,
  owner               text        not null,
  started_at          timestamptz not null default clock_timestamp(),
  finished_at         timestamptz,
  outcome             text        check (outcome in ('accepted', 'not_sent', 'rejected', 'unknown')),
  provider_message_id text,
  http_status         integer,
  error_class         text,
  error_code          text,
  latency_ms          integer,
  primary key (outbound_id, attempt),
  check ((finished_at is null) = (outcome is null))
);

-- Provider delivery evidence (status callbacks), append-only and idempotent
-- per event key; `effect` records whether it moved the lifecycle.
create table outbound_delivery_events (
  event_id            uuid        primary key,
  channel             text        not null,
  event_key           text        not null,
  outbound_id         uuid        references outbound_messages (outbound_id),
  provider_message_id text        not null,
  status              text        not null check (status in ('accepted', 'delivered', 'read', 'failed')),
  occurred_at         timestamptz not null,
  received_at         timestamptz not null default clock_timestamp(),
  effect              text        not null check (effect in ('applied', 'ignored', 'unmatched')),
  from_status         text,
  to_status           text,
  error_code          text,
  unique (channel, event_key)
);
create index outbound_delivery_events_outbound on outbound_delivery_events (outbound_id, received_at);
create index outbound_delivery_events_unmatched on outbound_delivery_events (received_at) where effect = 'unmatched';
-- Append-only, except that evidence which arrived before its submission was
-- recorded (unmatched) is re-applied once when the provider id becomes known.
create function outbound_delivery_events_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.effect <> 'unmatched' or new.event_id <> old.event_id or new.event_key <> old.event_key
     or new.channel <> old.channel or new.provider_message_id <> old.provider_message_id or new.status <> old.status
     or new.occurred_at <> old.occurred_at or new.received_at <> old.received_at then
    raise exception 'outbound_delivery_events is append-only (only unmatched evidence can be matched once)' using errcode = 'check_violation';
  end if;
  return new;
end; $$;
create trigger outbound_delivery_events_guard before update or delete on outbound_delivery_events for each row execute function outbound_delivery_events_guard();
