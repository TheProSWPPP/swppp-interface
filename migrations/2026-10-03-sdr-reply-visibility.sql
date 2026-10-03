-- Explicit additive release migration; never execute during server startup.
-- Volatile default backfills existing rows with this migration's transaction ID.
-- This can rewrite the table under an exclusive lock; stage after backup.
-- It establishes visibility from migration onward, not historical commit timing.
-- Preserve ingestion_xid and durable membership fields on every later update.
BEGIN;
ALTER TABLE sdr_reply_messages
 ADD COLUMN IF NOT EXISTS ingestion_xid xid8 NOT NULL DEFAULT pg_current_xact_id();
COMMIT;
