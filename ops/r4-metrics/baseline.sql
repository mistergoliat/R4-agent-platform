-- R4 commercial baseline (M1): raw facts from the traces R4 already keeps, one JSON document, read-only.
-- No new table, no copy of message text: identifiers, times, counts, tokens and codes only.
--
--   docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' <postgres container> \
--     psql -X -U <user> -d <db> -At -v since="'2026-11-01'" -f - < ops/r4-metrics/baseline.sql > facts.json
--   node ops/r4-metrics/report.mjs facts.json [--models ops/r4-metrics/models.example.json]
--
-- One RUN is one turn of work: it starts after an input (customer message, reaction, file) and ends waiting,
-- blocked or failed. Its trigger is the newest input of the task received at or before it started; its answer is
-- the first agent outbound it produced (outbound_messages.run_id).
\set ON_ERROR_STOP on
with
runs as (
  select r.run_id, r.task_id, r.agent_id, r.agent_version, r.status, r.termination_reason, r.termination_code,
         r.model_calls, r.input_tokens, r.output_tokens, r.capability_calls, r.started_at, r.finished_at,
         b.binding_id, b.channel, b.eligibility_reason, b.profile,
         (select max(e.received_at) from inbound_events e where e.task_id = r.task_id and e.status = 'ingested' and e.received_at <= r.started_at) as trigger_at,
         (select min(o.created_at) from outbound_messages o where o.run_id = r.run_id and o.origin = 'agent') as answer_at,
         (select min(coalesce(o.delivered_at, o.read_at)) from outbound_messages o where o.run_id = r.run_id and o.origin = 'agent') as answer_delivered_at
  from agent_runs r
  left join channel_conversation_bindings b on b.task_id = r.task_id
  where r.started_at >= :since::timestamptz
),
steps as (
  select s.run_id, s.iteration, s.origin, s.decision_type, s.decision ->> 'capabilityId' as capability, s.outcome, s.error_code,
         coalesce(s.decision -> 'arguments' ->> 'productKey', s.decision -> 'arguments' ->> 'query', s.decision -> 'arguments' ->> 'need') as target,
         o.outcome as observation_outcome, s.input_tokens, s.output_tokens, s.created_at
  from agent_run_steps s
  join runs using (run_id)
  left join observations o on o.observation_id = s.observation_id
),
quotes as (
  select a.task_id, a.run_id, a.status, a.error_code, a.replayed, a.attempts, a.obtained_via, a.executed_at, a.recorded_at,
         d.preview_id, d.outcome as decision_outcome, d.reason_code, (d.quote_request -> 'promotion') is not null as promotional
  from action_receipts a
  left join sales.quote_autonomous_decisions d on d.execution_key = a.execution_key
  where a.capability_id = 'quote.create' and a.recorded_at >= :since::timestamptz
),
previews as (
  select s.task_id, count(*) as previews, count(distinct (o.payload ->> 'previewId')) filter (where o.payload ->> 'status' = 'ready') as distinct_ready_previews
  from agent_run_steps s join observations o on o.observation_id = s.observation_id
  where s.decision ->> 'capabilityId' = 'quote.preview' and s.created_at >= :since::timestamptz
  group by s.task_id
),
tasks as (
  select t.task_id, t.status, t.created_at, b.eligibility_reason, b.channel, b.binding_id,
         (select min(e.received_at) from inbound_events e where e.task_id = t.task_id and e.status = 'ingested') as first_input_at,
         (select count(*) from inbound_events e where e.task_id = t.task_id and e.status = 'ingested') as inputs,
         (select count(*) from temporal_events h where h.task_id = t.task_id and h.event_type = 'handoff.requested') as handoffs,
         (select count(*) from outbound_messages o where o.task_id = t.task_id and o.origin = 'agent') as agent_messages,
         (select count(*) from outbound_messages o where o.task_id = t.task_id and o.origin = 'agent' and (o.delivered_at is not null or o.read_at is not null)) as agent_messages_delivered,
         (select count(*) from outbound_messages o where o.task_id = t.task_id and o.status = 'failed') as outbound_failed,
         coalesce(p.previews, 0) as previews, coalesce(p.distinct_ready_previews, 0) as distinct_ready_previews
  from agent_tasks t
  left join channel_conversation_bindings b on b.task_id = t.task_id
  left join previews p on p.task_id = t.task_id
  where t.created_at >= :since::timestamptz
)
select json_build_object(
  'generatedAt', now(),
  'since', :since::timestamptz,
  'runs', (select coalesce(json_agg(runs order by started_at), '[]') from runs),
  'steps', (select coalesce(json_agg(steps order by run_id, iteration), '[]') from steps),
  'quotes', (select coalesce(json_agg(quotes order by recorded_at), '[]') from quotes),
  'tasks', (select coalesce(json_agg(tasks order by created_at), '[]') from tasks)
)::text;
