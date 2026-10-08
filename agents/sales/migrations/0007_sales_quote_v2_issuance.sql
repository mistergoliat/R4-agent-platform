-- R4-J3B Sales ↔ Quote V2 issuance records (Sales-owned, schema `sales`).
--
-- Pack state only: nothing here references an R4 runtime table or the
-- Quote owner's database. The Quote owner remains the authority for quote
-- identity, number, totals, validity and the document; these rows are what
-- R4 SENT (frozen before the first call) and pointers it read back.

-- The exact CreateQuoteRequest body for one platform execution key, frozen
-- after the approved commercial snapshot was verified and before the first
-- POST. Every retry, replay and reconciliation of the command sends exactly
-- this body under the same Idempotency-Key (= execution key).
create table sales.quote_v2_requests (
  execution_key     text primary key check (length(execution_key) between 1 and 200),
  task_id           uuid not null,
  workspace_version integer not null check (workspace_version >= 1),
  request           jsonb not null check (jsonb_typeof(request) = 'object'),
  request_sha256    text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at       timestamptz not null default clock_timestamp()
);

-- One row per POST attempt, written before the request leaves R4: lets
-- reconciliation apply the owner's "not_found is final 30 s after the
-- attempt ended" rule instead of guessing.
create table sales.quote_v2_sends (
  execution_key text not null references sales.quote_v2_requests (execution_key),
  sent_at       timestamptz not null default clock_timestamp(),
  primary key (execution_key, sent_at)
);

-- The owner accepted the request (quote id/number and issuance operation),
-- possibly still `issuing`. Recorded from the owner's own answer only.
create table sales.quote_v2_acceptances (
  execution_key text primary key references sales.quote_v2_requests (execution_key),
  task_id       uuid not null,
  quote_id      uuid not null,
  quote_number  text not null check (length(quote_number) between 1 and 64),
  operation_id  uuid not null,
  recorded_at   timestamptz not null default clock_timestamp()
);

-- A pointer to a formally issued quote (identity, number, validity, document
-- manifest; totals stay with the owner), plus R4's own
-- verification of the stored PDF bytes (length + SHA-256 against the
-- owner's manifest). `document_verification` is separate from issuance:
-- an issued quote whose bytes could not be read stays issued.
create table sales.quote_v2_issued (
  execution_key            text primary key references sales.quote_v2_requests (execution_key),
  task_id                  uuid not null,
  quote_id                 uuid not null,
  quote_number             text not null check (length(quote_number) between 1 and 64),
  issued_at                timestamptz not null,
  valid_through_local_date date not null,
  valid_until_exclusive    timestamptz not null,
  pdf_sha256               text not null check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length              integer not null check (byte_length >= 1),
  document_verification    text not null check (document_verification in ('verified', 'unavailable', 'mismatch')),
  recorded_at              timestamptz not null default clock_timestamp()
);
create index sales_quote_v2_issued_by_task on sales.quote_v2_issued (task_id, recorded_at);

create trigger sales_quote_v2_requests_immutable before update or delete on sales.quote_v2_requests
  for each row execute function sales.forbid_mutation();
create trigger sales_quote_v2_sends_immutable before update or delete on sales.quote_v2_sends
  for each row execute function sales.forbid_mutation();
create trigger sales_quote_v2_acceptances_immutable before update or delete on sales.quote_v2_acceptances
  for each row execute function sales.forbid_mutation();
create trigger sales_quote_v2_issued_immutable before update or delete on sales.quote_v2_issued
  for each row execute function sales.forbid_mutation();
