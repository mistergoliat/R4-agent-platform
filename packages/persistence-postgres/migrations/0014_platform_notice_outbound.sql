-- Platform notices.
-- A platform notice is a fixed message an agent pack renders from a domain
-- owner's validated structured answer (for example a link the owner
-- returned), never from model output. It is delivered by the same single delivery owner
-- as every other outbound, under the same gates as agent output (kill
-- switch, deny list, rollout, human ownership, terminal task, age, window).
-- Identity: one notice per (task, notice_key); a repeated request with the
-- same key and the same text is a replay, never a second message.
-- A platform row is now either an ADR-041 fallback (human_request_id) or a
-- notice (notice_key), never both and never neither.
alter table outbound_messages add column notice_key text check (notice_key is null or notice_key ~ '^[a-z][a-z0-9._:-]{2,199}$');
alter table outbound_messages drop constraint outbound_messages_platform_fallback;
alter table outbound_messages
  add constraint outbound_messages_platform_origin
  check ((origin = 'platform') = (body is not null and response_step_id is null and human_ref is null and ((human_request_id is not null) <> (notice_key is not null))));
create unique index outbound_messages_platform_notice_key on outbound_messages (task_id, notice_key) where notice_key is not null;
