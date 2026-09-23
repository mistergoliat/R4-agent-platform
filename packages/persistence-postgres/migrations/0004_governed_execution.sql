-- R4-D governed execution: action proposals, policy decisions, action
-- executions (commands), append-only attempts and immutable receipts, plus
-- the run/step/observation extensions they need. Append-only: 0001-0003 are
-- not modified.
--
-- Invariants enforced here, not only in code:
-- - an execution exists only for an ALLOW decision (composite FK);
-- - a command (key, arguments, trusted context, semantics) never changes;
-- - an execution is succeeded/rejected/failed only together with the receipt
--   that proves it (deferred constraint trigger);
-- - proposals, decisions, receipts and observations are immutable; an
--   attempt's outcome is recorded once and never rewritten;
-- - an action observation reports success only with a receipt.

-- ---------------------------------------------------------------------------
-- Runs: `suspended` (the task waits for an approval or for the resolution of
-- an unknown action outcome) and its two termination reasons.
-- ---------------------------------------------------------------------------
alter table agent_runs drop constraint agent_runs_status_check;
alter table agent_runs add constraint agent_runs_status_check
  check (status in ('running', 'completed', 'failed', 'cancelled', 'abandoned', 'suspended'));
alter table agent_runs drop constraint agent_runs_termination_reason_check;
alter table agent_runs add constraint agent_runs_termination_reason_check
  check (termination_reason in (
    'completed', 'model_failure', 'invalid_decision', 'capability_failure',
    'budget_exhausted', 'lease_lost', 'cancelled', 'internal_failure',
    'approval_required', 'write_outcome_uncertain'));
alter table agent_runs drop constraint agent_runs_termination_matches_status;
alter table agent_runs add constraint agent_runs_termination_matches_status
  check (termination_reason is null
     or ((status = 'completed') = (termination_reason = 'completed')
     and (status = 'cancelled') = (termination_reason = 'cancelled')
     and (status = 'abandoned') = (termination_reason = 'lease_lost')
     and (status = 'suspended') = (termination_reason in ('approval_required', 'write_outcome_uncertain'))));

-- ---------------------------------------------------------------------------
-- Action proposals: intent, recorded with the step that decided it and
-- before anything is authorized or executed. Immutable.
-- ---------------------------------------------------------------------------
alter table agent_run_steps drop constraint agent_run_steps_decision_type_check;
alter table agent_run_steps add constraint agent_run_steps_decision_type_check
  check (decision_type in ('read_capability', 'respond', 'complete', 'propose_action'));

create table action_proposals (
  proposal_id         uuid        primary key,
  task_id             uuid        not null references agent_tasks (task_id),
  run_id              uuid        not null references agent_runs (run_id),
  step_id             uuid        not null unique references agent_run_steps (step_id),
  iteration           integer     not null check (iteration > 0),
  agent_id            text        not null,
  agent_version       integer     not null,
  capability_id       text        not null check (length(capability_id) between 1 and 256),
  arguments           jsonb       not null check (jsonb_typeof(arguments) = 'object'),
  evidence_refs       uuid[]      not null default '{}',
  context_snapshot_id uuid        references context_snapshots (snapshot_id),
  lease_generation    integer     not null check (lease_generation > 0),
  correlation_id      text        not null,
  created_at          timestamptz not null,
  foreign key (agent_id, agent_version) references agent_definitions (agent_id, version),
  check (cardinality(evidence_refs) <= 100)
);
create index action_proposals_task_idx on action_proposals (task_id, created_at);

alter table agent_run_steps
  add column proposal_id uuid unique,
  -- Deferred: the step and its proposal are inserted in one transaction.
  add constraint agent_run_steps_proposal_fk
    foreign key (proposal_id) references action_proposals (proposal_id) deferrable initially deferred,
  add constraint agent_run_steps_proposal_consistency
    check ((proposal_id is not null) = coalesce(decision_type = 'propose_action' and outcome in ('pending', 'observed'), false));

