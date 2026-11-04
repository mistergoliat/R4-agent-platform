-- R4-J4-R7-4 R-9: the earlier bindings of one channel conversation, newest first.
--
-- `ProductionStore.earlierConversationTurns` finds the earlier tasks of a conversation with
--   e.channel = cur.channel and e.conversation_key = cur.conversation_key and e.created_at < cur.created_at
--   order by e.created_at desc, e.binding_id desc limit maxTasks
-- No existing index covers closed bindings by conversation (`channel_conversation_bindings_one_open` is partial on
-- status = 'open'), so that lookup was a sequential scan whose cost grew with ALL bindings. With this index it is an
-- index range scan over the one conversation (measured in R4_R7_4_CROSS_TASK_CONTINUITY_REPORT.md §12).
--
-- Additive: no data, constraint or trigger changes; results are identical. Operational notes:
-- - The migrator runs each migration in a transaction, so this is a plain CREATE INDEX (not CONCURRENTLY): it holds a
--   SHARE lock on channel_conversation_bindings while it builds, which blocks writes to that table (reads continue).
--   Measured ~9 s for 540 000 bindings on a workstation; production volume is orders of magnitude smaller.
-- - Rollback of the code does not require removing it: earlier builds ignore an applied migration they do not ship.
--   Removing it is `drop index channel_conversation_bindings_conversation_history;` (the migration stays recorded).
create index channel_conversation_bindings_conversation_history
  on channel_conversation_bindings (channel, conversation_key, created_at desc);
