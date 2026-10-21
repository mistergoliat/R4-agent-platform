-- R4-J4 SEC-S2 (R4-J4-SEC-S2-STATE-AND-ENCRYPTION-01): transient state of channel identity
-- verification, owned by @r4-adapters/identity-verification (schema `identity_verification`),
-- applied by the platform's generic forward-only migrator. Synthetic only.
--
-- Invariants enforced here (decision rev. 02 §7):
--   * a code is never stored in clear: only AES-256-GCM ciphertext + IV + tag + key id, and only
--     while its response is open (pending / dispatching); keys themselves are never stored;
--   * a terminal expectation or response is immutable; transitions follow the state machine;
--   * closing or superseding an expectation erases every pending sealed code of it;
--   * protect_until only grows and survives the closing of the expectation;
--   * no row carrying a live protection obligation can be deleted.

create schema identity_verification;

create table identity_verification.expectations (
  expectation_id        uuid primary key,
  channel               text not null check (channel ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  conversation_key      text not null check (conversation_key ~ '^[0-9a-f]{64}$'),
  account_ref           text not null check (length(account_ref) between 1 and 256),
  binding_id            uuid not null,
  task_id               uuid not null,
  consumer_id           text not null check (consumer_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  start_idempotency_key text not null unique check (start_idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  verification_id       text check (verification_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  state                 text not null check (state in ('created', 'awaiting_code', 'processing', 'confirmed', 'rejected', 'expired', 'cancelled')),
  cia_outcome           text check (cia_outcome in ('linked', 'no_eligible_account', 'ineligible_account', 'ambiguous', 'conflicted', 'invalid_code', 'expired', 'locked')),
  attempts_remaining    smallint check (attempts_remaining between 0 and 4),
  created_at            timestamptz not null default clock_timestamp(),
  challenge_expires_at  timestamptz,
  protect_until         timestamptz not null,
  closed_at             timestamptz,
  closed_reason         text check (closed_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  version               integer not null default 1 check (version >= 1),
  constraint created_has_no_challenge check (state <> 'created' or verification_id is null),
  constraint issued_states_have_challenge check (state not in ('awaiting_code', 'processing', 'confirmed', 'rejected') or verification_id is not null),
  constraint challenge_has_expiry check (verification_id is null or challenge_expires_at is not null),
  constraint terminal_iff_closed check ((state in ('confirmed', 'rejected', 'expired', 'cancelled')) = (closed_at is not null)),
  constraint closed_has_reason check ((closed_at is null) = (closed_reason is null)),
  constraint confirmed_has_consumed_outcome check (state <> 'confirmed' or (cia_outcome is not null and cia_outcome in ('linked', 'no_eligible_account', 'ineligible_account', 'ambiguous', 'conflicted'))),
  constraint rejected_has_rejecting_outcome check (state <> 'rejected' or (cia_outcome is not null and cia_outcome in ('locked', 'invalid_code'))),
  constraint protection_covers_challenge check (protect_until >= coalesce(challenge_expires_at, created_at))
);

-- One live expectation per conversation.
create unique index expectations_one_live on identity_verification.expectations (channel, conversation_key)
  where state in ('created', 'awaiting_code', 'processing');
create index expectations_protection on identity_verification.expectations (channel, conversation_key, protect_until);

create table identity_verification.responses (
  response_id             uuid primary key,
  expectation_id          uuid not null references identity_verification.expectations (expectation_id),
  channel                 text not null check (channel ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  provider_event_id       text not null check (length(provider_event_id) between 1 and 256),
  received_seq            bigint generated always as identity,
  state                   text not null check (state in ('pending', 'dispatching', 'resolved', 'notified', 'cancelled', 'failed', 'expired')),
  code_ciphertext         bytea,
  code_iv                 bytea check (octet_length(code_iv) = 12),
  code_tag                bytea check (octet_length(code_tag) = 16),
  key_id                  text check (key_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  confirm_idempotency_key text not null unique check (confirm_idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  attempts                integer not null default 0 check (attempts >= 0),
  next_attempt_at         timestamptz not null default clock_timestamp(),
  lease_owner             text,
  lease_generation        bigint not null default 0 check (lease_generation >= 0),
  lease_expires_at        timestamptz,
  cia_outcome             text check (cia_outcome in ('linked', 'no_eligible_account', 'ineligible_account', 'ambiguous', 'conflicted', 'invalid_code', 'expired', 'locked')),
  failure_code            text check (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  received_at             timestamptz not null default clock_timestamp(),
  deadline_at             timestamptz not null,
  purge_after             timestamptz not null,
  unique (channel, provider_event_id),
  constraint secret_only_while_open check ((state in ('pending', 'dispatching')) = (code_ciphertext is not null)),
  constraint sealed_fields_together check (num_nulls(code_ciphertext, code_iv, code_tag, key_id) in (0, 4)),
  constraint lease_only_while_dispatching check ((state = 'dispatching') = (lease_owner is not null and lease_expires_at is not null)),
  constraint resolved_has_outcome check (state not in ('resolved', 'notified') or cia_outcome is not null),
  constraint purge_after_deadline check (purge_after >= deadline_at)
);
create index responses_by_expectation on identity_verification.responses (expectation_id, received_seq);
create index responses_open on identity_verification.responses (state, next_attempt_at) where state in ('pending', 'dispatching');

-- ── Expectations: state machine, immutability, protection ───────────────────────────────────────
create function identity_verification.guard_expectation() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.state in ('created', 'awaiting_code', 'processing') or old.protect_until > clock_timestamp() then
      raise exception 'identity_verification: protection_active' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.state in ('confirmed', 'rejected', 'expired', 'cancelled') then
    raise exception 'identity_verification: expectation_terminal_immutable' using errcode = 'P0001';
  end if;
  if new.expectation_id <> old.expectation_id or new.channel <> old.channel or new.conversation_key <> old.conversation_key
     or new.account_ref <> old.account_ref or new.binding_id <> old.binding_id or new.task_id <> old.task_id
     or new.consumer_id <> old.consumer_id or new.start_idempotency_key <> old.start_idempotency_key
     or new.created_at <> old.created_at
     or (old.verification_id is not null and new.verification_id is distinct from old.verification_id) then
    raise exception 'identity_verification: expectation_identity_immutable' using errcode = 'P0001';
  end if;
  if new.protect_until < old.protect_until then
    raise exception 'identity_verification: protection_cannot_shrink' using errcode = 'P0001';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'identity_verification: version_must_increment' using errcode = 'P0001';
  end if;
  if new.state <> old.state and not (
       (old.state = 'created' and new.state in ('awaiting_code', 'cancelled', 'expired'))
    or (old.state = 'awaiting_code' and new.state in ('processing', 'expired', 'cancelled'))
    or (old.state = 'processing' and new.state in ('awaiting_code', 'confirmed', 'rejected', 'expired', 'cancelled'))
  ) then
    raise exception 'identity_verification: illegal_expectation_transition' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger expectations_guard before update or delete on identity_verification.expectations
  for each row execute function identity_verification.guard_expectation();

-- Closing an expectation (any terminal state) erases every sealed code still pending for it.
create function identity_verification.erase_on_close() returns trigger language plpgsql as $$
begin
  if new.state in ('confirmed', 'rejected', 'expired', 'cancelled') and old.state not in ('confirmed', 'rejected', 'expired', 'cancelled') then
    update identity_verification.responses
       set state = 'cancelled', failure_code = 'expectation_closed',
           code_ciphertext = null, code_iv = null, code_tag = null, key_id = null,
           lease_owner = null, lease_expires_at = null
     where expectation_id = new.expectation_id and state in ('pending', 'dispatching');
  end if;
  return null;
end $$;

create trigger expectations_erase_on_close after update on identity_verification.expectations
  for each row execute function identity_verification.erase_on_close();

-- ── Responses: capture only under a live expectation; state machine; sealed material is write-once ──
create function identity_verification.guard_response() returns trigger language plpgsql as $$
declare
  owner_state text;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'pending' then
      raise exception 'identity_verification: response_must_start_pending' using errcode = 'P0001';
    end if;
    select state into owner_state from identity_verification.expectations where expectation_id = new.expectation_id for share;
    if owner_state is null or owner_state not in ('created', 'awaiting_code', 'processing') then
      raise exception 'identity_verification: expectation_not_live' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.state not in ('notified', 'cancelled', 'failed', 'expired') then
      raise exception 'identity_verification: response_not_terminal' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.state in ('notified', 'cancelled', 'failed', 'expired') then
    raise exception 'identity_verification: response_terminal_immutable' using errcode = 'P0001';
  end if;
  if new.response_id <> old.response_id or new.expectation_id <> old.expectation_id or new.channel <> old.channel
     or new.provider_event_id <> old.provider_event_id or new.received_seq <> old.received_seq
     or new.confirm_idempotency_key <> old.confirm_idempotency_key or new.received_at <> old.received_at
     or new.deadline_at <> old.deadline_at or new.purge_after <> old.purge_after then
    raise exception 'identity_verification: response_identity_immutable' using errcode = 'P0001';
  end if;
  if new.code_ciphertext is not null and (new.code_ciphertext is distinct from old.code_ciphertext
       or new.code_iv is distinct from old.code_iv or new.code_tag is distinct from old.code_tag or new.key_id is distinct from old.key_id) then
    raise exception 'identity_verification: sealed_code_write_once' using errcode = 'P0001';
  end if;
  if new.lease_generation < old.lease_generation then
    raise exception 'identity_verification: lease_generation_cannot_decrease' using errcode = 'P0001';
  end if;
  if new.state <> old.state and not (
       (old.state = 'pending' and new.state in ('dispatching', 'cancelled', 'expired', 'failed'))
    or (old.state = 'dispatching' and new.state in ('pending', 'resolved', 'cancelled', 'expired', 'failed'))
    or (old.state = 'resolved' and new.state = 'notified')
  ) then
    raise exception 'identity_verification: illegal_response_transition' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger responses_guard before insert or update or delete on identity_verification.responses
  for each row execute function identity_verification.guard_response();
