-- R4 commercial baseline (M1): raw facts from the traces R4 already keeps, one JSON document, read-only.
-- No new table, no copy of message text: identifiers, times, counts, tokens, codes and md5 digests only (a search
-- query or need is exported as its digest: equality is all the repeat check needs). Conversations are opaque numbers
-- local to one export (the keyed conversation hash never leaves the database).
--
--   docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' <postgres container> \
--     psql -X -U <user> -d <db> -At -v since="'2026-11-01'" -f - < ops/r4-metrics/baseline.sql > facts.json
--   node ops/r4-metrics/report.mjs facts.json [--models ops/r4-metrics/models.example.json]
--
-- Population: every run started at or after :since, and every task created then OR with a run then (so a conversation
-- opened earlier and active now is counted whole). Quotes: every quote.create receipt of those tasks.
--
-- One RUN is one turn of work. Its TRIGGER is the OLDEST customer input of the task received after the task's previous
-- run started and at or before this run started (a burst of messages is measured from its first one). A run with no
-- such input (a wake-up, a consultation answer, a recovery after a failed run) has kind 'continuation' and no latency.
-- Its ANSWER is the first agent outbound of the run that was not cancelled (duplicates and held replies are).
\set ON_ERROR_STOP on
with
all_runs as (
  select r.*, lag(r.started_at) over (partition by r.task_id order by r.started_at) as previous_run_at from agent_runs r
),
conversations as (
  select b.binding_id, dense_rank() over (order by b.channel, b.conversation_key) as conversation_no from channel_conversation_bindings b
),
runs as (
  select r.run_id, r.task_id, r.agent_id, r.agent_version, r.status, r.termination_reason, r.termination_code,
         r.model_calls, r.input_tokens, r.output_tokens, r.capability_calls, r.started_at, r.finished_at,
         b.binding_id, c.conversation_no, b.channel, b.eligibility_reason, b.profile,
         (select min(e.received_at) from inbound_events e where e.task_id = r.task_id and e.status = 'ingested' and e.received_at <= r.started_at
            and (r.previous_run_at is null or e.received_at > r.previous_run_at)) as trigger_at,
         (select min(o.created_at) from outbound_messages o where o.task_id = r.task_id and o.run_id = r.run_id and o.origin = 'agent' and o.status <> 'cancelled') as answer_at,
         (select min(coalesce(o.delivered_at, o.read_at)) from outbound_messages o where o.task_id = r.task_id and o.run_id = r.run_id and o.origin = 'agent' and o.status <> 'cancelled') as answer_delivered_at
  from all_runs r
  left join channel_conversation_bindings b on b.task_id = r.task_id
  left join conversations c on c.binding_id = b.binding_id
  where r.started_at >= :since::timestamptz
),
tasks as (
  select t.task_id, t.agent_id, t.agent_version, t.status, t.created_at, b.eligibility_reason, b.channel, b.binding_id, b.profile, c.conversation_no,
         (select min(e.received_at) from inbound_events e where e.task_id = t.task_id and e.status = 'ingested') as first_input_at,
         (select count(*) from inbound_events e where e.task_id = t.task_id and e.status = 'ingested') as inputs,
         (select coalesce(json_object_agg(k, n), '{}') from (select coalesce(h.data ->> 'initiatedBy', 'agent') as k, count(*) as n from temporal_events h
            where h.task_id = t.task_id and h.event_type = 'handoff.requested' group by 1) x) as handoffs,
         (select count(*) from outbound_messages o where o.task_id = t.task_id and o.origin = 'agent' and o.status <> 'cancelled') as agent_messages,
         (select count(*) from outbound_messages o where o.task_id = t.task_id and o.origin = 'agent' and o.status <> 'cancelled' and (o.delivered_at is not null or o.read_at is not null)) as agent_messages_delivered,
         (select count(*) from outbound_messages o where o.task_id = t.task_id and o.origin = 'agent' and o.status = 'cancelled') as agent_messages_cancelled,
         (select count(*) from outbound_messages o where o.task_id = t.task_id and o.origin = 'agent' and o.status = 'failed') as agent_messages_failed
  from agent_tasks t
  left join channel_conversation_bindings b on b.task_id = t.task_id
  left join conversations c on c.binding_id = b.binding_id
  where t.created_at >= :since::timestamptz or exists (select 1 from agent_runs r where r.task_id = t.task_id and r.started_at >= :since::timestamptz)
),
steps as (
  select s.run_id, s.iteration, s.origin, s.decision_type, s.decision ->> 'capabilityId' as capability, s.outcome, s.error_code,
         md5((s.decision -> 'arguments')::text) as arguments_digest, o.outcome as observation_outcome, s.input_tokens, s.output_tokens, s.created_at
  from agent_run_steps s
  join runs using (run_id)
  left join observations o on o.observation_id = s.observation_id
),
quotes as (
  select a.task_id, a.run_id, a.status, a.error_code, a.replayed, a.attempts, a.obtained_via, a.executed_at, a.recorded_at,
         d.preview_id, d.outcome as decision_outcome, d.reason_code, (d.quote_request -> 'promotion') is not null as promotional
  from action_receipts a
  join tasks using (task_id)
  left join sales.quote_autonomous_decisions d on d.execution_key = a.execution_key
  where a.capability_id = 'quote.create'
),
previews as (
  select s.task_id, count(*) as previews, count(distinct (o.payload ->> 'previewId')) filter (where o.payload ->> 'status' = 'ready') as distinct_ready_previews
  from agent_run_steps s join tasks using (task_id) join observations o on o.observation_id = s.observation_id
  where s.decision ->> 'capabilityId' = 'quote.preview'
  group by s.task_id
)
select json_build_object(
  'generatedAt', now(),
  'since', :since::timestamptz,
  'runs', (select coalesce(json_agg(runs order by started_at), '[]') from runs),
  'steps', (select coalesce(json_agg(steps order by run_id, iteration), '[]') from steps),
  'quotes', (select coalesce(json_agg(quotes order by recorded_at), '[]') from quotes),
  'tasks', (select coalesce(json_agg(x order by created_at), '[]') from (select tasks.*, coalesce(p.previews, 0) as previews, coalesce(p.distinct_ready_previews, 0) as distinct_ready_previews from tasks left join previews p using (task_id)) x)
)::text;
