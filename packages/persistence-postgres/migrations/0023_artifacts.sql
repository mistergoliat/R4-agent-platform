-- ADR-058 Decision 1: a minimal generic Artifact. Core stores opaque JSON versions per kind and who signed them; it
-- knows nothing of what a kind means (each kind's schema lives in the pack that owns it).
--
-- `artifact_versions` is immutable: a version is never edited or deleted. `artifact_signatures` is the append-only
-- signature log. The CURRENT version of a kind is the one with the latest signature, so going back is signing an older
-- version again: nothing is removed. The content hash is computed by the database over the stored jsonb text.
--
-- Additive: two new tables, no change to existing ones. Rollback of the code does not require removing them.
create table artifact_versions (
  kind           text        not null check (kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  version        integer     not null check (version >= 1),
  content        jsonb       not null,
  content_sha256 text        not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  note           text        check (note is null or length(note) between 1 and 500),
  created_by     text        not null check (length(created_by) between 1 and 200),
  created_at     timestamptz not null default clock_timestamp(),
  primary key (kind, version)
);
create trigger artifact_versions_immutable before update or delete on artifact_versions for each row execute function action_ledger_immutable();

create table artifact_signatures (
  signature_id     uuid        primary key default gen_random_uuid(),
  kind             text        not null,
  version          integer     not null,
  -- The version that was current when this one was signed (null: the kind's first signature).
  replaces_version integer,
  signed_by        text        not null check (length(signed_by) between 1 and 200),
  signed_at        timestamptz not null default clock_timestamp(),
  note             text        check (note is null or length(note) between 1 and 500),
  correlation_id   text        not null,
  foreign key (kind, version) references artifact_versions (kind, version),
  foreign key (kind, replaces_version) references artifact_versions (kind, version),
  check (replaces_version is null or replaces_version <> version)
);
create index artifact_signatures_current on artifact_signatures (kind, signed_at desc, signature_id);
create trigger artifact_signatures_immutable before update or delete on artifact_signatures for each row execute function action_ledger_immutable();
