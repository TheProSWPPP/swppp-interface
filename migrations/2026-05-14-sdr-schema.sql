-- Phase 3 — Custom SDR Interface
-- Apollo-driven outbound, custom React/Express interface, JWT auth.
-- Hybrid coexistence with existing Pipedrive sequences; per red-team fixes:
-- snapshot contact identity on draft creation; advisory locks on draft->send
-- transitions; engagement events logged for audit.

CREATE TABLE IF NOT EXISTS sdr_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'sdr' CHECK (role IN ('sdr','admin')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sdr_mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  apollo_mailbox_id TEXT UNIQUE,
  owner_user_id UUID REFERENCES sdr_users(id) ON DELETE SET NULL,
  pipedrive_sender_id INT,
  daily_send_limit INT NOT NULL DEFAULT 20,
  warmup_started_at TIMESTAMPTZ,
  warmup_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (warmup_status IN ('pending','warming','ready','paused','disabled')),
  warmup_current_cap INT NOT NULL DEFAULT 0,
  deliverability_score NUMERIC(5,2),
  last_health_check_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sdr_mailboxes_warmup_status ON sdr_mailboxes(warmup_status);
CREATE INDEX IF NOT EXISTS idx_sdr_mailboxes_owner ON sdr_mailboxes(owner_user_id);

CREATE TABLE IF NOT EXISTS sdr_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipedrive_lead_id TEXT NOT NULL,
  pipedrive_contact_id TEXT,
  pipedrive_org_id TEXT,
  contact_id_snapshot TEXT NOT NULL,
  contact_email_snapshot TEXT NOT NULL,
  org_id_snapshot TEXT,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('AGC','LBA','CM','PB')),
  apollo_sequence_id TEXT,
  apollo_template_id TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  assigned_mailbox_id UUID REFERENCES sdr_mailboxes(id) ON DELETE SET NULL,
  assigned_user_id UUID REFERENCES sdr_users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','edited','rejected','sent','failed','cancelled')),
  reject_reason TEXT,
  scheduled_for TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES sdr_users(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sdr_drafts_status ON sdr_drafts(status);
CREATE INDEX IF NOT EXISTS idx_sdr_drafts_lead ON sdr_drafts(pipedrive_lead_id);
CREATE INDEX IF NOT EXISTS idx_sdr_drafts_mailbox ON sdr_drafts(assigned_mailbox_id);
CREATE INDEX IF NOT EXISTS idx_sdr_drafts_scheduled ON sdr_drafts(scheduled_for) WHERE status IN ('pending','approved');

CREATE TABLE IF NOT EXISTS sdr_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL REFERENCES sdr_drafts(id) ON DELETE CASCADE,
  pipedrive_lead_id TEXT NOT NULL,
  apollo_sequence_id TEXT NOT NULL,
  apollo_contact_id TEXT,
  apollo_emailer_message_id TEXT,
  mailbox_id UUID REFERENCES sdr_mailboxes(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'enrolled'
    CHECK (status IN ('enrolled','sent','bounced','replied','unsubscribed','failed')),
  last_status_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sdr_sends_lead ON sdr_sends(pipedrive_lead_id);
CREATE INDEX IF NOT EXISTS idx_sdr_sends_sequence ON sdr_sends(apollo_sequence_id);
CREATE INDEX IF NOT EXISTS idx_sdr_sends_status ON sdr_sends(status);

CREATE TABLE IF NOT EXISTS sdr_engagement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'apollo' CHECK (source IN ('apollo','pipedrive')),
  event_type TEXT NOT NULL,
  apollo_event_id TEXT UNIQUE,
  apollo_sequence_id TEXT,
  apollo_emailer_message_id TEXT,
  pipedrive_lead_id TEXT,
  pipedrive_contact_id TEXT,
  mailbox_email TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  process_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (process_status IN ('pending','processed','skipped','error')),
  process_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sdr_events_lead_time ON sdr_engagement_events(pipedrive_lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sdr_events_type ON sdr_engagement_events(event_type);
CREATE INDEX IF NOT EXISTS idx_sdr_events_process_status ON sdr_engagement_events(process_status);
CREATE INDEX IF NOT EXISTS idx_sdr_events_sequence ON sdr_engagement_events(apollo_sequence_id);

-- Migration log for hybrid coexistence audit (Task 22)
CREATE TABLE IF NOT EXISTS sdr_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipedrive_lead_id TEXT NOT NULL,
  from_system TEXT NOT NULL CHECK (from_system IN ('pipedrive','apollo','none')),
  to_system TEXT NOT NULL CHECK (to_system IN ('pipedrive','apollo','none')),
  reason TEXT,
  triggered_by UUID REFERENCES sdr_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sdr_migrations_lead ON sdr_migrations(pipedrive_lead_id);
