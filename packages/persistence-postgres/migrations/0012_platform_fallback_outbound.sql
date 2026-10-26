-- R4-J5 P0 / ADR-041 — platform fallback outbound after a run-failure handoff.
-- When ADR-028 recovery is exhausted (or a model failure is not retryable) the
-- task is handed to a human. Without a notice the contact is left unanswered.
-- The delivery owner now queues ONE platform outbound per such handoff: the
-- agent pack's fixed text (never model output), tied to the handoff request.
alter table outbound_messages drop constraint outbound_messages_origin_check;
alter table outbound_messages add constraint outbound_messages_origin_check check (origin in ('agent', 'operator', 'platform'));
alter table outbound_messages add column handoff_request_id uuid unique references human_requests (request_id);
alter table outbound_messages
  add constraint outbound_messages_platform_fallback
  check ((origin = 'platform') = (handoff_request_id is not null and body is not null and response_step_id is null and human_ref is null));
