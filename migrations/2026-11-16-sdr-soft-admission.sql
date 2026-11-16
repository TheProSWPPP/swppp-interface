-- Evidence and reservations before an uncertain-address enrollment. Never a send receipt.
BEGIN;
CREATE TABLE IF NOT EXISTS sdr_soft_enrollment_checks (
  draft_id uuid NOT NULL,
  draft_revision integer NOT NULL,
  sequence_id text NOT NULL,
  recipient_email text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT NOW(),
  evidence jsonb NOT NULL,
  PRIMARY KEY(draft_id,draft_revision)
);
CREATE INDEX IF NOT EXISTS idx_sdr_soft_checks_sequence ON sdr_soft_enrollment_checks(sequence_id,checked_at);
-- Read-only provider confirmations for legacy rows whose original attempt facts are missing.
-- These receipts never change historical send status or authorize replay.
CREATE TABLE IF NOT EXISTS sdr_soft_legacy_outcomes (
  send_id uuid PRIMARY KEY,
  sequence_id text NOT NULL,
  contact_id text NOT NULL,
  recipient_email text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT NOW(),
  outcome text NOT NULL CHECK (outcome IN ('absent','finished','failed')),
  evidence jsonb NOT NULL
);
ALTER TABLE sdr_volume_alerts DROP CONSTRAINT IF EXISTS sdr_volume_alerts_kind_check;
ALTER TABLE sdr_volume_alerts ADD CONSTRAINT sdr_volume_alerts_kind_check CHECK
 (kind IN ('volume_dip','stalled_today','cap_lowered','facts_stale','sequence_paused','sequence_unavailable','soft_batch_stalled'));
COMMIT;
