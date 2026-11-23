-- ADR-051: the human decision on an incident group (signature). Incidents themselves are computed at read time from
-- existing tables (no occurrence table); only the triage is stored.
--
-- `incident_triage` holds the LATEST decision per signature (no row = open); `incident_triage_events` keeps every
-- decision, append-only (same immutability trigger as the other ledgers). Both are written in one transaction.
--
-- Additive: two new tables, no change to existing ones. Rollback of the code does not require removing them.
create table incident_triage (
  signature   text        primary key check (length(signature) between 1 and 300),
  state       text        not null check (state in ('ignored', 'requested')),
  note        text        not null check (length(note) between 1 and 1000),
  request_url text        check (request_url is null or request_url ~ '^https://'),
  decided_by  text        not null,
  decided_at  timestamptz not null,
  check (state <> 'requested' or request_url is not null)
);

create table incident_triage_events (
  event_id       uuid        primary key default gen_random_uuid(),
  signature      text        not null check (length(signature) between 1 and 300),
  state          text        not null check (state in ('ignored', 'requested')),
  note           text        not null check (length(note) between 1 and 1000),
  request_url    text        check (request_url is null or request_url ~ '^https://'),
  decided_by     text        not null,
  decided_at     timestamptz not null,
  correlation_id text        not null,
  check (state <> 'requested' or request_url is not null)
);
create index incident_triage_events_signature on incident_triage_events (signature, decided_at);
create trigger incident_triage_events_immutable before update or delete on incident_triage_events for each row execute function action_ledger_immutable();
