-- R4-E: temporal + human runtime (ADR-021, ADR-022). 0001–0004 stay byte-for-byte intact.

-- ---------------------------------------------------------------------------
-- Temporal clock. Every R4-E due time, schedule lease and human/wait record
-- is judged against r4_now(). Production: the database clock, like C1 leases
-- (which keep using clock_timestamp() directly and are NOT governed by it).
-- A disposable test database may redefine it to advance temporal time
-- deterministically; no production code path does.
-- ---------------------------------------------------------------------------
create function r4_now() returns timestamptz language sql volatile as $$ select clock_timestamp() $$;

-- ---------------------------------------------------------------------------
-- Runs and steps: suspension by a wait or a handoff; the E decisions.
-- ---------------------------------------------------------------------------
alter table agent_runs drop constraint agent_runs_termination_reason_check;
alter table agent_runs add constraint agent_runs_termination_reason_check check (termination_reason in (
  'completed','model_failure','invalid_decision','capability_failure','budget_exhausted','lease_lost',
  'cancelled','internal_failure','approval_required','write_outcome_uncertain','waiting','human_handoff'));
alter table agent_runs drop constraint agent_runs_termination_matches_status;
alter table agent_runs add constraint agent_runs_termination_matches_status check (termination_reason is null or (
  (status = 'completed') = (termination_reason = 'completed') and
  (status = 'cancelled') = (termination_reason = 'cancelled') and
  (status = 'abandoned') = (termination_reason = 'lease_lost') and
  (status = 'suspended') = (termination_reason in ('approval_required','write_outcome_uncertain','waiting','human_handoff'))));
alter table agent_run_steps drop constraint agent_run_steps_decision_type_check;
alter table agent_run_steps add constraint agent_run_steps_decision_type_check check (decision_type in (
  'read_capability','respond','complete','propose_action','wait','request_consultation','request_handoff','manage_goal'));
-- (The cross-run interaction projection reads the task's step log through 0002's agent_run_steps_task_idx.)

-- ---------------------------------------------------------------------------
-- Human collaboration: consultation, approval, handoff. One typed envelope,
-- kind-specific payload and lifecycle. Decisions are append-only events.
-- ---------------------------------------------------------------------------
create table human_requests (
  request_id     uuid        primary key,
  task_id        uuid        not null references agent_tasks,
  -- Null only for an operator takeover of a task that never ran.
  run_id         uuid        references agent_runs,
  kind           text        not null check (kind in ('consultation','approval','handoff')),
  status         text        not null,
  human_ref      text,
  payload        jsonb       not null check (jsonb_typeof(payload) = 'object'),
  proposal_id    uuid        unique references action_proposals,
  created_at     timestamptz not null,
  updated_at     timestamptz not null,
  expires_at     timestamptz,
  correlation_id text        not null,
  check ((kind = 'approval') = (proposal_id is not null)),
  check ((kind = 'handoff') or run_id is not null),
  check ((kind = 'consultation' and status in ('requested','answered','cancelled','expired')) or
         (kind = 'approval' and status in ('requested','approved','rejected','cancelled','expired')) or
         (kind = 'handoff' and status in ('requested','active','released','cancelled'))),
  check (status <> 'active' or human_ref is not null),
  check (updated_at >= created_at)
);
create unique index human_requests_one_handoff on human_requests (task_id) where kind = 'handoff' and status in ('requested','active');
create index human_requests_task_idx on human_requests (task_id, created_at);
create index human_requests_attention on human_requests (kind, created_at) where status in ('requested','active');

-- ---------------------------------------------------------------------------
-- Waits: why a task without an active run is not runnable. At most one open.
-- ---------------------------------------------------------------------------
create table task_waits (
  wait_id        uuid        primary key,
  task_id        uuid        not null references agent_tasks,
  run_id         uuid        references agent_runs,
  kind           text        not null check (kind in ('WAIT_FOR_INPUT','WAIT_UNTIL','WAIT_FOR_HUMAN','WAIT_FOR_APPROVAL','WAIT_FOR_RECONCILIATION')),
  status         text        not null check (status in ('waiting','completed','cancelled')),
  -- How it ended: what satisfied it, or what superseded/cancelled it.
  resolution     text        check (resolution in ('input','timer','human','reconciliation','handoff','cancelled')),
  reference_id   uuid,
  due_at         timestamptz,
  created_at     timestamptz not null,
  completed_at   timestamptz,
  correlation_id text        not null,
  check ((status = 'waiting') = (completed_at is null)),
  check ((status = 'waiting') = (resolution is null)),
  check ((kind = 'WAIT_UNTIL') = (due_at is not null)),
  check (kind = 'WAIT_FOR_HUMAN' or run_id is not null)
);
create unique index task_waits_one_active on task_waits (task_id) where status = 'waiting';
create index task_waits_task_idx on task_waits (task_id, created_at);

