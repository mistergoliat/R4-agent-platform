-- Inbound multimodal v1 (images and voice notes).
-- A `media` inbound keeps, while it is unsettled, only the provider's REFERENCE to the file (id, declared type, hash,
-- caption) and then the framed text perceived from it; both are cleared at settlement like any inbound content.
-- No bytes are ever stored: the file is downloaded and perceived in memory and dropped.
alter table inbound_events drop constraint inbound_events_content_kind_check;
alter table inbound_events add constraint inbound_events_content_kind_check check (content_kind in ('text', 'unsupported', 'media', 'rejected'));
