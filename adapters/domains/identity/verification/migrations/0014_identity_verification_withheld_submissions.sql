-- R4-J4 SEC-S5 (R4-J4-SEC-OTP-ACCELERATED-IMPLEMENTATION-06): the commercial status `code_needed`
-- (decision rev. 02 §7.3: "R4 did not send: several candidates, context, length"). When a live,
-- accepting expectation receives a number the platform redacts WITHOUT sending it to the CIA, the
-- inspector records that fact here, in the inbound transaction: the reason only — never the text,
-- the number, a hash of it or the sender. No attempt was spent at the CIA.

create table identity_verification.withheld_submissions (
  channel           text not null check (channel ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  provider_event_id text not null check (length(provider_event_id) between 1 and 256),
  expectation_id    uuid not null references identity_verification.expectations (expectation_id) on delete cascade,
  reason            text not null check (reason in ('multiple_candidates', 'ambiguous_digits', 'not_six_digits', 'context_not_allowed')),
  received_at       timestamptz not null default clock_timestamp(),
  primary key (channel, provider_event_id)
);
create index withheld_submissions_by_expectation on identity_verification.withheld_submissions (expectation_id, received_at);
