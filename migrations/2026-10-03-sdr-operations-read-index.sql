-- Explicit additive read index; apply during the staged release, never on startup.
BEGIN;
CREATE INDEX IF NOT EXISTS idx_sdr_reply_messages_human_recent
 ON sdr_reply_messages(mailbox_email,received_at DESC,provider_message_id DESC)
 WHERE reply_kind='human';
COMMIT;
