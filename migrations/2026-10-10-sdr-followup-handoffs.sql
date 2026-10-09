-- Explicit human publication only. No queue, trigger or historical replay.
CREATE TABLE IF NOT EXISTS sdr_followup_handoffs (
 id uuid PRIMARY KEY, company_id text NOT NULL, lead_id text NOT NULL,
 author_id uuid NOT NULL REFERENCES sdr_users(id), revision integer NOT NULL,
 context_token text NOT NULL, live_hash text NOT NULL, content text NOT NULL,
 evidence jsonb NOT NULL, reviewed_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','uncertain','confirmed','not_attempted')),
 provider_note_id text, readback_verified boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,lead_id,author_id,revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS sdr_followup_handoff_unresolved
 ON sdr_followup_handoffs(company_id,lead_id) WHERE status IN ('reserved','uncertain');
