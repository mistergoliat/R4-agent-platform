-- ADR-057 Decision 3: whether the contact is in the conversation right now (the web chat open) or away since when.
-- A channel that can tell (today only the web edge) reports it; the others leave it null. Additive and updatable:
-- presence is not identity (0011 guards only the identity columns).
alter table channel_conversation_bindings
  add column presence text check (presence is null or presence in ('present', 'away')),
  add column presence_at timestamptz,
  add constraint channel_conversation_bindings_presence_pair check ((presence is null) = (presence_at is null));
