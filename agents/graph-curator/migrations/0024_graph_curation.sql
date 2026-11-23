-- ADR-058 G2 (schema `graph`, owned by the graph-curator pack): each curator run over the signed product graph and the
-- live catalog, and what it found. Findings are immutable: approving or rejecting them (and dedup across runs by
-- `fingerprint`) comes with the console in G3. Nothing here is read by Pesín.
--
-- Additive: a new schema with two tables. Rollback of the code does not require removing them.
create schema if not exists graph;

create table graph.curation_runs (
  run_id        uuid        primary key,
  graph_version integer     not null check (graph_version >= 1),
  started_by    text        not null check (length(started_by) between 1 and 200),
  started_at    timestamptz not null default clock_timestamp(),
  finished_at   timestamptz,
  status        text        not null check (status in ('running', 'completed', 'failed')),
  -- Catalog walk: scanned, found, not_found, failed (counts only, never product data).
  catalog       jsonb,
  -- Findings per task and rule.
  counts        jsonb,
  failure       text        check (failure is null or length(failure) between 1 and 500),
  check ((status = 'running') = (finished_at is null)),
  check ((status = 'failed') = (failure is not null))
);
create index curation_runs_started on graph.curation_runs (started_at desc);

create table graph.curation_findings (
  finding_id  uuid        primary key default gen_random_uuid(),
  run_id      uuid        not null references graph.curation_runs (run_id),
  task        text        not null check (task in ('new_or_changed', 'missing_data', 'inconsistency')),
  rule        text        not null check (rule ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  product_key text        not null check (product_key ~ '^P[1-9][0-9]{0,8}$'),
  related_key text        check (related_key is null or related_key ~ '^P[1-9][0-9]{0,8}$'),
  summary     text        not null check (length(summary) between 1 and 500),
  evidence    jsonb       not null,
  -- Same finding in another run, same fingerprint (task, rule, product, related).
  fingerprint text        not null check (length(fingerprint) between 1 and 200),
  unique (run_id, fingerprint)
);
create index curation_findings_run on graph.curation_findings (run_id, task, rule);
create trigger curation_findings_immutable before update or delete on graph.curation_findings for each row execute function action_ledger_immutable();
