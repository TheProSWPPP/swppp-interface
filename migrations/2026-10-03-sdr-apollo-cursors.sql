-- Additive, opt-in via SDR_APOLLO_RESUMABLE_ENABLED=true. No provider/buyer data bodies.
CREATE TABLE IF NOT EXISTS sdr_apollo_poll_state (
  scope text PRIMARY KEY,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Store a confirmed provider touch/enrollment receipt when present; never infer it.
ALTER TABLE sdr_sends ADD COLUMN IF NOT EXISTS apollo_enrollment_id text;
