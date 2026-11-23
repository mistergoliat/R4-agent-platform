-- R4 F2-R02 (O-5, approved 2026-11-18) — the customer's explicit purchase act (Sales-owned, schema `sales`). Additive.
--
-- One row per purchase start (checkout.start_purchase execution key) that recorded the act: WHICH platform-recorded
-- customer message asked to pay WHICH issued quote. Identities, platform times and a SHA-256 only: never the
-- customer's text (it stays in the Core), never a customerRef, a grant or a PrestaShop id. Checkout issues the consent
-- evidence from this act (O-5); this row is R4's record of what it transmits.
--
-- Written in the SAME transaction as the frozen create-session body (0010, hence the foreign key), after the consent
-- artifact was obtained: a start refused before that leaves no act. A customer message is the act of ONE quote (id and
-- version): the store checks it under a per-input advisory lock; several starts of the same quote may share it
-- (Checkout keeps one live session per quote). Written only when the capability's purchase-act recording is enabled;
-- no production profile enables it (contract test f2-purchase-boundaries).
create table sales.purchase_act_evidence (
  execution_key        text primary key references sales.checkout_purchase_requests (execution_key),
  task_id              uuid not null,
  quote_id             uuid not null,
  quote_version        integer not null check (quote_version >= 1),
  quote_recorded_at    timestamptz not null,
  request_input_id     uuid not null,
  request_at           timestamptz not null,
  request_text_sha256  text not null check (request_text_sha256 ~ '^[0-9a-f]{64}$'),
  grammar_version      text not null check (length(grammar_version) between 1 and 60),
  recorded_at          timestamptz not null default clock_timestamp(),
  check (request_at > quote_recorded_at)
);
create index sales_purchase_act_evidence_by_input on sales.purchase_act_evidence (request_input_id);
create index sales_purchase_act_evidence_by_task on sales.purchase_act_evidence (task_id, recorded_at);

create trigger sales_purchase_act_evidence_immutable before update or delete on sales.purchase_act_evidence
  for each row execute function sales.forbid_mutation();
