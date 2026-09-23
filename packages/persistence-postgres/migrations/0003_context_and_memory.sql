-- R4-C2 context compiler & memory boundaries: durable task memory, immutable
-- context snapshots (one per model call input) and the link from each run
-- step to the snapshot its model call used. Append-only: 0001/0002 untouched.

-- ---------------------------------------------------------------------------
-- Memory: task-scoped, append-only. Lifecycle without destroying provenance:
-- a newer entry supersedes an older one (same task and type), or an entry is
-- expired (valid_until at creation, or expired_at set once). Nothing else may
-- change after insert, and nothing is deleted.
-- ---------------------------------------------------------------------------
create table memory_entries (
  entry_id            uuid        primary key,
  task_id             uuid        not null references agent_tasks (task_id),
  memory_type         text        not null check (memory_type in ('WORKING', 'CONVERSATIONAL', 'EPISODIC', 'DERIVED_SUMMARY')),
  content             jsonb       not null check (jsonb_typeof(content) = 'object'),
  occurred_at         timestamptz not null,
  recorded_at         timestamptz not null,
  valid_until         timestamptz,
  expired_at          timestamptz,
  supersedes_entry_id uuid,
  -- Memory has no encryption: SECRET is not storable.
  sensitivity         text        not null check (sensitivity in ('NORMAL', 'SENSITIVE')),
  recorded_by_kind    text        not null check (recorded_by_kind in ('user', 'service', 'agent', 'system', 'unauthenticated')),
  recorded_by_ref     text        not null,
  -- DERIVED_SUMMARY only: same compactor + same sources = same key.
  derivation_key      text        check (derivation_key is null or derivation_key ~ '^[0-9a-f]{64}$'),
  correlation_id      text        not null,
  unique (task_id, memory_type, entry_id),
  -- An entry supersedes at most one older entry, of the same task and type, and is superseded at most once.
  unique (supersedes_entry_id),
  foreign key (task_id, memory_type, supersedes_entry_id) references memory_entries (task_id, memory_type, entry_id),
  unique (task_id, derivation_key),
  check ((memory_type = 'DERIVED_SUMMARY') = (derivation_key is not null)),
  check (supersedes_entry_id is null or supersedes_entry_id <> entry_id)
);
create index memory_entries_task_idx on memory_entries (task_id, occurred_at, entry_id);

create function memory_entries_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'memory entries are append-only (entry %)', old.entry_id using errcode = '55000';
  end if;
  -- Only expiry may be recorded, once; every other column is immutable.
  if old.expired_at is not null
     or (to_jsonb(new) - 'expired_at') is distinct from (to_jsonb(old) - 'expired_at') then
    raise exception 'memory entry % is immutable (only expired_at may be set, once)', old.entry_id using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger memory_entries_append_only
  before update or delete on memory_entries
  for each row execute function memory_entries_append_only();

-- ---------------------------------------------------------------------------
-- Context snapshots: the exact, structured model input of one iteration,
-- persisted BEFORE the model call and immutable afterwards. A recovered
-- iteration whose inputs changed gets a new attempt that supersedes the
-- previous one; nothing is ever rewritten.
-- ---------------------------------------------------------------------------
create table context_snapshots (
  snapshot_id            uuid        primary key,
  run_id                 uuid        not null references agent_runs (run_id),
  task_id                uuid        not null references agent_tasks (task_id),
  iteration              integer     not null check (iteration > 0),
  attempt                integer     not null check (attempt > 0),
  agent_id               text        not null,
  agent_version          integer     not null,
  compiler_version       text        not null,
  policy_version         text        not null check (policy_version ~ '^[0-9a-f]{64}$'),
  compiled_context       jsonb       not null check (jsonb_typeof(compiled_context) = 'object'),
  content_hash           text        not null check (content_hash ~ '^[0-9a-f]{64}$'),
  input_fingerprint      text        not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  estimated_tokens       integer     not null check (estimated_tokens >= 0),
  -- Effective budget policy (ADR-015): 'unbounded' = no R4-imposed limit.
  budget_mode            text        not null check (budget_mode in ('unbounded', 'fixed')),
  max_estimated_tokens   integer     check (max_estimated_tokens > 0),
  supersedes_snapshot_id uuid        unique references context_snapshots (snapshot_id),
  correlation_id         text        not null,
  created_at             timestamptz not null,
  unique (run_id, iteration, attempt),
  -- Target of the composite FK from agent_run_steps.
  unique (snapshot_id, run_id, iteration),
  foreign key (agent_id, agent_version) references agent_definitions (agent_id, version),
  check ((budget_mode = 'fixed') = (max_estimated_tokens is not null)),
  check (max_estimated_tokens is null or estimated_tokens <= max_estimated_tokens),
  check ((attempt = 1) = (supersedes_snapshot_id is null))
);
create index context_snapshots_task_idx on context_snapshots (task_id);

-- What the compiler decided for EVERY evaluated item, compacted ones included
-- (metadata only: never content). The single source of context accounting
-- (ADR-015): composition by kind, authority, source, section and reason is a
-- GROUP BY over these rows — nothing is denormalized.
create table context_snapshot_items (
  snapshot_id      uuid    not null references context_snapshots (snapshot_id),
  position         integer not null check (position >= 0),
  item_id          text    not null,
  source_id        text    not null,
  kind             text    not null,
  authority        text    not null check (authority in ('AUTHORITATIVE', 'OBSERVED', 'CONVERSATIONAL', 'DERIVED', 'COGNITIVE')),
  freshness        text    not null check (freshness in ('fresh', 'stale', 'expired', 'unknown')),
  sensitivity      text    not null check (sensitivity in ('NORMAL', 'SENSITIVE', 'SECRET')),
  decision         text    not null check (decision in ('included', 'excluded')),
  section          text,
  exclusion_reason text    check (exclusion_reason in ('expired', 'superseded', 'budget', 'policy', 'sensitivity', 'duplicate', 'not_relevant_to_scope', 'compacted')),
  represented_by   text,
  estimated_tokens integer not null check (estimated_tokens >= 0),
  primary key (snapshot_id, position),
  check ((decision = 'included') = (section is not null)),
  check ((decision = 'included') = (exclusion_reason is null)),
  -- A SECRET item can only ever be recorded as excluded.
  check (sensitivity <> 'SECRET' or decision = 'excluded')
);
create index context_snapshot_items_item_idx on context_snapshot_items (item_id);

create function context_snapshots_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'context snapshots are immutable (%)', tg_table_name using errcode = '55000';
end;
$$;
create trigger context_snapshots_immutable
  before update or delete on context_snapshots
  for each row execute function context_snapshots_immutable();
create trigger context_snapshot_items_immutable
  before update or delete on context_snapshot_items
  for each row execute function context_snapshots_immutable();

-- ---------------------------------------------------------------------------
-- Each model call is tied to the snapshot of ITS run and iteration. Null only
-- for steps recorded before R4-C2.
-- ---------------------------------------------------------------------------
alter table agent_run_steps
  add column context_snapshot_id uuid,
  add constraint agent_run_steps_context_snapshot_fk
    foreign key (context_snapshot_id, run_id, iteration) references context_snapshots (snapshot_id, run_id, iteration);
