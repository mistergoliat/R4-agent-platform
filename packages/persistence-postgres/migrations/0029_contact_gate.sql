-- ADR-055 (contact gate, C1): messages on the platform's own initiative.
--
-- contact_opt_outs: a contact (channel + keyed conversation hash, never an address) that asked not to be written to
-- first. One row per contact; reverting is setting revoked_at (only when the contact asks, by a person).
create table contact_opt_outs (
  channel          text        not null check (channel ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  conversation_key text        not null check (conversation_key ~ '^[0-9a-f]{64}$'),
  source           text        not null check (source in ('contact_keyword', 'operator')),
  inbound_id       uuid,
  opted_out_at     timestamptz not null default clock_timestamp(),
  revoked_at       timestamptz,
  revoked_by       text        check (revoked_by is null or length(revoked_by) between 1 and 200),
  primary key (channel, conversation_key),
  check ((revoked_at is null) = (revoked_by is null))
);

-- contact_decisions: one decision per source reference (a message a source wanted to send), with the rule that let it
-- out or stopped it and the mode it was decided in. Append-only. Its `send` rows are also the frequency count.
create table contact_decisions (
  decision_id      uuid        primary key default gen_random_uuid(),
  source_ref       text        not null unique check (length(source_ref) between 3 and 200),
  purpose          text        not null check (purpose ~ '^[a-z][a-z0-9_]{0,31}$'),
  channel          text        not null check (channel ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  conversation_key text        not null check (conversation_key ~ '^[0-9a-f]{64}$'),
  task_id          uuid        not null references agent_tasks (task_id),
  mode             text        not null check (mode in ('observe', 'active')),
  outcome          text        not null check (outcome in ('send', 'stopped', 'dropped')),
  rule             text        not null check (rule ~ '^[a-z][a-z0-9_]{0,31}$'),
  rules_version    text        not null check (length(rules_version) between 1 and 64),
  text             text        not null check (length(text) between 1 and 4096),
  template         jsonb,
  outbound_id      uuid        references outbound_messages (outbound_id),
  -- The temporal clock, the clock the sources and the gate decide on (and of the idle close).
  decided_at       timestamptz not null default r4_now(),
  check (outbound_id is null or (mode = 'active' and outcome = 'send'))
);
create index contact_decisions_by_contact on contact_decisions (channel, conversation_key, decided_at desc);
create trigger contact_decisions_immutable before update or delete on contact_decisions for each row execute function action_ledger_immutable();
