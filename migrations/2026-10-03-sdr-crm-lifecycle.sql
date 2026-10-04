-- Explicit release migration; never run from server bootstrap.
-- Take a database backup before applying, then enable SDR_CRM_LIFECYCLE_ENABLED.
BEGIN;
ALTER TABLE sdr_lead_state
  ADD COLUMN IF NOT EXISTS crm_status text NOT NULL DEFAULT 'unknown'
    CHECK (crm_status IN ('active','archived','missing','unknown')),
  ADD COLUMN IF NOT EXISTS crm_sync_generation uuid,
  ADD COLUMN IF NOT EXISTS crm_last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS crm_status_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_sdr_lead_state_crm_status ON sdr_lead_state(crm_status);
COMMIT;
