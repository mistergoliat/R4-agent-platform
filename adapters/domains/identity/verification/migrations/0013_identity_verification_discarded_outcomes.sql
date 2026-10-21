-- R4-J4 SEC-S4 (R4-J4-SEC-OTP-ACCELERATED-IMPLEMENTATION-06, special condition): a confirm that was
-- in flight when its expectation was replaced (or closed) may have completed an operation at the CIA.
-- Its result is DISCARDED (it never touches the new expectation, never resumes the task and grants
-- nothing), but the fact that an external operation existed is kept here, without any secret:
-- no code, no ciphertext, no verificationId, no subject, no customer reference. It lives as long as
-- its response (purged with it after the CIA idempotency retention).

create table identity_verification.discarded_outcomes (
  response_id      uuid primary key references identity_verification.responses (response_id) on delete cascade,
  expectation_id   uuid not null references identity_verification.expectations (expectation_id) on delete cascade,
  lease_generation bigint not null check (lease_generation >= 1),
  cia_outcome      text not null check (cia_outcome in ('linked', 'no_eligible_account', 'ineligible_account', 'ambiguous', 'conflicted', 'invalid_code', 'expired', 'locked')),
  response_state   text not null check (response_state in ('cancelled', 'expired', 'failed')),
  recorded_at      timestamptz not null default clock_timestamp()
);
