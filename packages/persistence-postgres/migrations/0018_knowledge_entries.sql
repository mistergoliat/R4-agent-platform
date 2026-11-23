-- ADR-052: a curated knowledge base. Operators propose, verify, sign and retire short statements with their source.
-- NO agent reads this table: consuming it is a future agent-definition version with its own evaluation and owner
-- authorization.
--
-- `knowledge_entries` holds the CURRENT state of each entry; `knowledge_entry_events` keeps every change (creation
-- included), append-only (same immutability trigger as the other ledgers). Both are written in one transaction.
--
-- Additive: two new tables, no change to existing ones. Rollback of the code does not require removing them.
create table knowledge_entries (
  entry_id    uuid        primary key,
  topic       text        not null check (length(topic) between 1 and 120),
  statement   text        not null check (length(statement) between 1 and 2000),
  source      text        not null check (length(source) between 1 and 300),
  source_ref  text        check (source_ref is null or length(source_ref) between 1 and 300),
  state       text        not null check (state in ('proposed', 'verified', 'signed', 'retired')),
  created_by  text        not null,
  created_at  timestamptz not null,
  verified_by text,
  verified_at timestamptz,
  signed_by   text,
  signed_at   timestamptz,
  retired_by  text,
  retired_at  timestamptz,
  expires_at  date,
  check ((verified_by is null) = (verified_at is null)),
  check ((signed_by is null) = (signed_at is null)),
  check ((retired_by is null) = (retired_at is null)),
  check (signed_at is null or verified_at is not null),
  check ((state = 'retired') = (retired_at is not null))
);
create index knowledge_entries_created on knowledge_entries (created_at desc);

create table knowledge_entry_events (
  event_id       uuid        primary key default gen_random_uuid(),
  entry_id       uuid        not null references knowledge_entries (entry_id),
  from_state     text        check (from_state in ('proposed', 'verified', 'signed')),
  to_state       text        not null check (to_state in ('proposed', 'verified', 'signed', 'retired')),
  note           text        check (note is null or length(note) between 1 and 500),
  decided_by     text        not null,
  decided_at     timestamptz not null,
  correlation_id text        not null,
  check ((from_state is null) = (to_state = 'proposed'))
);
create index knowledge_entry_events_entry on knowledge_entry_events (entry_id, decided_at);
create trigger knowledge_entry_events_immutable before update or delete on knowledge_entry_events for each row execute function action_ledger_immutable();
