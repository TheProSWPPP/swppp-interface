CREATE TABLE IF NOT EXISTS sdr_note_events (
 event_key text NOT NULL, lead_id text NOT NULL, evidence jsonb NOT NULL, content text NOT NULL,
 status text NOT NULL DEFAULT 'unresolved' CHECK(status IN ('unresolved','confirmed')),
 provider_note_id text, created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz,
 PRIMARY KEY(event_key,lead_id)
);
