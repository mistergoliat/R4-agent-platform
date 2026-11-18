-- R4 F2-R02 (O-5, approved 2026-11-18) — the customer's explicit purchase act (Sales-owned, schema `sales`). Additive.
--
-- One row per purchase start (checkout.start_purchase execution key) that recorded the act: WHICH platform-recorded
-- customer message asked to pay WHICH issued quote. Identities, platform times and a SHA-256 only: never the
-- customer's text (it stays in the Core), never a customerRef, a grant or a PrestaShop id. Checkout issues the consent
-- evidence from this act (O-5); this row is R4's record of what it transmits.
--
-- Written only when the capability's purchase-act recording is enabled; no production profile enables it (contract
-- test f2-purchase-boundaries). A customer message is the act of at most one purchase start: `request_input_id` is
-- unique.
create table sales.purchase_act_evidence (
  execution_key        text primary key check (length(execution_key) between 1 and 200),
  task_id              uuid not null,
  quote_id             uuid not null,
  quote_version        integer not null check (quote_version >= 1),
  quote_issued_at      timestamptz not null,
  request_input_id     uuid not null unique,
  request_at           timestamptz not null,
  request_text_sha256  text not null check (request_text_sha256 ~ '^[0-9a-f]{64}$'),
  grammar_version      text not null check (length(grammar_version) between 1 and 60),
  recorded_at          timestamptz not null default clock_timestamp(),
  check (request_at > quote_issued_at)
);
create index sales_purchase_act_evidence_by_task on sales.purchase_act_evidence (task_id, recorded_at);

create trigger sales_purchase_act_evidence_immutable before update or delete on sales.purchase_act_evidence
  for each row execute function sales.forbid_mutation();
