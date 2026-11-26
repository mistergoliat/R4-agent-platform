-- ADR-067 D2 (satisfaction, S1): a contact's rating of a conversation (the card: shown, then bien, mas_o_menos
-- or mal) or of one reply (up or down, with that reply's outbound id). A channel Evaluation signal, never an input.
--
-- Append-only history: the edge may send several for the same key (shown, then the answer, then the answer with a
-- comment); reads keep the latest per (task_id, scope, outbound_id) by occurred_at. Idempotent by (channel, event_id).
-- task_id is null only when the conversation could not be resolved to a task. outbound_id is the edge's reference to
-- the rated reply, kept without a foreign key: a bad reference must not make the provider re-deliver forever.
-- comment is the contact's own text (untrusted, may carry personal data): stored like an inbound message's content,
-- never shown in an incident or a notice.
create table customer_feedback (
  feedback_id  uuid        primary key default gen_random_uuid(),
  task_id      uuid        references agent_tasks (task_id),
  channel      text        not null check (channel ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  scope        text        not null check (scope in ('conversation', 'message')),
  value        text        not null,
  outbound_id  uuid,
  comment      text        check (comment is null or length(comment) between 1 and 500),
  event_id     text        not null check (length(event_id) between 1 and 256),
  occurred_at  timestamptz not null,
  received_at  timestamptz not null default clock_timestamp(),
  unique (channel, event_id),
  check ((scope = 'conversation' and value in ('shown', 'bien', 'mas_o_menos', 'mal') and outbound_id is null)
      or (scope = 'message' and value in ('up', 'down') and outbound_id is not null)),
  check (value <> 'shown' or comment is null)
);
create index customer_feedback_latest on customer_feedback (task_id, scope, outbound_id, occurred_at desc);
create trigger customer_feedback_immutable before update or delete on customer_feedback for each row execute function action_ledger_immutable();
