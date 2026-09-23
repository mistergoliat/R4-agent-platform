-- R4-C1 execution kernel: task leases (ownership + fencing), run termination,
-- and the durable per-iteration step log. Append-only: 0001 is not modified.

-- ---------------------------------------------------------------------------
-- Leases live on the task row. The task row lock is therefore the single
-- serialization point for claiming, takeover and every owner-only write.
-- lease_generation is the fencing token: it increases on every claim and is
-- never reset. Expiry is always evaluated against the database clock.
-- A lease is ownership, not lifecycle: it never touches version/updated_at.
-- ---------------------------------------------------------------------------
alter table agent_tasks
  add column lease_owner       text        check (lease_owner is null or lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  add column lease_generation  integer     not null default 0 check (lease_generation >= 0),
  add column lease_acquired_at timestamptz,
  add column lease_expires_at  timestamptz,
  add column last_heartbeat_at timestamptz,
  add constraint agent_tasks_lease_consistency check (
    (lease_owner is null) = (lease_expires_at is null)
    and (lease_owner is null or (lease_generation > 0 and lease_acquired_at is not null and last_heartbeat_at is not null))
  );

-- Claim scan: runnable tasks, oldest first.
create index agent_tasks_claimable_idx on agent_tasks (created_at, task_id)
  where status in ('pending', 'running');

-- ---------------------------------------------------------------------------
-- Runs: `abandoned` status, structured termination, takeover counter.
-- ---------------------------------------------------------------------------
alter table agent_runs drop constraint agent_runs_status_check;
alter table agent_runs
  add constraint agent_runs_status_check
    check (status in ('running', 'completed', 'failed', 'cancelled', 'abandoned')),
  add column termination_reason  text check (termination_reason in (
                                   'completed', 'model_failure', 'invalid_decision', 'capability_failure',
                                   'budget_exhausted', 'lease_lost', 'cancelled', 'internal_failure')),
  add column termination_code    text,
  add column termination_message text,
  add column termination_details jsonb,
  add column recoveries          integer not null default 0 check (recoveries >= 0);

-- R4-B runs finished before termination reasons existed. R4-B had no executor,
-- so a failed run's cause is unknown to the platform: classified as internal.
update agent_runs
   set termination_reason  = case status when 'completed' then 'completed'
                                         when 'cancelled' then 'cancelled'
                                         else 'internal_failure' end,
       termination_code    = coalesce(failure_code, status),
       termination_message = coalesce(failure_message, '')
 where status <> 'running';

alter table agent_runs
  add constraint agent_runs_termination_present
    check ((status = 'running') = (termination_reason is null)),
  add constraint agent_runs_termination_fields
    check ((termination_reason is null) = (termination_code is null)
       and (termination_reason is null) = (termination_message is null)),
  add constraint agent_runs_termination_matches_status
    check (termination_reason is null
       or ((status = 'completed') = (termination_reason = 'completed')
       and (status = 'cancelled') = (termination_reason = 'cancelled')
       and (status = 'abandoned') = (termination_reason = 'lease_lost')));

-- ---------------------------------------------------------------------------
-- Run steps: one row per kernel iteration. Unique (run, iteration) and unique
-- invocation id make a duplicated iteration or invocation impossible even if
-- fencing were bypassed.
-- ---------------------------------------------------------------------------
create table agent_run_steps (
  step_id          uuid        primary key,
  run_id           uuid        not null references agent_runs (run_id),
  task_id          uuid        not null references agent_tasks (task_id),
  iteration        integer     not null check (iteration > 0),
  lease_generation integer     not null check (lease_generation > 0),
  decision_type    text        check (decision_type in ('read_capability', 'respond', 'complete')),
  decision         jsonb       check (decision is null or jsonb_typeof(decision) = 'object'),
  outcome          text        not null check (outcome in ('pending', 'observed', 'recorded', 'refused', 'invalid', 'model_failed')),
  error_code       text,
  error_message    text,
  invocation_id    uuid        unique,
  observation_id   uuid        unique references observations (observation_id),
  input_tokens     integer     not null default 0 check (input_tokens >= 0),
  output_tokens    integer     not null default 0 check (output_tokens >= 0),
  correlation_id   text        not null,
  created_at       timestamptz not null,
  completed_at     timestamptz,
  unique (run_id, iteration),
  check ((decision_type is null) = (decision is null)),
  check ((decision is not null) = (outcome in ('pending', 'observed', 'recorded', 'refused'))),
  check ((error_code is not null) = (outcome in ('refused', 'invalid', 'model_failed'))),
  check ((invocation_id is not null) = coalesce(decision_type = 'read_capability' and outcome in ('pending', 'observed'), false)),
  check ((observation_id is not null) = (outcome = 'observed')),
  check ((completed_at is null) = (outcome = 'pending'))
);
create index agent_run_steps_task_idx on agent_run_steps (task_id);
-- At most one READ awaiting its observation per run: the loop is sequential.
create unique index agent_run_steps_one_pending_per_run on agent_run_steps (run_id) where outcome = 'pending';
