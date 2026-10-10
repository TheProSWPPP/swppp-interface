-- Prospective SDR draft outcomes only. Legacy rows retain NULL enrollment_phase.
ALTER TABLE sdr_provider_operations ADD COLUMN IF NOT EXISTS enrollment_phase text;
ALTER TABLE sdr_provider_operations DROP CONSTRAINT IF EXISTS sdr_provider_operations_state_check;
ALTER TABLE sdr_provider_operations ADD CONSTRAINT sdr_provider_operations_state_check
  CHECK (state IN ('reserved','unresolved','confirmed','superseded','protected_external_state','pre_add_refused'));
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='sdr_provider_operations'::regclass AND conname='sdr_provider_operations_enrollment_phase_check') THEN
  ALTER TABLE sdr_provider_operations ADD CONSTRAINT sdr_provider_operations_enrollment_phase_check
    CHECK (enrollment_phase IS NULL OR enrollment_phase IN ('reserved','fields_started','fields_completed','add_started'));
 END IF;
END $$;
ALTER TABLE sdr_provider_operations DROP CONSTRAINT IF EXISTS sdr_provider_operations_pre_add_refused_check;
ALTER TABLE sdr_provider_operations ADD CONSTRAINT sdr_provider_operations_pre_add_refused_check
  CHECK (state <> 'pre_add_refused' OR (kind='enroll' AND lease_token IS NOT NULL AND enrollment_phase IS NOT NULL AND enrollment_phase IN ('reserved','fields_completed')
    AND draft_revision IS NOT NULL AND context_hash IS NOT NULL
    AND COALESCE(expected_membership->>'schemaVersion'='sdr_draft_v1',FALSE)
    AND NULLIF(expected_membership->>'draftId','') IS NOT NULL
    AND NULLIF(expected_membership->>'companyId','') IS NOT NULL
    AND NULLIF(expected_membership->>'draftRevision','') IS NOT NULL));
