-- R4-J3E-B independent customer-intent evidence (Sales-owned, schema `sales`).
--
-- One row per autonomous quote authorized by quote.create@4: WHICH platform
-- records showed that the customer confirmed the commercial offer. The
-- records themselves (the agent's offer message and the customer's input)
-- stay with the platform; this row keeps only their identities, times,
-- delivery status and SHA-256 of their text — never the customer's text.
--
-- Written in the same transaction as the authorized decision (0008) and the
-- frozen Quote V2 request (0007). A customer message can authorize at most one
-- quote: `confirmation_input_id` is unique.
create table sales.quote_intent_evidence (
  execution_key             text primary key references sales.quote_autonomous_decisions (execution_key),
  task_id                   uuid not null,
  preview_id                text not null check (preview_id ~ '^[0-9a-f]{64}$'),
  commercial_version        integer not null check (commercial_version >= 0),
  presented_reference       text not null check (length(presented_reference) between 1 and 40),
  presented_gross           bigint not null check (presented_gross >= 0),
  offer_ref                 text not null check (length(offer_ref) between 1 and 200),
  offer_at                  timestamptz not null,
  offer_delivery_status     text not null check (offer_delivery_status in ('accepted', 'delivered', 'read')),
  offer_outbound_id         uuid not null,
  offer_text_sha256         text not null check (offer_text_sha256 ~ '^[0-9a-f]{64}$'),
  confirmation_input_id     uuid not null unique,
  confirmation_at           timestamptz not null,
  confirmation_text_sha256  text not null check (confirmation_text_sha256 ~ '^[0-9a-f]{64}$'),
  grammar_version           text not null check (length(grammar_version) between 1 and 60),
  grammar_rule              text not null check (length(grammar_rule) between 1 and 120),
  recorded_at               timestamptz not null default clock_timestamp(),
  check (confirmation_at > offer_at)
);
create index sales_quote_intent_evidence_by_task on sales.quote_intent_evidence (task_id, recorded_at);

create trigger sales_quote_intent_evidence_immutable before update or delete on sales.quote_intent_evidence
  for each row execute function sales.forbid_mutation();
