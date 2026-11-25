-- ADR-055 C1: read-only report of the contact gate (run with psql on the R4 database). Prints no contact keys, no
-- addresses and no message text, only counts.
--
--   psql "$R4_DATABASE_URL" -f ops/contact/report.sql

-- 1. Decisions per day, step, mode, outcome and rule (last 14 days, Chile time).
select to_char(decided_at at time zone 'America/Santiago', 'YYYY-MM-DD') as day,
       split_part(source_ref, ':', 3) as step,
       mode, outcome, rule, count(*) as n
  from contact_decisions
 where decided_at > r4_now() - interval '14 days'
 group by 1, 2, 3, 4, 5
 order by 1 desc, 2, 3, 4, 5;

-- 2. Opt-outs this month, and how they arrived.
select source, count(*) filter (where revoked_at is null) as active, count(*) filter (where revoked_at is not null) as revoked
  from contact_opt_outs
 where opted_out_at > date_trunc('month', r4_now())
 group by source;

-- 3. Quotes of the last 7 days with no follow-up decision yet (expired quotes, busy or closed cases, too early).
select count(*) as quotes_without_decision
  from sales.quote_v2_issued i
 where i.issued_at > r4_now() - interval '7 days'
   and not exists (select 1 from contact_decisions d where d.source_ref like 'sales.quote-followup:' || i.quote_id::text || ':%');

-- Revert an opt-out ONLY when the contact asks for it (ADR-055 Decision 3), by a person, recorded:
--   update contact_opt_outs set revoked_at = clock_timestamp(), revoked_by = '<operator ref>'
--    where channel = 'whatsapp' and conversation_key = '<key>' and revoked_at is null;