-- ---------------------------------------------------------------------------
-- Schedules: durable "when", never "what". Claimed with SKIP LOCKED under a
-- lease + fencing generation on r4_now().
--   wake / human_expiry / action_retry:  pending → claimed → fired | cancelled
--   reconciliation:  pending → claimed → dispatched → in_progress (a worker,
--     under the same lease + generation) → pending (rescheduled) | completed | exhausted
--   An exhausted reconciliation returns to pending only by an operator request.
-- ---------------------------------------------------------------------------
create table schedules (
  schedule_id      uuid        primary key,
  task_id          uuid        not null references agent_tasks,
  kind             text        not null check (kind in ('wake','reconciliation','human_expiry','action_retry')),
  reference_id     uuid        not null,
  status           text        not null,
  due_at           timestamptz not null,
  deadline_at      timestamptz,
  -- Reconciliation policy, stamped by the scheduler that first claims it (explicit operator configuration).
  policy           jsonb       check (policy is null or jsonb_typeof(policy) = 'object'),
  attempts         integer     not null check (attempts >= 0),
  owner            text,
  generation       integer     not null check (generation >= 0),
  lease_expires_at timestamptz,
  created_at       timestamptz not null,
  updated_at       timestamptz not null,
  correlation_id   text        not null,
  unique (kind, reference_id),
  check ((kind = 'reconciliation' and status in ('pending','claimed','dispatched','in_progress','completed','exhausted')) or
         (kind <> 'reconciliation' and status in ('pending','claimed','fired','cancelled'))),
  check ((status in ('claimed','in_progress')) = (owner is not null)),
  check ((owner is null) = (lease_expires_at is null)),
  check (kind <> 'reconciliation' or status in ('pending','claimed') or (policy is not null and deadline_at is not null)),
  check ((policy is null) = (deadline_at is null))
);
create index schedules_due on schedules (due_at, schedule_id) where status in ('pending','claimed');
create index schedules_reconciliation_ready on schedules (updated_at, schedule_id) where kind = 'reconciliation' and status in ('dispatched','in_progress');
create index schedules_task_idx on schedules (task_id);

-- ---------------------------------------------------------------------------
-- Temporal evidence: every wait, wake, schedule, goal, human and
-- reconciliation transition. Human decisions carry the explicit text the
-- human gave; (entity, response_key) makes a replayed response idempotent.
-- ---------------------------------------------------------------------------
create table temporal_events (
  event_id       uuid        primary key,
  task_id        uuid        not null references agent_tasks,
  entity_id      uuid        not null,
  event_type     text        not null,
  occurred_at    timestamptz not null,
  correlation_id text        not null,
  actor_ref      text        not null,
  response_key   text,
  data           jsonb       not null check (jsonb_typeof(data) = 'object'),
  unique (entity_id, response_key)
);
create index temporal_events_task on temporal_events (task_id, occurred_at);
create trigger temporal_events_immutable before update or delete on temporal_events for each row execute function action_ledger_immutable();

-- ---------------------------------------------------------------------------
-- Canonical inbound input: idempotent by (task, source, external key). Its
-- text is the CONVERSATIONAL memory entry (the C2 ingestion seam).
-- ---------------------------------------------------------------------------
create table task_inputs (
  input_id        uuid        primary key,
  task_id         uuid        not null references agent_tasks,
  external_key    text        not null,
  source_ref      text        not null,
  actor_kind      text        not null,
  actor_ref       text        not null,
  request_hash    text        not null,
  memory_entry_id uuid        not null references memory_entries,
  received_at     timestamptz not null,
  correlation_id  text        not null,
  unique (task_id, source_ref, external_key)
);
create trigger task_inputs_immutable before update or delete on task_inputs for each row execute function action_ledger_immutable();

