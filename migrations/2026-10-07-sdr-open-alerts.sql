-- Additive, unseeded delivery receipts. Deployment does not enable the drainer.
BEGIN;
ALTER TABLE sdr_engagement_events ADD COLUMN IF NOT EXISTS open_alert_eligible boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS sdr_open_alert_reviews (
 source_event_id text NOT NULL,
 pipedrive_lead_id text NOT NULL,
 reason text NOT NULL,
 reasons text[] NOT NULL,
 evidence jsonb NOT NULL,
 observations integer NOT NULL DEFAULT 1,
 first_observed_at timestamptz NOT NULL,
 last_observed_at timestamptz NOT NULL,
 resolved_at timestamptz,
 PRIMARY KEY(source_event_id,pipedrive_lead_id)
);
CREATE INDEX IF NOT EXISTS idx_sdr_open_alert_reviews_unresolved ON sdr_open_alert_reviews(last_observed_at) WHERE resolved_at IS NULL;
CREATE TABLE IF NOT EXISTS sdr_open_alerts (
 id uuid PRIMARY KEY,
 pipedrive_lead_id text NOT NULL UNIQUE,
 source_event_id text NOT NULL,
 occurred_at timestamptz NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sdr_open_alert_actions (
 id uuid PRIMARY KEY,
 alert_id uuid NOT NULL REFERENCES sdr_open_alerts(id),
 kind text NOT NULL CHECK(kind IN ('note','email')),
 payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','skipped')),
 attempts integer NOT NULL DEFAULT 0,
 retry_at timestamptz,
 requires_review boolean NOT NULL DEFAULT false,
 safe_error text,
 external_id text,
 receipt_at timestamptz,
 lease_token uuid,
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT NOW(),
 updated_at timestamptz NOT NULL DEFAULT NOW(),
 UNIQUE(alert_id,kind)
);
CREATE INDEX IF NOT EXISTS idx_sdr_open_alert_due ON sdr_open_alert_actions(status,retry_at);
COMMIT;
