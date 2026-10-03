-- Opt-in local recovery receipts; no historical pending-draft adoption or external writes.
CREATE TABLE IF NOT EXISTS sdr_enrollment_attempts (
  draft_id uuid PRIMARY KEY REFERENCES sdr_drafts(id),
  origin text NOT NULL CHECK (origin IN ('auto','auto-switch')),
  status text NOT NULL CHECK (status IN ('pending','running','accepted','review','exhausted')),
  category text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 5),
  first_attempt_at timestamptz NOT NULL,
  last_attempt_at timestamptz NOT NULL,
  next_retry_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_receipt_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sdr_enrollment_retry_due ON sdr_enrollment_attempts(next_retry_at)
  WHERE status='pending';