-- ---------------------------------------------------------------------------
-- Deferred terminal status. A task never becomes terminal while one of its
-- effects is uncertain: the requested terminal status (cancellation, or the
-- failure of an abandoned run) is recorded here and applied once
-- reconciliation establishes every outcome.
-- ---------------------------------------------------------------------------
create table task_terminal_intents (
  task_id        uuid        primary key references agent_tasks,
  target_status  text        not null check (target_status in ('cancelled','failed')),
  reason         text        not null check (reason ~ '^[a-z][a-z0-9_.]*$'),
  actor_kind     text        not null,
  actor_ref      text        not null,
  correlation_id text        not null,
  requested_at   timestamptz not null
);
create trigger task_terminal_intents_immutable before update or delete on task_terminal_intents for each row execute function action_ledger_immutable();

-- ---------------------------------------------------------------------------
-- Goals: append-only transition history; existing goals are backfilled.
-- ---------------------------------------------------------------------------
create table goal_transitions (
  transition_id  uuid        primary key default gen_random_uuid(),
  task_id        uuid        not null references agent_tasks,
  goal_id        uuid        not null references goals,
  kind           text        not null check (kind in ('baseline','created','focused','achieved','abandoned','superseded')),
  goal_version   integer     not null,
  task_version   integer,
  occurred_at    timestamptz not null,
  correlation_id text        not null,
  state          jsonb       not null
);
create index goal_transitions_task_idx on goal_transitions (task_id, occurred_at);
insert into goal_transitions (task_id, goal_id, kind, goal_version, occurred_at, correlation_id, state)
  select task_id, goal_id, 'baseline', version, clock_timestamp(), correlation_id, to_jsonb(g) from goals g;
create trigger goal_transitions_immutable before update or delete on goal_transitions for each row execute function action_ledger_immutable();

create function goals_history_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'goals are never deleted' using errcode = '55000'; end if;
  if tg_op = 'UPDATE' then
    if old.status <> 'active' or new.status = 'active' or
      (to_jsonb(new) - 'status' - 'version' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'version' - 'updated_at') then
      raise exception 'goal transitions only close an active goal' using errcode = '55000';
    end if;
  end if;
  insert into goal_transitions (task_id, goal_id, kind, goal_version, occurred_at, correlation_id, state)
    values (new.task_id, new.goal_id, case when tg_op = 'INSERT' then 'created' else new.status end, new.version, clock_timestamp(), new.correlation_id, to_jsonb(new));
  return new;
end; $$;
create trigger goals_history after insert or update on goals for each row execute function goals_history_guard();
create trigger goals_no_delete before delete on goals for each row execute function goals_history_guard();

-- ---------------------------------------------------------------------------
-- Task guard: no autonomous execution while a human owns the task or a wait
-- is open; no terminal status while an effect is uncertain; focus history.
-- ---------------------------------------------------------------------------
create function task_temporal_guard() returns trigger language plpgsql as $$
begin
  if new.status = 'running' and old.status <> 'running' and (
    exists (select 1 from human_requests where task_id = new.task_id and kind = 'handoff' and status in ('requested','active')) or
    exists (select 1 from task_waits where task_id = new.task_id and status = 'waiting')) then
    raise exception 'task has an active human owner or an open wait' using errcode = '55000';
  end if;
  if new.status = 'running' and new.lease_owner is not null and old.lease_owner is distinct from new.lease_owner and
    exists (select 1 from human_requests where task_id = new.task_id and kind = 'handoff' and status in ('requested','active')) then
    raise exception 'a human owns the task: no autonomous claim' using errcode = '55000';
  end if;
  if new.status in ('completed','failed','cancelled') and old.status <> new.status and
    exists (select 1 from action_executions where task_id = new.task_id and status in ('executing','needs_reconciliation')) then
    raise exception 'task has an effect whose outcome is not established' using errcode = '55000';
  end if;
  if new.current_goal_id is distinct from old.current_goal_id then
    insert into goal_transitions (task_id, goal_id, kind, goal_version, task_version, occurred_at, correlation_id, state)
      select new.task_id, g.goal_id, 'focused', g.version, new.version, clock_timestamp(), new.correlation_id, to_jsonb(g)
      from goals g where g.goal_id = new.current_goal_id;
  end if;
  return new;
end; $$;
create trigger task_temporal_guard before update on agent_tasks for each row execute function task_temporal_guard();

