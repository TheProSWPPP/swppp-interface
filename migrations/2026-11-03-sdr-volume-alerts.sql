-- Explicit release migration (additive, idempotent). Apply before SDR_VOLUME_ALERTS_ENABLED=true.
-- One row per mailbox, day and alert kind (lib/sdrVolumeWatch.js). The unique key makes
-- reruns and restarts idempotent: a dip is recorded and notified once.
BEGIN;
CREATE TABLE IF NOT EXISTS sdr_volume_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_email text NOT NULL,
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('volume_dip','stalled_today','cap_lowered','facts_stale')),
  sent integer NOT NULL,
  baseline numeric NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  notified_at timestamptz,
  resolved_at timestamptz,
  notify_receipt jsonb,
  UNIQUE(mailbox_email, day, kind)
);
ALTER TABLE sdr_volume_alerts ADD COLUMN IF NOT EXISTS notify_receipt jsonb;
CREATE INDEX IF NOT EXISTS idx_sdr_volume_alerts_open ON sdr_volume_alerts(created_at) WHERE resolved_at IS NULL;
COMMIT;
