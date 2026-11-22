-- ADR-048 Decision 5: the contact sees who wrote a person's message («Joaquín»), not a generic team.
-- The name comes from R4's operator registry (ADR-050) for the signed operator, never from a request body.
-- Additive: one nullable column, only for operator-origin messages.
alter table outbound_messages add column author_name text
  check (author_name is null or (origin = 'operator' and length(author_name) between 1 and 60));
