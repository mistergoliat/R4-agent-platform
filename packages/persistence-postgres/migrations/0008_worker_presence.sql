-- R4-I: worker presence (execution readiness). Additive; 0001–0007 intact.
--
-- Current presence of execution worker processes — one row per process
-- incarnation, renewed only while its claim loop progresses. NOT an audit
-- history: rows are upserted in place and rows expired for ~24 h are purged.
-- Freshness lives on the database clock: a row counts only while
-- `expires_at > clock_timestamp()`; a crashed worker simply expires.
-- Owner: @r4/worker (writes), readiness readers such as the channel gateway
-- (reads), through @r4/task-runtime's WorkerPresenceStore port.
create table worker_presence (
  worker_id      text        primary key check (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  execution_mode text        not null check (execution_mode in ('test', 'shadow', 'production')),
  compatibility  text        not null check (compatibility ~ '^[A-Za-z0-9][A-Za-z0-9._@:-]{0,199}$'),
  build_ref      text        check (build_ref ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  state          text        not null check (state in ('ready', 'not_ready', 'stopping')),
  reason         text        check (reason in ('claim_loop_error', 'shutting_down')),
  started_at     timestamptz not null,
  heartbeat_at   timestamptz not null,
  expires_at     timestamptz not null,
  check (expires_at >= heartbeat_at),
  check ((state = 'ready') = (reason is null))
);
-- Readiness reads and the purge both select by expiry.
create index worker_presence_expires_at on worker_presence (expires_at);
