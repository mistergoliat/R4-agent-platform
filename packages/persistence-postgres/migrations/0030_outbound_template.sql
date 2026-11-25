-- ADR-055 C2b: a platform notice may be sent as a provider-approved message template (name, language, body parameters).
-- Only a notice carries one; `body` keeps what it says.
alter table outbound_messages add column template jsonb;
alter table outbound_messages add constraint outbound_messages_template_is_notice
  check (template is null or (origin = 'platform' and notice_key is not null and jsonb_typeof(template) = 'object'));
