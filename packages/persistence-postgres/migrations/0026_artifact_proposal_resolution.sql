-- ADR-058 G3 fix (owner feedback, 2026-11-23): a proposal follows what its source still finds.
-- * `resolved`: the source's latest run no longer finds it (what it reported was fixed). It closes
--   by itself; a later run that finds it again opens a new proposal.
-- * An informational proposal (no change) marked seen or rejected REOPENS when it is found again: the problem is still
--   there, so it must not be forgotten. A proposal with a change keeps the person's decision.
-- Constraint changes only; no row changes.
alter table artifact_proposals drop constraint artifact_proposals_state_check;
alter table artifact_proposals add constraint artifact_proposals_state_check check (state in ('proposed', 'approved', 'rejected', 'applied', 'resolved'));

alter table artifact_proposal_events drop constraint artifact_proposal_events_from_state_check;
alter table artifact_proposal_events add constraint artifact_proposal_events_from_state_check check (from_state in ('proposed', 'approved', 'rejected'));
alter table artifact_proposal_events drop constraint artifact_proposal_events_to_state_check;
alter table artifact_proposal_events add constraint artifact_proposal_events_to_state_check check (to_state in ('proposed', 'approved', 'rejected', 'applied', 'resolved'));
-- Reopening goes approved|rejected → proposed: only a creation has no previous state.
alter table artifact_proposal_events drop constraint artifact_proposal_events_check;
alter table artifact_proposal_events add constraint artifact_proposal_events_origin_check check (from_state is not null or to_state = 'proposed');
