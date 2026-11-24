-- ADR-058 Decision 10: facts a person answered for an artifact kind (generic: Core stores the subject, the field and
-- the value as opaque text and never interprets them; the owning pack decides what they mean).
--
-- Append-only: a new value for the same kind, subject and field replaces the previous one without deleting it; the
-- current fact is the latest row. Every row keeps who answered, when, from where and its note.
create table artifact_facts (
  fact_id        uuid        primary key default gen_random_uuid(),
  kind           text        not null check (kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  subject        text        not null check (length(subject) between 1 and 120),
  field          text        not null check (length(field) between 1 and 120),
  value          text        not null check (length(value) between 1 and 500),
  source         text        not null check (length(source) between 1 and 200),
  note           text        check (note is null or length(note) between 1 and 500),
  recorded_by    text        not null check (length(recorded_by) between 1 and 200),
  recorded_at    timestamptz not null default clock_timestamp(),
  correlation_id text        not null
);
create index artifact_facts_current on artifact_facts (kind, subject, field, recorded_at desc, fact_id);
create trigger artifact_facts_immutable before update or delete on artifact_facts for each row execute function action_ledger_immutable();
