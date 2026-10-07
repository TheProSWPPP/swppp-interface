-- Read-only source collection state. Apply before enabling the separate collector.
BEGIN;
ALTER TABLE sdr_conversation_messages ADD COLUMN IF NOT EXISTS source_evidence jsonb NOT NULL DEFAULT '[]';
UPDATE sdr_conversation_messages SET source_evidence=jsonb_build_array(jsonb_build_object(
  'leadId',pipedrive_lead_id,'dealId',pipedrive_deal_id,'personId',person_id,'threadId',provider_thread_id,'evidence',link_evidence))
WHERE source_evidence='[]'::jsonb;
CREATE TABLE IF NOT EXISTS sdr_conversation_sync_state (
  provider text NOT NULL,account_key text NOT NULL,scope text NOT NULL,
  state jsonb NOT NULL DEFAULT '{}',status text NOT NULL DEFAULT 'partial',
  counts jsonb NOT NULL DEFAULT '{}',error_category text,checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,account_key,scope),CHECK(status IN ('complete','partial','error'))
);
CREATE TABLE IF NOT EXISTS sdr_conversation_sync_threads (
  provider text NOT NULL,account_key text NOT NULL,thread_id text NOT NULL,
  fingerprint text NOT NULL,completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,account_key,thread_id)
);
COMMIT;
