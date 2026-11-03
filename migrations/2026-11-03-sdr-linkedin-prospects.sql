-- Additive LinkedIn prospect lanes (Derek, 2026-11-03). Apply after 2026-10-16 and 2026-10-26.
-- Nothing here sends: every new path is behind its own SDR_LINKEDIN_* switch, default off.
-- sdr_linkedin_actions.step gains the values 'inmail' and 'withdraw'; the column has no CHECK,
-- and UNIQUE(company_id,account_id,person_id,step) keeps each step to once per person.
ALTER TABLE sdr_linkedin_candidates
  ADD COLUMN IF NOT EXISTS lane text CHECK (lane IN ('A','B','C','D')),
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS title_rank smallint,
  ADD COLUMN IF NOT EXISTS active_30d boolean,
  ADD COLUMN IF NOT EXISTS role_started_on date,
  ADD COLUMN IF NOT EXISTS company_key text,
  ADD COLUMN IF NOT EXISTS resolved_email text,
  ADD COLUMN IF NOT EXISTS old_customer_id uuid;
CREATE INDEX IF NOT EXISTS sdr_linkedin_candidates_queue ON sdr_linkedin_candidates(company_id,account_id,priority,created_at)
  WHERE state IN ('reviewed','invite_sent','relation_observed','dm1_sent','followup_due');
CREATE INDEX IF NOT EXISTS sdr_linkedin_candidates_profile ON sdr_linkedin_candidates(company_id,account_id,profile_url);

ALTER TABLE sdr_linkedin_accounts
  ADD COLUMN IF NOT EXISTS ramp_started_on date,
  ADD COLUMN IF NOT EXISTS inmail_balance integer,
  ADD COLUMN IF NOT EXISTS inmail_balance_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS search_budget_day text,
  ADD COLUMN IF NOT EXISTS search_used integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sdr_linkedin_old_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id text NOT NULL, import_id uuid NOT NULL,
  full_name text NOT NULL, first_name text, last_name text, company text NOT NULL, company_key text NOT NULL,
  email text, linkedin_url text,
  status text NOT NULL DEFAULT 'imported' CHECK (status IN ('imported','moved','same_company','not_found','ambiguous','error')),
  current_company text, current_company_key text, current_title text, provider_hint text,
  checked_at timestamptz, evidence jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS sdr_linkedin_old_customers_once
  ON sdr_linkedin_old_customers(company_id, lower(full_name), company_key);

CREATE TABLE IF NOT EXISTS sdr_linkedin_search_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id text NOT NULL, lane text NOT NULL,
  source text NOT NULL CHECK (source IN ('apify','unipile_salesnav')), query jsonb NOT NULL,
  state text NOT NULL DEFAULT 'running', items integer, staged integer, skipped jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz);

CREATE TABLE IF NOT EXISTS sdr_linkedin_reply_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id text NOT NULL, account_id text NOT NULL,
  candidate_id uuid NOT NULL, source_message_id text NOT NULL, chat_id text, thread_url text,
  reply_text text NOT NULL, suggested_answer text, lane text,
  -- pending: email not sent yet; sent: emailed, reminders to come; reminded: both reminders sent,
  -- still unanswered (terminal for the drain); answered, dismissed, failed.
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','reminded','answered','dismissed','failed')),
  sent_at timestamptz, gmail_message_id text, reminder1_sent_at timestamptz, reminder3_sent_at timestamptz,
  next_reminder_at timestamptz, message_ids text[] NOT NULL DEFAULT '{}'::text[],
  answered_at timestamptz, answered_by text, failure_reason text,
  attempted_at timestamptz, reminder1_attempted_at timestamptz, reminder3_attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,account_id,source_message_id));
-- One open alert per person: a second message while it is open is appended to it, never a new email.
CREATE UNIQUE INDEX IF NOT EXISTS sdr_linkedin_reply_alerts_open
  ON sdr_linkedin_reply_alerts(company_id,account_id,candidate_id) WHERE state IN ('pending','sent');
CREATE INDEX IF NOT EXISTS sdr_linkedin_reply_alerts_due
  ON sdr_linkedin_reply_alerts(company_id,account_id,next_reminder_at) WHERE state='sent';
