-- Additive reporting only. Apply explicitly after a schema backup; never via server startup.
BEGIN;
CREATE TABLE IF NOT EXISTS sdr_message_facts (
  provider text NOT NULL,
  provider_message_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('out','in')),
  mailbox_email text NOT NULL,
  prospect_email text NOT NULL,
  campaign_id text,
  thread_id text,
  reply_to_id text,
  source_key text NOT NULL DEFAULT 'unknown',
  sequence_step integer,
  occurred_at timestamptz,
  provider_status text,
  human_reply boolean,
  reply_intent text,
  bounce boolean NOT NULL DEFAULT false,
  spam_blocked boolean NOT NULL DEFAULT false,
  pipedrive_lead_id text,
  link_status text NOT NULL CHECK (link_status IN ('verified','ambiguous','unmatched')),
  link_evidence text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_message_id)
);
CREATE INDEX IF NOT EXISTS sdr_message_window_idx ON sdr_message_facts (mailbox_email, occurred_at);
CREATE INDEX IF NOT EXISTS sdr_message_project_idx ON sdr_message_facts (pipedrive_lead_id, occurred_at);
CREATE TABLE IF NOT EXISTS sdr_deal_facts (
  pipedrive_deal_id text PRIMARY KEY,
  pipedrive_lead_id text,
  link_status text NOT NULL DEFAULT 'unmatched' CHECK (link_status IN ('verified','ambiguous','unmatched')),
  link_evidence text,
  source text,
  currency text NOT NULL,
  value numeric,
  status text NOT NULL,
  qualified_quote boolean,
  quote_created_at timestamptz,
  won_at timestamptz,
  lost_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sdr_deal_window_idx ON sdr_deal_facts (won_at);
CREATE TABLE IF NOT EXISTS sdr_job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job text NOT NULL,
  scope text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','complete','partial','failed','skipped')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}',
  cursor jsonb NOT NULL DEFAULT '{}',
  error_category text,
  next_retry_at timestamptz
);
CREATE INDEX IF NOT EXISTS sdr_reporting_job_idx ON sdr_job_runs (job, scope, finished_at DESC);
COMMIT;
