-- Additive LinkedIn go-live state: one Pipedrive task per inbound LinkedIn reply, and an
-- audit row for every admin change to the account, campaigns and candidates.
CREATE TABLE IF NOT EXISTS sdr_linkedin_reply_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id text NOT NULL,account_id text NOT NULL,
 source_message_id text NOT NULL,candidate_id uuid NOT NULL,lead_id text NOT NULL,assignee_id text NOT NULL,
 marker text NOT NULL,state text NOT NULL DEFAULT 'pending',activity_id text,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 UNIQUE(company_id,account_id,source_message_id));
CREATE TABLE IF NOT EXISTS sdr_linkedin_admin_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id text NOT NULL,account_id text NOT NULL,
 actor text NOT NULL,action text NOT NULL,target_id text,detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS sdr_linkedin_admin_audit_time ON sdr_linkedin_admin_audit(company_id,account_id,created_at DESC);
