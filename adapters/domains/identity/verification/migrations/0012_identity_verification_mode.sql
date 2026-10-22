-- R4-J4 SEC-S3 (R4-J4-SEC-OTP-ACCELERATED-IMPLEMENTATION-06): the durable mode of the identity
-- verification component (decision rev. 02 §9.2), written by the gateway composition at start.
--   full          start, capture, confirmation and redaction;
--   protect_only  redaction only: no capture, no confirmation, no new start (the start capability
--                 reads this row in the worker, which never holds the gateway's keys).
-- There is no `absent` row: removing the inspector is a composition without it, allowed only while
-- no protection window is open (the gateway guard). There is no override.

create table identity_verification.component_mode (
  singleton  boolean primary key default true check (singleton),
  mode       text not null check (mode in ('full', 'protect_only')),
  changed_by text not null check (changed_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  reason     text not null check (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  changed_at timestamptz not null default clock_timestamp()
);
