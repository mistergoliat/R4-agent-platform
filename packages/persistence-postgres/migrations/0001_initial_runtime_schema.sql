-- R4-B initial runtime schema.
-- PostgreSQL is authoritative for runtime state. JSONB is used only for
-- genuinely extensible documents (task input/constraints/result, agent config
-- sub-documents, observation payload/provenance); everything the platform
-- enforces or queries is a typed column with constraints.

-- ---------------------------------------------------------------------------
-- Agent definitions: immutable per (agent_id, version). Content-hashed so an
-- edited file for an already-registered version is detected and refused.
-- ---------------------------------------------------------------------------
create table agent_definitions (
  agent_id            text        not null check (agent_id ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and length(agent_id) <= 64),
  version             integer     not null check (version > 0),
  schema_version      integer     not null check (schema_version = 1),
  display_name        text        not null,
  description         text        not null,
  instructions        text        not null,
  task_types          text[]      not null check (cardinality(task_types) > 0),
  capability_scopes   text[]      not null,
  skills              text[]      not null,
  model_requirements  jsonb       not null,
  context_policy      jsonb       not null,
  budgets             jsonb       not null,
  delegation_policy   jsonb       not null,
  evaluation_profile  jsonb,
  content_hash        text        not null check (content_hash ~ '^[0-9a-f]{64}$'),
  registered_at       timestamptz not null,
  primary key (agent_id, version)
);

-- ---------------------------------------------------------------------------
-- Tasks: the durable unit of work.
-- ---------------------------------------------------------------------------
create table agent_tasks (
  task_id                  uuid        primary key,
  task_type                text        not null,
  agent_id                 text        not null,
  agent_version            integer     not null,
  status                   text        not null check (status in (
                             'pending', 'running', 'waiting', 'blocked',
                             'requires_approval', 'completed', 'failed', 'cancelled')),
  status_reason            text,
  parent_task_id           uuid        references agent_tasks (task_id),
  root_goal_id             uuid        not null,
  current_goal_id          uuid        not null,
  requested_by_kind        text        not null check (requested_by_kind in ('user', 'service', 'agent', 'system', 'unauthenticated')),
  requested_by_ref         text        not null,
  input                    jsonb       not null default '{}'::jsonb check (jsonb_typeof(input) = 'object'),
  constraints              jsonb       not null default '{}'::jsonb check (jsonb_typeof(constraints) = 'object'),
  budget                   jsonb       not null default '{}'::jsonb check (jsonb_typeof(budget) = 'object'),
  result                   jsonb       check (result is null or jsonb_typeof(result) = 'object'),
  deadline_at              timestamptz,
  idempotency_key          text,
  idempotency_request_hash text,
  correlation_id           text        not null,
  version                  integer     not null check (version > 0),
  created_at               timestamptz not null,
  updated_at               timestamptz not null,
  foreign key (agent_id, agent_version) references agent_definitions (agent_id, version),
  check ((idempotency_key is null) = (idempotency_request_hash is null)),
  check (updated_at >= created_at)
);

-- Idempotent creation is scoped per requesting principal.
create unique index agent_tasks_idempotency_uq
  on agent_tasks (requested_by_ref, idempotency_key)
  where idempotency_key is not null;
-- Supports future scheduler / recovery scans (e.g. stale running tasks).
create index agent_tasks_status_updated_idx on agent_tasks (status, updated_at);
create index agent_tasks_parent_idx on agent_tasks (parent_task_id) where parent_task_id is not null;
create index agent_tasks_correlation_idx on agent_tasks (correlation_id);

-- Append-only transition history: enough to reconstruct every status change.
create table agent_task_transitions (
  transition_id  uuid        primary key,
  task_id        uuid        not null references agent_tasks (task_id),
  from_status    text,
  to_status      text        not null,
  reason         text,
  actor_kind     text        not null,
  actor_ref      text        not null,
  task_version   integer     not null check (task_version > 0),
  correlation_id text        not null,
  occurred_at    timestamptz not null,
  unique (task_id, task_version)
);

