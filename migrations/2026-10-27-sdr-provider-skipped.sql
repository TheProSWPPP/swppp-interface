-- Apollo answered an add with the contact under skipped_contact_ids: no membership was created.
-- Such a reservation is closed as 'provider_skipped' instead of staying 'reserved' for good,
-- which the membership guard read as an enrollment needing review.
ALTER TABLE sdr_provider_operations DROP CONSTRAINT IF EXISTS sdr_provider_operations_state_check;
ALTER TABLE sdr_provider_operations ADD CONSTRAINT sdr_provider_operations_state_check
  CHECK (state IN ('reserved','unresolved','confirmed','superseded','protected_external_state','pre_add_refused','provider_skipped'));
