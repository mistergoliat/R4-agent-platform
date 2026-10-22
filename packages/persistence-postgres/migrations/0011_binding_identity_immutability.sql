-- R4-J4 RR-1 R-4 (ADR-038; R4_J4_RR1_BINDING_RACE_ANALYSIS.md §8 R-4).
-- The identity of a conversation binding is frozen: channel, conversation_key,
-- account_ref and recipient_ref never change, and task_id is assigned at most
-- once (null → value; re-setting the same value is a no-op). No code changes
-- them today; this makes it unrepresentable. Precondition of the confirm
-- idempotency of SEC-OTP (plan §4.4).
-- Every other column (status, closed_at, closed_reason, last_inbound_at, ...)
-- keeps its current rules. binding_id and DELETE are outside this contract.
-- No data is rewritten: existing open and closed bindings stay as they are.
create function channel_conversation_bindings_identity_immutable() returns trigger language plpgsql as $$
begin
  if new.channel is distinct from old.channel then raise exception 'conversation binding % identity is immutable (channel)', old.binding_id using errcode = '55000'; end if;
  if new.conversation_key is distinct from old.conversation_key then raise exception 'conversation binding % identity is immutable (conversation_key)', old.binding_id using errcode = '55000'; end if;
  if new.account_ref is distinct from old.account_ref then raise exception 'conversation binding % identity is immutable (account_ref)', old.binding_id using errcode = '55000'; end if;
  if new.recipient_ref is distinct from old.recipient_ref then raise exception 'conversation binding % identity is immutable (recipient_ref)', old.binding_id using errcode = '55000'; end if;
  if old.task_id is not null and new.task_id is distinct from old.task_id then raise exception 'conversation binding % identity is immutable (task_id is assigned once)', old.binding_id using errcode = '55000'; end if;
  return new;
end $$;

create trigger channel_conversation_bindings_identity_immutable
  before update on channel_conversation_bindings
  for each row execute function channel_conversation_bindings_identity_immutable();
