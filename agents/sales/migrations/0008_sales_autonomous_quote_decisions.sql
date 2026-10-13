-- R4-J3E autonomous quote decisions (Sales-owned, schema `sales`).
--
-- Pack state only: nothing here references an R4 runtime table or the Quote
-- owner's database. One row per platform execution key of quote.create@3:
-- what the Sales pack decided, autonomously and deterministically, before
-- any request left R4 — the exact commercial snapshot it recomputed from the
-- owners, the configured limits and the values it measured against them, the
-- customer's quote request it relied on, and the outcome. An `authorized`
-- row is written in the same transaction that freezes the Quote V2 request
-- (0007), so no request is ever sent without its decision.
--
-- The Policy Engine's own decision (policy id, version, hash, reason
-- `autonomous`) stays in the platform's governed-execution records; this is
-- the commercial half of the audit trail.
create table sales.quote_autonomous_decisions (
  execution_key  text primary key check (length(execution_key) between 1 and 200),
  task_id        uuid not null,
  preview_id     text not null check (preview_id ~ '^[0-9a-f]{64}$'),
  outcome        text not null check (outcome in ('authorized', 'rejected')),
  reason_code    text not null check (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  snapshot       jsonb check (snapshot is null or jsonb_typeof(snapshot) = 'object'),
  limits         jsonb not null check (jsonb_typeof(limits) = 'object'),
  measurements   jsonb not null check (jsonb_typeof(measurements) = 'object'),
  quote_request  jsonb check (quote_request is null or jsonb_typeof(quote_request) = 'object'),
  decided_at     timestamptz not null default clock_timestamp(),
  check ((outcome = 'authorized') = (reason_code = 'eligible')),
  check (outcome <> 'authorized' or (snapshot is not null and quote_request is not null))
);
-- At most one authorized decision per (conversation task, commercial snapshot): a second autonomous
-- issuance of the same snapshot is refused by the database itself, whatever the execution key.
create unique index sales_quote_autonomous_one_per_snapshot on sales.quote_autonomous_decisions (task_id, preview_id) where outcome = 'authorized';
create index sales_quote_autonomous_authorized_at on sales.quote_autonomous_decisions (decided_at) where outcome = 'authorized';

create trigger sales_quote_autonomous_decisions_immutable before update or delete on sales.quote_autonomous_decisions
  for each row execute function sales.forbid_mutation();
