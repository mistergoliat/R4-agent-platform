-- ADR-069 D2: the full transcript of a channel session (today: a voice call, modality `call`), as the speech engine
-- heard the contact and as the agent's voice spoke. A record of the conversation, NEVER an input: the agent never sees
-- it. The contact's lines are their own words (personal, untrusted); the agent's lines are model output (untrusted).
--
-- Deliberately DELETABLE (no immutability trigger, unlike the rest of the record): a daily purge removes rows older
-- than the retention (ADR-069 D4, 30 days) and a data subject's erasure request can remove them. Idempotent by
-- (channel, event_id). task_id is null only when the conversation could not be resolved to a task.
create table session_transcripts (
  transcript_id uuid        primary key default gen_random_uuid(),
  task_id       uuid        references agent_tasks (task_id),
  channel       text        not null check (channel ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  modality      text        not null check (modality ~ '^[a-z][a-z0-9_.-]{0,31}$'),
  event_id      text        not null check (length(event_id) between 1 and 256),
  started_at    timestamptz not null,
  ended_at      timestamptz not null check (ended_at >= started_at),
  -- [{ "speaker": "contact" | "agent", "at": iso, "text": string }] in order; checked by the adapter.
  lines         jsonb       not null check (jsonb_typeof(lines) = 'array'),
  truncated     boolean     not null default false,
  -- (ADR-069 D3) The figures audit of the session (ADR-068 D3): { delegations, unbacked: [figure] }; null when none ran.
  audit         jsonb       check (audit is null or jsonb_typeof(audit) = 'object'),
  received_at   timestamptz not null default clock_timestamp(),
  unique (channel, event_id)
);
create index session_transcripts_task on session_transcripts (task_id, started_at);
create index session_transcripts_started on session_transcripts (started_at);
