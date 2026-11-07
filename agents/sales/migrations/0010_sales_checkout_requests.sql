-- R4 Quote V2 + Checkout E2E (contract R-2) — Sales ↔ Checkout purchase records (Sales-owned, schema `sales`).
--
-- Pack state only: no R4 runtime table, no Checkout table. Checkout remains the authority over sessions, attempts,
-- link expiry, financial status and orders; these rows are what R4 SENT (frozen before the first call) and the
-- identifiers Checkout answered. Every key is derived from the execution key (contract §5.1), so a retry, replay or
-- reconciliation sends exactly the same command under the same Idempotency-Key.

-- One purchase start (checkout.start_purchase): the exact create-session body for one execution key. The consent
-- artifact is frozen with it because a replay must carry the identical body (same key + another body =
-- IDEMPOTENCY_KEY_REUSED). It is short-lived (≤ 15 min) and never projected to the model or logged.
create table sales.checkout_purchase_requests (
  execution_key  text primary key check (length(execution_key) between 1 and 200),
  task_id        uuid not null,
  quote_id       uuid not null,
  quote_version  integer not null check (quote_version >= 1),
  consent_format text not null check (consent_format ~ '^[a-z][a-z0-9.-]{1,63}$'),
  consent_token  text not null check (length(consent_token) between 16 and 8192),
  recorded_at    timestamptz not null default clock_timestamp()
);

-- The session Checkout created or returned for that purchase (from Checkout's own answer only).
create table sales.checkout_sessions (
  execution_key text primary key references sales.checkout_purchase_requests (execution_key),
  task_id       uuid not null,
  session_id    text not null check (session_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at   timestamptz not null default clock_timestamp()
);
create index sales_checkout_sessions_by_task on sales.checkout_sessions (task_id, recorded_at);

-- One payment-link request (checkout.request_payment_link) for a session, frozen before any call. A request with
-- no row in checkout_link_attempts only read an existing attempt (read-first, contract §5.3) and posted nothing.
create table sales.checkout_link_requests (
  execution_key text primary key check (length(execution_key) between 1 and 200),
  task_id       uuid not null,
  session_id    text not null check (session_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at   timestamptz not null default clock_timestamp()
);

-- The payment attempt Checkout created for that link request (from Checkout's own answer only).
create table sales.checkout_link_attempts (
  execution_key      text primary key references sales.checkout_link_requests (execution_key),
  task_id            uuid not null,
  payment_attempt_id text not null check (payment_attempt_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at        timestamptz not null default clock_timestamp()
);

create trigger sales_checkout_purchase_requests_immutable before update or delete on sales.checkout_purchase_requests
  for each row execute function sales.forbid_mutation();
create trigger sales_checkout_sessions_immutable before update or delete on sales.checkout_sessions
  for each row execute function sales.forbid_mutation();
create trigger sales_checkout_link_requests_immutable before update or delete on sales.checkout_link_requests
  for each row execute function sales.forbid_mutation();
create trigger sales_checkout_link_attempts_immutable before update or delete on sales.checkout_link_attempts
  for each row execute function sales.forbid_mutation();
