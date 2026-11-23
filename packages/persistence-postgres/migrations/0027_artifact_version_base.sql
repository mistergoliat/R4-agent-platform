-- ADR-058 Decision 9: signing can never drop what is already published, and an applied change can be undone.
-- * artifact_versions.base_version: the version this one was built on (null: imported, or built before this).
--   A version never signed whose base is no longer the current one cannot be signed (it must be rebuilt).
-- * artifact_versions.includes: the approved proposals this version contains. They become `applied` when the version
--   is SIGNED, not when it is built, so a built version nobody signs keeps nothing.
-- * `undone`: an applied change a person reverted. It keeps its fingerprint, so its source never applies it again.
-- Additive columns (existing rows stay null) and constraint changes; no row changes.
alter table artifact_versions add column base_version integer check (base_version is null or base_version >= 1);
alter table artifact_versions add column includes uuid[];

alter table artifact_proposals drop constraint artifact_proposals_state_check;
alter table artifact_proposals add constraint artifact_proposals_state_check check (state in ('proposed', 'approved', 'rejected', 'applied', 'resolved', 'undone'));
alter table artifact_proposals drop constraint artifact_proposals_check2;
alter table artifact_proposals add constraint artifact_proposals_applied_version_check check ((state in ('applied', 'undone')) = (applied_version is not null));
alter table artifact_proposals drop constraint artifact_proposals_check3;
alter table artifact_proposals add constraint artifact_proposals_applied_change_check check (state not in ('applied', 'undone') or change is not null);
drop index artifact_proposals_once;
create unique index artifact_proposals_once on artifact_proposals (kind, fingerprint) where state in ('proposed', 'approved', 'rejected', 'undone');

alter table artifact_proposal_events drop constraint artifact_proposal_events_from_state_check;
alter table artifact_proposal_events add constraint artifact_proposal_events_from_state_check check (from_state in ('proposed', 'approved', 'rejected', 'applied'));
alter table artifact_proposal_events drop constraint artifact_proposal_events_to_state_check;
alter table artifact_proposal_events add constraint artifact_proposal_events_to_state_check check (to_state in ('proposed', 'approved', 'rejected', 'applied', 'resolved', 'undone'));
