-- Explicit release migration (additive, idempotent). Apply before setting SDR_REPLY_EXIT_MODE.
-- A human reply exits the person from EVERY sequence (lib/replyExit.js). The code checks for
-- this migration (from_email column + exit_person kind) and does nothing until it is applied.
BEGIN;
ALTER TABLE sdr_reply_actions DROP CONSTRAINT IF EXISTS sdr_reply_actions_kind_check;
ALTER TABLE sdr_reply_actions ADD CONSTRAINT sdr_reply_actions_kind_check
  CHECK(kind IN ('stop_sequence','forward','create_task','create_note','match_lead','clear_sequence_flag','exit_person'));

-- The 180-day recent-reply fence (lib/recentReply.js) reads the sender from here, so a reply
-- seen only by the current reply pipeline still blocks new cold outreach to that address.
ALTER TABLE sdr_reply_messages ADD COLUMN IF NOT EXISTS from_email text;
CREATE INDEX IF NOT EXISTS idx_sdr_reply_messages_from_email
  ON sdr_reply_messages(lower(from_email), received_at) WHERE reply_kind='human';
UPDATE sdr_reply_messages m SET from_email=a.from_email
  FROM (SELECT DISTINCT ON (provider_message_id) provider_message_id, lower(trim(payload->>'fromEmail')) AS from_email
        FROM sdr_reply_actions WHERE payload->>'fromEmail' IS NOT NULL ORDER BY provider_message_id, created_at) a
  WHERE a.provider_message_id=m.provider_message_id AND m.from_email IS NULL;

-- One row per exit_person action: who was exited, what was planned, what Apollo confirmed.
-- dry_run writes only this row (plan, no provider or local changes).
CREATE TABLE IF NOT EXISTS sdr_reply_exits (
  action_id uuid PRIMARY KEY,
  provider_message_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('dry_run','live')),
  identities jsonb NOT NULL DEFAULT '{}',
  plan jsonb NOT NULL DEFAULT '{}',
  outcome jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sdr_reply_exits_message ON sdr_reply_exits(provider_message_id);
COMMIT;