-- ---------------------------------------------------------------------------
-- Policy decisions: which policy (id, version, hash, engine) decided what,
-- for which agent/task/capability/risk class, and why. Immutable.
-- ---------------------------------------------------------------------------
create table policy_decisions (
  decision_id        uuid        primary key,
  proposal_id        uuid        not null unique references action_proposals (proposal_id),
  task_id            uuid        not null references agent_tasks (task_id),
  run_id             uuid        not null references agent_runs (run_id),
  agent_id           text        not null,
  agent_version      integer     not null,
  capability_id      text        not null,
  capability_version integer     not null check (capability_version > 0),
  risk_class         text        not null check (risk_class in ('READ', 'REVERSIBLE_WRITE', 'IRREVERSIBLE_WRITE', 'FINANCIAL', 'EXTERNAL_COMMUNICATION', 'PRIVILEGED')),
  outcome            text        not null check (outcome in ('allow', 'deny', 'require_approval')),
  reason_code        text        not null check (reason_code ~ '^[a-z][a-z0-9_.]*$'),
  rule               text        not null,
  message            text        not null,
  policy_id          text        not null,
  policy_version     integer     not null check (policy_version > 0),
  policy_hash        text        not null check (policy_hash ~ '^[0-9a-f]{64}$'),
  engine_version     text        not null,
  identity_assurance text        not null check (identity_assurance in ('none', 'provisional', 'verified')),
  lease_generation   integer     not null check (lease_generation > 0),
  correlation_id     text        not null,
  evaluated_at       timestamptz not null,
  -- Target of the composite FK that restricts executions to ALLOW decisions.
  unique (decision_id, outcome),
  foreign key (agent_id, agent_version) references agent_definitions (agent_id, version)
);
create index policy_decisions_task_idx on policy_decisions (task_id);
create index policy_decisions_outcome_idx on policy_decisions (outcome, risk_class);

-- ---------------------------------------------------------------------------
-- Action executions: the command (immutable) and its operational status.
-- ---------------------------------------------------------------------------
create table action_executions (
  execution_id        uuid        primary key,
  proposal_id         uuid        not null unique references action_proposals (proposal_id),
  policy_decision_id  uuid        not null unique,
  policy_outcome      text        not null default 'allow' check (policy_outcome = 'allow'),
  task_id             uuid        not null references agent_tasks (task_id),
  run_id              uuid        not null references agent_runs (run_id),
  capability_id       text        not null,
  capability_version  integer     not null check (capability_version > 0),
  risk_class          text        not null check (risk_class in ('REVERSIBLE_WRITE', 'IRREVERSIBLE_WRITE', 'FINANCIAL', 'EXTERNAL_COMMUNICATION', 'PRIVILEGED')),
  execution_key       text        not null unique check (execution_key ~ '^r4x_[0-9a-f]{32}$'),
  recovery_strategy   text        not null check (recovery_strategy in ('idempotent_replay', 'reconcile_before_retry')),
  reconcile_supported boolean     not null,
  max_attempts        integer     not null check (max_attempts between 1 and 10),
  initial_backoff_ms  integer     not null check (initial_backoff_ms between 0 and 60000),
  validated_arguments jsonb       not null check (jsonb_typeof(validated_arguments) = 'object'),
  trusted_context     jsonb       not null check (jsonb_typeof(trusted_context) = 'object'),
  status              text        not null check (status in ('prepared', 'executing', 'succeeded', 'rejected', 'failed', 'needs_reconciliation')),
  version             integer     not null check (version > 0),
  correlation_id      text        not null,
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  -- No command without an ALLOW decision.
  foreign key (policy_decision_id, policy_outcome) references policy_decisions (decision_id, outcome),
  unique (execution_id, execution_key),
  check (recovery_strategy <> 'reconcile_before_retry' or reconcile_supported),
  check (updated_at >= created_at)
);
create index action_executions_task_idx on action_executions (task_id);
create index action_executions_run_open_idx on action_executions (run_id) where status in ('prepared', 'executing', 'needs_reconciliation');

create function action_executions_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'action executions are never deleted (%)', old.execution_id using errcode = '55000';
  end if;
  -- The command is immutable: only status, version and updated_at may change.
  if (to_jsonb(new) - 'status' - 'version' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'version' - 'updated_at') then
    raise exception 'action command % is immutable', old.execution_id using errcode = '55000';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'prepared' and new.status = 'executing')
    or (old.status = 'executing' and new.status in ('succeeded', 'rejected', 'failed', 'needs_reconciliation'))
    or (old.status = 'needs_reconciliation' and new.status in ('executing', 'succeeded', 'rejected', 'failed'))) then
    raise exception 'action execution % cannot go from % to %', old.execution_id, old.status, new.status using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger action_executions_guard
  before update or delete on action_executions
  for each row execute function action_executions_guard();

-- ---------------------------------------------------------------------------
-- Attempts: one row per external call, written BEFORE the call. The outcome
-- is recorded once (null = the call never reported back). Append-only.
-- ---------------------------------------------------------------------------
create table action_execution_attempts (
  attempt_id       uuid        primary key,
  execution_id     uuid        not null references action_executions (execution_id),
  attempt_number   integer     not null check (attempt_number > 0),
  kind             text        not null check (kind in ('execute', 'replay', 'reconcile')),
  worker_id        text        not null,
  lease_generation integer     not null check (lease_generation > 0),
  started_at       timestamptz not null,
  finished_at      timestamptz,
  outcome          text        check (outcome in ('applied', 'rejected', 'failed', 'not_applied', 'unknown')),
  error_code       text,
  detail           jsonb,
  unique (execution_id, attempt_number),
  check ((finished_at is null) = (outcome is null)),
  check (outcome is distinct from 'not_applied' or kind = 'reconcile'),
  check ((kind = 'execute') = (attempt_number = 1))
);

