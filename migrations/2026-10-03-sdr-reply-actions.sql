-- Explicit release migration. No seed recipients: mailbox ownership must be verified.
BEGIN;
CREATE TABLE IF NOT EXISTS sdr_reply_routes (
  mailbox_email text PRIMARY KEY,
  forward_to text NOT NULL,
  pipedrive_user_id bigint NOT NULL,
  verified_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS sdr_reply_messages (
  provider_message_id text PRIMARY KEY,
  source text NOT NULL,
  source_message_id text NOT NULL,
  thread_id text,
  mailbox_email text NOT NULL,
  received_at timestamptz NOT NULL,
  pipedrive_lead_id text,
  link_status text NOT NULL CHECK (link_status IN ('verified','ambiguous','unlinked')),
  link_evidence text,
  reply_kind text NOT NULL CHECK (reply_kind IN ('human','auto','bounce')),
  intent text,
  staff_response_at timestamptz,
  detected_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sdr_reply_messages_lead ON sdr_reply_messages(pipedrive_lead_id, received_at);
ALTER TABLE sdr_reply_messages ADD COLUMN IF NOT EXISTS link_evidence text;
CREATE TABLE IF NOT EXISTS sdr_reply_actions (
  id uuid PRIMARY KEY,
  provider_message_id text NOT NULL REFERENCES sdr_reply_messages(provider_message_id),
  mailbox_email text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('stop_sequence','forward','create_task','create_note','match_lead','clear_sequence_flag')),
  target_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz,
  requires_review boolean NOT NULL DEFAULT false,
  safe_error text,
  external_id text,
  external_assignee_id bigint,
  receipt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(provider_message_id,kind,target_key)
);
ALTER TABLE sdr_reply_actions DROP CONSTRAINT IF EXISTS sdr_reply_actions_kind_check;
ALTER TABLE sdr_reply_actions ADD CONSTRAINT sdr_reply_actions_kind_check
  CHECK(kind IN ('stop_sequence','forward','create_task','create_note','match_lead','clear_sequence_flag'));
CREATE INDEX IF NOT EXISTS idx_sdr_reply_actions_due ON sdr_reply_actions(status,retry_at) WHERE NOT requires_review;
CREATE TABLE IF NOT EXISTS sdr_inbox_watch_cursors (
  mailbox_email text PRIMARY KEY,
  enabled_since timestamptz NOT NULL,
  high_water_at timestamptz NOT NULL,
  last_message_id text,
  page_token text,
  scan_after timestamptz,
  scan_max_received_at timestamptz,
  scan_last_message_id text
);
COMMIT;
