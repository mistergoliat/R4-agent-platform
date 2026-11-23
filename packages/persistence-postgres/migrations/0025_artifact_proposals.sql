-- ADR-058 G3: proposed changes to an artifact kind, decided by a person. Generic: Core stores each change opaque (the
-- pack that owns the kind writes and applies it) and never interprets it.
--
-- A proposal is `proposed` → `approved` | `rejected` (a person, `artifact.curate`) → `applied` (the pack built a new
-- version that contains it). `change` null is informational: approving it acknowledges it, nothing is applied.
-- At most one live (proposed or approved) or rejected proposal per kind and fingerprint, so the same finding is not
-- proposed twice and a rejected one does not come back. `artifact_proposal_events` is the append-only history.
--
-- Additive: two new tables, no change to existing ones.
create table artifact_proposals (
  proposal_id     uuid        primary key default gen_random_uuid(),
  kind            text        not null,
  base_version    integer     not null,
  source          text        not null check (length(source) between 1 and 200),
  fingerprint     text        not null check (length(fingerprint) between 1 and 200),
  summary         text        not null check (length(summary) between 1 and 500),
  evidence        jsonb       not null,
  change          jsonb,
  state           text        not null check (state in ('proposed', 'approved', 'rejected', 'applied')),
  created_at      timestamptz not null default clock_timestamp(),
  decided_by      text        check (decided_by is null or length(decided_by) between 1 and 200),
  decided_at      timestamptz,
  decision_note   text        check (decision_note is null or length(decision_note) between 1 and 500),
  applied_version integer,
  foreign key (kind, base_version) references artifact_versions (kind, version),
  foreign key (kind, applied_version) references artifact_versions (kind, version),
  check ((state = 'proposed') = (decided_by is null)),
  check ((decided_by is null) = (decided_at is null)),
  check ((state = 'applied') = (applied_version is not null)),
  check (state <> 'applied' or change is not null)
);
create unique index artifact_proposals_once on artifact_proposals (kind, fingerprint) where state in ('proposed', 'approved', 'rejected');
create index artifact_proposals_state on artifact_proposals (kind, state, created_at);

create table artifact_proposal_events (
  event_id       uuid        primary key default gen_random_uuid(),
  proposal_id    uuid        not null references artifact_proposals (proposal_id),
  from_state     text        check (from_state in ('proposed', 'approved')),
  to_state       text        not null check (to_state in ('proposed', 'approved', 'rejected', 'applied')),
  decided_by     text        not null,
  decided_at     timestamptz not null default clock_timestamp(),
  note           text        check (note is null or length(note) between 1 and 500),
  correlation_id text        not null,
  check ((from_state is null) = (to_state = 'proposed'))
);
create index artifact_proposal_events_proposal on artifact_proposal_events (proposal_id, decided_at);
create trigger artifact_proposal_events_immutable before update or delete on artifact_proposal_events for each row execute function action_ledger_immutable();
