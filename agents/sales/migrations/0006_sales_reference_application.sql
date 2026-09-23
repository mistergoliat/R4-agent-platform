-- R4-F Sales Reference Application: Sales-owned application state.
--
-- Everything lives in its own schema, owned by the Sales agent pack — not by
-- R4 Core. Nothing here references R4 runtime tables: a task id is an opaque
-- reference handed to Sales capabilities by the platform's trusted context.
-- None of these tables is a source of domain truth: prices, stock, shipping
-- costs and quote totals stay with their owners and reach the agent only as
-- observations.

create schema if not exists sales;

-- Who a Sales conversation acts for, as the Sales ingress (channel adapter or
-- harness) established it. Never written from model output. A null
-- customer_ref means the customer is anonymous (identity unavailable).
create table sales.conversations (
  task_id      uuid primary key,
  customer_ref text null check (customer_ref is null or length(customer_ref) between 1 and 256),
  channel_ref  text not null check (length(channel_ref) between 1 and 256),
  created_at   timestamptz not null default clock_timestamp()
);

-- The current structured working state of one conversation: stated facts
-- (constraints, preferences), delivery destination and selected items.
-- Versioned: every applied command increments `version` exactly by one.
create table sales.workspaces (
  task_id    uuid primary key,
  version    integer not null check (version >= 1),
  state      jsonb not null check (jsonb_typeof(state) = 'object'),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

-- Audit trail and idempotency record: one row per governed workspace command
-- (the platform execution key), applied or rejected. Immutable.
create table sales.workspace_transitions (
  execution_key text primary key check (length(execution_key) between 1 and 256),
  task_id       uuid not null,
  outcome       text not null check (outcome in ('applied', 'rejected')),
  from_version  integer not null check (from_version >= 0),
  to_version    integer not null,
  operations    jsonb not null check (jsonb_typeof(operations) = 'array'),
  changes       jsonb not null check (jsonb_typeof(changes) = 'array'),
  result        jsonb not null check (jsonb_typeof(result) = 'object'),
  recorded_at   timestamptz not null default clock_timestamp(),
  check ((outcome = 'applied' and to_version = from_version + 1) or (outcome = 'rejected' and to_version = from_version))
);
create unique index sales_workspace_transitions_one_per_version on sales.workspace_transitions (task_id, to_version) where outcome = 'applied';
create index sales_workspace_transitions_by_task on sales.workspace_transitions (task_id, recorded_at);

-- What the quote capability asked the Quote owner for, recorded before the
-- first call under the platform execution key: the selection and destination
-- taken from one workspace version (no prices). Replays and reconciliation of
-- the same command reuse exactly this request.
create table sales.quote_requests (
  execution_key     text primary key check (length(execution_key) between 1 and 256),
  task_id           uuid not null,
  workspace_version integer not null check (workspace_version >= 1),
  selection         jsonb not null check (jsonb_typeof(selection) = 'array'),
  delivery          jsonb not null check (jsonb_typeof(delivery) = 'object'),
  requested_at      timestamptz not null default clock_timestamp()
);

-- A pointer to a quote its owner issued for such a request, recorded only
-- from the Quote owner's own answer (never from model output). Identity,
-- number, totals and validity remain the owner's.
create table sales.quote_references (
  execution_key text primary key references sales.quote_requests (execution_key),
  task_id       uuid not null,
  quote_id      text not null check (length(quote_id) between 1 and 128),
  quote_number  text not null check (length(quote_number) between 1 and 128),
  recorded_at   timestamptz not null default clock_timestamp()
);
create index sales_quote_references_by_task on sales.quote_references (task_id, recorded_at);

create function sales.forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'check_violation';
end $$;

create trigger sales_workspace_transitions_immutable before update or delete on sales.workspace_transitions
  for each row execute function sales.forbid_mutation();
create trigger sales_quote_requests_immutable before update or delete on sales.quote_requests
  for each row execute function sales.forbid_mutation();
create trigger sales_quote_references_immutable before update or delete on sales.quote_references
  for each row execute function sales.forbid_mutation();
create trigger sales_conversations_immutable before update or delete on sales.conversations
  for each row execute function sales.forbid_mutation();