create function action_execution_attempts_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'action attempts are append-only (%)', old.attempt_id using errcode = '55000';
  end if;
  if old.outcome is not null
     or (to_jsonb(new) - 'finished_at' - 'outcome' - 'error_code' - 'detail') is distinct from (to_jsonb(old) - 'finished_at' - 'outcome' - 'error_code' - 'detail') then
    raise exception 'action attempt % is immutable (only its outcome may be recorded, once)', old.attempt_id using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger action_execution_attempts_append_only
  before update or delete on action_execution_attempts
  for each row execute function action_execution_attempts_append_only();

-- ---------------------------------------------------------------------------
-- Receipts: immutable evidence of the known outcome. One per execution; its
-- key must be the command's key.
-- ---------------------------------------------------------------------------
create table action_receipts (
  receipt_id             uuid        primary key,
  execution_id           uuid        not null unique,
  execution_key          text        not null unique,
  proposal_id            uuid        not null unique references action_proposals (proposal_id),
  task_id                uuid        not null references agent_tasks (task_id),
  run_id                 uuid        not null references agent_runs (run_id),
  capability_id          text        not null,
  capability_version     integer     not null check (capability_version > 0),
  status                 text        not null check (status in ('succeeded', 'rejected', 'failed')),
  resource_ref           text        check (length(resource_ref) between 1 and 512),
  external_operation_ref text        check (length(external_operation_ref) between 1 and 512),
  result                 jsonb,
  error_code             text,
  error_message          text,
  error_details          jsonb,
  obtained_via           text        not null check (obtained_via in ('execute', 'replay', 'reconcile')),
  attempt_id             uuid        not null unique references action_execution_attempts (attempt_id),
  attempt_number         integer     not null check (attempt_number > 0),
  attempts               integer     not null check (attempts >= attempt_number),
  replayed               boolean     not null,
  executed_at            timestamptz not null,
  recorded_at            timestamptz not null,
  correlation_id         text        not null,
  foreign key (execution_id, execution_key) references action_executions (execution_id, execution_key),
  check ((status = 'succeeded') = (error_code is null)),
  check (status = 'succeeded' or result is null)
);
create index action_receipts_task_idx on action_receipts (task_id);

create function action_ledger_immutable() returns trigger language plpgsql as $$
begin
  raise exception '% rows are immutable', tg_table_name using errcode = '55000';
end;
$$;
create trigger action_proposals_immutable
  before update or delete on action_proposals
  for each row execute function action_ledger_immutable();
create trigger policy_decisions_immutable
  before update or delete on policy_decisions
  for each row execute function action_ledger_immutable();
create trigger action_receipts_immutable
  before update or delete on action_receipts
  for each row execute function action_ledger_immutable();

-- A resolved status is only ever committed together with the receipt that
-- proves it (checked at commit, so status and receipt share a transaction).
create function action_executions_resolved_has_receipt() returns trigger language plpgsql as $$
begin
  if new.status in ('succeeded', 'rejected', 'failed') and not exists (
       select 1 from action_receipts r where r.execution_id = new.execution_id and r.status = new.status) then
    raise exception 'action execution % is % without a matching receipt', new.execution_id, new.status using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger action_executions_resolved_has_receipt
  after insert or update on action_executions
  deferrable initially deferred
  for each row execute function action_executions_resolved_has_receipt();

-- ---------------------------------------------------------------------------
-- Observations: action-sourced observations (validation rejection, policy
-- outcome, or receipt), and immutability for every observation.
-- ---------------------------------------------------------------------------
alter table observations drop constraint observations_source_kind_check;
alter table observations add constraint observations_source_kind_check
  check (source_kind in ('capability', 'action'));
alter table observations alter column invocation_id drop not null;
alter table observations
  add column proposal_id        uuid unique references action_proposals (proposal_id),
  add column policy_decision_id uuid references policy_decisions (decision_id),
  add column execution_id       uuid references action_executions (execution_id),
  add column receipt_id         uuid unique references action_receipts (receipt_id),
  add constraint observations_source_refs check (
        (source_kind = 'capability') = (invocation_id is not null)
    and (source_kind = 'action') = (proposal_id is not null)
    and (source_kind = 'action' or (policy_decision_id is null and execution_id is null and receipt_id is null))
    and (receipt_id is null or execution_id is not null)
    and (execution_id is null or policy_decision_id is not null)),
  -- The agent is never told a write succeeded without the receipt that proves it.
  add constraint observations_action_success_has_receipt
    check (source_kind <> 'action' or outcome <> 'succeeded' or receipt_id is not null);

create trigger observations_immutable
  before update or delete on observations
  for each row execute function action_ledger_immutable();
