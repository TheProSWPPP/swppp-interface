-- Explicit additive migration. Apply during staged release, never at startup.
-- Existing reporting facts and reply/action tables keep their original keys.
BEGIN;
CREATE TABLE IF NOT EXISTS sdr_conversation_messages (
  provider text NOT NULL CHECK (provider IN ('gmail','pipedrive')),
  account_key text NOT NULL,
  provider_message_id text NOT NULL,
  provider_thread_id text,
  internet_message_id text,
  from_address text,
  to_addresses jsonb NOT NULL DEFAULT '[]',
  cc_addresses jsonb NOT NULL DEFAULT '[]',
  occurred_at timestamptz,
  direction text NOT NULL CHECK (direction IN ('in','out','unknown')),
  origin text NOT NULL DEFAULT 'Unknown' CHECK (origin IN ('Manual','Automatic','Unknown')),
  origin_evidence text,
  person_id text,
  pipedrive_lead_id text,
  pipedrive_deal_id text,
  link_evidence text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider,account_key,provider_message_id),
  CHECK (pipedrive_lead_id IS NULL OR link_evidence IS NOT NULL),
  CHECK (pipedrive_deal_id IS NULL OR link_evidence IS NOT NULL),
  CHECK (origin = 'Unknown' OR origin_evidence IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_sdr_conversation_person_time ON sdr_conversation_messages(person_id,occurred_at,provider_message_id);
CREATE INDEX IF NOT EXISTS idx_sdr_conversation_lead ON sdr_conversation_messages(pipedrive_lead_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_sdr_conversation_internet_id ON sdr_conversation_messages(internet_message_id) WHERE internet_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS sdr_conversation_events (
  provider text NOT NULL,
  account_key text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz,
  actor_id text,
  person_id text,
  pipedrive_lead_id text,
  pipedrive_deal_id text,
  status text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,account_key,provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_sdr_conversation_event_person ON sdr_conversation_events(person_id,occurred_at);
CREATE TABLE IF NOT EXISTS sdr_conversation_coverage (
  provider text NOT NULL,
  account_key text NOT NULL,
  scope text NOT NULL,
  status text NOT NULL CHECK(status IN ('complete','partial','error')),
  cursor text,
  pages integer NOT NULL DEFAULT 0,
  messages integer NOT NULL DEFAULT 0,
  error_category text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,account_key,scope)
);
COMMIT;