create function temporal_projection_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'temporal records are retained' using errcode = '55000'; end if;
  if tg_table_name = 'task_waits' and (old.status <> 'waiting' or
    (to_jsonb(new) - 'status' - 'completed_at' - 'resolution') is distinct from (to_jsonb(old) - 'status' - 'completed_at' - 'resolution')) then
    raise exception 'wait is immutable except its terminal transition' using errcode = '55000';
  end if;
  if tg_table_name = 'human_requests' and (
    (to_jsonb(new) - 'status' - 'human_ref' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'human_ref' - 'updated_at') or
    not ((old.status = 'requested' and new.status in ('answered','approved','rejected','active','cancelled','expired')) or
         (old.status = 'active' and new.status = 'released'))) then
    raise exception 'invalid human lifecycle transition' using errcode = '55000';
  end if;
  return new;
end; $$;
create trigger task_waits_guard before update or delete on task_waits for each row execute function temporal_projection_guard();
create trigger human_requests_guard before update or delete on human_requests for each row execute function temporal_projection_guard();

-- ---------------------------------------------------------------------------
-- Reconciliation work is born with the uncertainty, whatever produced it
-- (an unknown attempt outcome, a run that ended mid-call, an abandoned run,
-- a cancellation during an in-flight action), in the same transaction.
-- A deferred check makes "needs_reconciliation without durable work"
-- unrepresentable at commit.
-- ---------------------------------------------------------------------------
create function action_executions_schedule_reconciliation() returns trigger language plpgsql as $$
begin
  if new.status = 'needs_reconciliation' and (tg_op = 'INSERT' or old.status is distinct from 'needs_reconciliation') then
    insert into schedules (schedule_id, task_id, kind, reference_id, status, due_at, deadline_at, policy, attempts, owner, generation, lease_expires_at, created_at, updated_at, correlation_id)
      values (gen_random_uuid(), new.task_id, 'reconciliation', new.execution_id, 'pending', r4_now(), null, null, 0, null, 0, null, r4_now(), r4_now(), new.correlation_id)
      on conflict (kind, reference_id) do nothing;
  end if;
  return null;
end; $$;
create trigger action_executions_schedule_reconciliation after insert or update of status on action_executions
  for each row execute function action_executions_schedule_reconciliation();

create function action_executions_uncertain_has_work() returns trigger language plpgsql as $$
begin
  if new.status = 'needs_reconciliation' and not exists (
       select 1 from schedules s where s.kind = 'reconciliation' and s.reference_id = new.execution_id) then
    raise exception 'uncertain execution % has no reconciliation work', new.execution_id using errcode = '23514';
  end if;
  return null;
end; $$;
create constraint trigger action_executions_uncertain_has_work after insert or update on action_executions
  deferrable initially deferred for each row execute function action_executions_uncertain_has_work();

-- Uncertainty that predates R4-E gets its durable work now.
insert into schedules (schedule_id, task_id, kind, reference_id, status, due_at, deadline_at, policy, attempts, owner, generation, lease_expires_at, created_at, updated_at, correlation_id)
  select gen_random_uuid(), e.task_id, 'reconciliation', e.execution_id, 'pending', r4_now(), null, null, 0, null, 0, null, r4_now(), r4_now(), e.correlation_id
    from action_executions e where e.status = 'needs_reconciliation'
  on conflict (kind, reference_id) do nothing;

-- ---------------------------------------------------------------------------
-- Action ledger: a proposal may be evaluated again after a human approval
-- (a new decision — the REQUIRE_APPROVAL one stays), and observed again for
-- that re-evaluation or for the human outcome. Each piece of evidence keys
-- its own observation: receipt, approval request, policy decision, proposal.
-- ---------------------------------------------------------------------------
alter table policy_decisions drop constraint policy_decisions_proposal_id_key;
create index policy_decisions_proposal_idx on policy_decisions (proposal_id, evaluated_at);
create unique index policy_decisions_one_allow on policy_decisions (proposal_id) where outcome = 'allow';
alter table observations drop constraint observations_proposal_id_key;
create index observations_proposal_idx on observations (proposal_id) where proposal_id is not null;
alter table observations add column approval_request_id uuid unique references human_requests (request_id);
alter table observations add constraint observations_approval_is_action check (approval_request_id is null or (source_kind = 'action' and receipt_id is null));
alter table observations add column action_evidence_key text generated always as
  (coalesce(receipt_id::text, approval_request_id::text, policy_decision_id::text, proposal_id::text)) stored unique;
