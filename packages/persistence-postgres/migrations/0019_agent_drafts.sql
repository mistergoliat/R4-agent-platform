-- ADR-054 (W1): agent drafts. A draft is a proposed definition derived from a registered base; it is NEVER
-- registered in agent_definitions and never runs in production. Operators create, revise and discard drafts.
--
-- `agent_drafts` holds the CURRENT state of each draft; `agent_draft_revisions` keeps every saved definition,
-- append-only (same immutability trigger as the other ledgers). Both are written in one transaction.
--
-- Additive: two new tables, no change to existing ones. Rollback of the code does not require removing them.
create table agent_drafts (
  draft_id      uuid        primary key,
  agent_id      text        not null check (agent_id ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and length(agent_id) <= 64),
  base_agent_id text        not null,
  base_version  integer     not null,
  template      text        not null check (template ~ '^[a-z][a-z0-9-]{0,31}$'),
  channel       text        check (channel is null or channel ~ '^[a-z][a-z0-9-]{0,31}$'),
  state         text        not null check (state in ('draft', 'ready', 'launched', 'discarded')),
  revision      integer     not null check (revision >= 1),
  created_by    text        not null,
  created_at    timestamptz not null,
  updated_by    text        not null,
  updated_at    timestamptz not null,
  foreign key (base_agent_id, base_version) references agent_definitions (agent_id, version)
);
-- At most one open draft per agent id.
create unique index agent_drafts_open_agent on agent_drafts (agent_id) where state in ('draft', 'ready');
create index agent_drafts_updated on agent_drafts (updated_at desc);

create table agent_draft_revisions (
  draft_id       uuid        not null references agent_drafts (draft_id),
  revision       integer     not null check (revision >= 1),
  definition     jsonb       not null,
  note           text        check (note is null or length(note) between 1 and 500),
  created_by     text        not null,
  created_at     timestamptz not null,
  correlation_id text        not null,
  primary key (draft_id, revision)
);
create trigger agent_draft_revisions_immutable before update or delete on agent_draft_revisions for each row execute function action_ledger_immutable();
