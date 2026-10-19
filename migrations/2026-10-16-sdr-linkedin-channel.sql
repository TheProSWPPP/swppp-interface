-- Additive, inert LinkedIn state. No credential or automatic send trigger lives here.
CREATE TABLE IF NOT EXISTS sdr_linkedin_accounts (
 company_id text NOT NULL, account_id text NOT NULL, product text NOT NULL DEFAULT 'classic',
 sender_provider_id text, sender_profile_url text, status text NOT NULL DEFAULT 'unverified',
 status_observed_at timestamptz, mode text NOT NULL DEFAULT 'disabled', coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
 read_budget integer NOT NULL DEFAULT 0 CHECK(read_budget>=0),read_timezone text,
 sync_cursor jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(company_id,account_id));
CREATE TABLE IF NOT EXISTS sdr_linkedin_hosted_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id text NOT NULL, account_id text NOT NULL,
 name_hash text NOT NULL UNIQUE, requested_by text NOT NULL, status text NOT NULL DEFAULT 'pending',
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz);
CREATE TABLE IF NOT EXISTS sdr_linkedin_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id text NOT NULL, account_id text NOT NULL,
 revision integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'unapproved',
 cohort_digest text, approval_digest text, config jsonb NOT NULL DEFAULT '{}'::jsonb,
 approved_by text, approved_at timestamptz, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,account_id,id));
CREATE TABLE IF NOT EXISTS sdr_linkedin_candidates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id text NOT NULL,account_id text NOT NULL,
 source text NOT NULL,source_id text NOT NULL,source_observed_at timestamptz,profile_url text NOT NULL,
 segment text,territory text,firm text,role text,person_id text,organization_id text,owner_id text,pipedrive_owner_id text,
 provider_id text,product text,email_sequence_complete_at timestamptz,email_unanswered boolean,source_context jsonb NOT NULL DEFAULT '{}'::jsonb,revision integer NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'staged',campaign_id uuid,hold_reason text,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,account_id,source,source_id), UNIQUE(company_id,account_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS sdr_linkedin_active_person ON sdr_linkedin_candidates(company_id,account_id,person_id)
 WHERE person_id IS NOT NULL AND state NOT IN ('archived','completed_no_reply','opted_out');
CREATE TABLE IF NOT EXISTS sdr_linkedin_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id text NOT NULL,account_id text NOT NULL,candidate_id uuid NOT NULL,
 person_id text NOT NULL,organization_id text,owner_id text,lead_id text,verified_email text,apollo_contact_id text,evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 status text NOT NULL DEFAULT 'verified',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,account_id,candidate_id,lead_id,verified_email));
CREATE INDEX IF NOT EXISTS sdr_linkedin_links_email ON sdr_linkedin_links(lower(verified_email)) WHERE verified_email IS NOT NULL;
CREATE TABLE IF NOT EXISTS sdr_linkedin_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id text NOT NULL,account_id text NOT NULL,candidate_id uuid,
 person_id text,kind text NOT NULL,source text NOT NULL,source_event_id text,source_message_id text,provider_id text,
 chat_id text,direction text,source_at timestamptz,observed_at timestamptz NOT NULL DEFAULT now(),
 coverage text NOT NULL DEFAULT 'unknown',processed_at timestamptz,next_attempt_at timestamptz,attempt_count integer NOT NULL DEFAULT 0,payload_hash text NOT NULL,safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 UNIQUE(company_id,account_id,payload_hash));
CREATE UNIQUE INDEX IF NOT EXISTS sdr_linkedin_message_once ON sdr_linkedin_events(company_id,account_id,source_message_id) WHERE source_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS sdr_linkedin_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id text NOT NULL,account_id text NOT NULL,candidate_id uuid NOT NULL,
 person_id text NOT NULL,campaign_id uuid NOT NULL,campaign_revision integer NOT NULL,step text NOT NULL,
 operation_key text NOT NULL,due_at timestamptz NOT NULL,context_hash text NOT NULL,body text,
 state text NOT NULL DEFAULT 'pending',hold_reason text,fence integer NOT NULL DEFAULT 0,network_started_at timestamptz,
 request_hash text,provider_id text,provider_chat_id text,provider_receipt jsonb,
 reserved_at timestamptz,confirmed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,account_id,person_id,step),UNIQUE(company_id,account_id,operation_key));
CREATE INDEX IF NOT EXISTS sdr_linkedin_action_due ON sdr_linkedin_actions(company_id,account_id,due_at) WHERE state='pending';
CREATE TABLE IF NOT EXISTS sdr_linkedin_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id text NOT NULL,account_id text NOT NULL,candidate_id uuid NOT NULL,
 person_id text NOT NULL,chat_id text,source_message_id text NOT NULL,owner_id text NOT NULL,author_id text,
 revision integer NOT NULL DEFAULT 1,context_hash text NOT NULL,body text NOT NULL,state text NOT NULL DEFAULT 'unsent',
 handoff_receipt jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,account_id,source_message_id));