-- ---------------------------------------------------------------------------
-- Goals: cognitive state (not business truth). One root per task; subgoals
-- reference a parent in the same task (enforced by the composite FK).
-- ---------------------------------------------------------------------------
create table goals (
  goal_id          uuid        primary key,
  task_id          uuid        not null references agent_tasks (task_id),
  parent_goal_id   uuid,
  description      text        not null check (length(description) between 1 and 4000),
  success_criteria text[]      not null,
  status           text        not null check (status in ('active', 'achieved', 'abandoned', 'superseded')),
  origin           text        not null check (origin in ('requester', 'agent')),
  correlation_id   text        not null,
  version          integer     not null check (version > 0),
  created_at       timestamptz not null,
  updated_at       timestamptz not null,
  unique (task_id, goal_id),
  foreign key (task_id, parent_goal_id) references goals (task_id, goal_id),
  check (parent_goal_id is null or parent_goal_id <> goal_id)
);
create unique index goals_one_root_per_task on goals (task_id) where parent_goal_id is null;

-- Root and current goal must be goals of the same task. Deferred so a task
-- and its root goal can be inserted in one transaction.
alter table agent_tasks
  add constraint agent_tasks_root_goal_fk
    foreign key (task_id, root_goal_id) references goals (task_id, goal_id)
    deferrable initially deferred,
  add constraint agent_tasks_current_goal_fk
    foreign key (task_id, current_goal_id) references goals (task_id, goal_id)
    deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- Runs: bounded cognitive executions of a task. At most one active per task.
-- ---------------------------------------------------------------------------
create table agent_runs (
  run_id               uuid        primary key,
  task_id              uuid        not null references agent_tasks (task_id),
  sequence             integer     not null check (sequence > 0),
  agent_id             text        not null,
  agent_version        integer     not null,
  status               text        not null check (status in ('running', 'completed', 'failed', 'cancelled')),
  context_snapshot_ref text,
  model_calls          integer     not null default 0 check (model_calls >= 0),
  input_tokens         integer     not null default 0 check (input_tokens >= 0),
  output_tokens        integer     not null default 0 check (output_tokens >= 0),
  capability_calls     integer     not null default 0 check (capability_calls >= 0),
  result               jsonb       check (result is null or jsonb_typeof(result) = 'object'),
  failure_code         text,
  failure_message      text,
  correlation_id       text        not null,
  version              integer     not null check (version > 0),
  started_at           timestamptz not null,
  finished_at          timestamptz,
  created_at           timestamptz not null,
  updated_at           timestamptz not null,
  unique (task_id, sequence),
  foreign key (agent_id, agent_version) references agent_definitions (agent_id, version),
  check ((status = 'running') = (finished_at is null)),
  check ((status = 'failed') = (failure_code is not null))
);
create unique index agent_runs_one_active_per_task on agent_runs (task_id) where status = 'running';

-- ---------------------------------------------------------------------------
-- Observations: immutable evidence obtained outside the model. Unique per
-- invocation so a replayed invocation never records twice.
-- ---------------------------------------------------------------------------
create table observations (
  observation_id     uuid        primary key,
  task_id            uuid        not null references agent_tasks (task_id),
  run_id             uuid        references agent_runs (run_id),
  agent_id           text        not null,
  source_kind        text        not null check (source_kind in ('capability')),
  capability_id      text        not null,
  capability_version integer,
  invocation_id      uuid        not null unique,
  outcome            text        not null check (outcome in ('succeeded', 'rejected', 'failed')),
  payload            jsonb,
  error_code         text,
  error_message      text,
  error_details      jsonb,
  observed_at        timestamptz not null,
  valid_until        timestamptz,
  provenance         jsonb       not null check (jsonb_typeof(provenance) = 'object'),
  correlation_id     text        not null,
  created_at         timestamptz not null default now(),
  check ((outcome = 'succeeded') = (error_code is null))
);
create index observations_task_idx on observations (task_id, observed_at);
create index observations_run_idx on observations (run_id) where run_id is not null;
