-- R4-J4 RR-1 R-4 (ADR-038; R4_J4_RR1_BINDING_RACE_ANALYSIS.md §8 R-4; owner decisions of
-- R4-J4-R5-OWNER-REVIEW-AND-MERGE-11). The identity of a conversation binding is frozen from INSERT:
-- binding_id, channel, conversation_key, account_ref, recipient_ref and created_at never change, and
-- task_id is assigned at most once (null → value; re-setting the same value is a no-op; never back to
-- null). Precondition of the confirm idempotency of SEC-OTP (plan §4.4).
-- The lifecycle only moves forward: open → closed once (closed_at and closed_reason are written by
-- that closure and are final), closed_reason is never set on an open binding, and last_inbound_at
-- never moves back nor returns to null.
-- An ordinary DELETE is refused: a historical purge needs its own approved D7 policy. TRUNCATE is not
-- a row operation; it stays reserved to the verified purge of the isolated synthetic canary (D7 of the
-- canary, owner decision 2026-10-22), which refuses any database that is not that canary.
-- The cohort columns (autonomy, eligibility_reason, rollout_fingerprint, profile*) keep their rules.
-- No data is rewritten: existing open and closed bindings stay as they are.
create function channel_conversation_bindings_identity_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'conversation binding % cannot be deleted (a historical purge needs an approved D7 policy)', old.binding_id using errcode = '55000'; end if;
  if new.binding_id is distinct from old.binding_id then raise exception 'conversation binding % identity is immutable (binding_id)', old.binding_id using errcode = '55000'; end if;
  if new.channel is distinct from old.channel then raise exception 'conversation binding % identity is immutable (channel)', old.binding_id using errcode = '55000'; end if;
  if new.conversation_key is distinct from old.conversation_key then raise exception 'conversation binding % identity is immutable (conversation_key)', old.binding_id using errcode = '55000'; end if;
  if new.account_ref is distinct from old.account_ref then raise exception 'conversation binding % identity is immutable (account_ref)', old.binding_id using errcode = '55000'; end if;
  if new.recipient_ref is distinct from old.recipient_ref then raise exception 'conversation binding % identity is immutable (recipient_ref)', old.binding_id using errcode = '55000'; end if;
  if new.created_at is distinct from old.created_at then raise exception 'conversation binding % identity is immutable (created_at)', old.binding_id using errcode = '55000'; end if;
  if old.task_id is not null and new.task_id is distinct from old.task_id then raise exception 'conversation binding % identity is immutable (task_id is assigned once)', old.binding_id using errcode = '55000'; end if;
  if old.status = 'closed' and (new.status, new.closed_at, new.closed_reason) is distinct from (old.status, old.closed_at, old.closed_reason) then raise exception 'conversation binding % lifecycle is monotonic (closed is final)', old.binding_id using errcode = '55000'; end if;
  if new.status = 'open' and new.closed_reason is distinct from old.closed_reason then raise exception 'conversation binding % lifecycle is monotonic (closed_reason is set only by the closure)', old.binding_id using errcode = '55000'; end if;
  if old.last_inbound_at is not null and (new.last_inbound_at is null or new.last_inbound_at < old.last_inbound_at) then raise exception 'conversation binding % lifecycle is monotonic (last_inbound_at never moves back)', old.binding_id using errcode = '55000'; end if;
  return new;
end $$;

create trigger channel_conversation_bindings_identity_immutable
  before update or delete on channel_conversation_bindings
  for each row execute function channel_conversation_bindings_identity_immutable();
