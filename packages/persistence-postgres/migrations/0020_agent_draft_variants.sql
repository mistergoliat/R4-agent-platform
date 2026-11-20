-- ADR-054 revision 2 (W2a): a draft can be a VARIANT of the agent it derives from (same agent id, a version
-- candidate), and an agent can have several open variants at once, each with its own label ("B · más breve").
--
-- Additive: one nullable column; the "one open draft per agent" index becomes "one open draft per agent and label".
-- Existing rows keep label = null, which still allows at most one open unlabeled draft per agent.
alter table agent_drafts add column label text check (label is null or length(label) between 1 and 60);

drop index agent_drafts_open_agent;
create unique index agent_drafts_open_agent_label on agent_drafts (agent_id, coalesce(label, '')) where state in ('draft', 'ready');
