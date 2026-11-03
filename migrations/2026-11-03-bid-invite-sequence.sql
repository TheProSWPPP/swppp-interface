-- Bid invite follow-up sequence (lib/bidInviteEngine.js). Additive and idempotent.
-- Explicit release migration: apply by hand after a schema backup, never from server startup.
-- Until it is applied the engine does nothing in live mode, and dry runs treat every lead as new.
-- bid_followup_marks (the old before-bid clock) is kept: lib/followupOutcomeReadout.js reads it.
BEGIN;

CREATE TABLE IF NOT EXISTS bid_invite_leads (
  pipedrive_lead_id text PRIMARY KEY,
  contact_email text,                 -- lower(btrim()), the address we will send to
  pipedrive_person_id text,
  bid_date date,
  short_name text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),   -- "upload" time for the Email 1 rule
  batch_id uuid,
  state text NOT NULL DEFAULT 'waiting'
    CHECK (state IN ('waiting','batched','held','replied','stopped','done')),
  hold_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bid_invite_leads_contact ON bid_invite_leads(contact_email, state);

CREATE TABLE IF NOT EXISTS bid_invite_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_email text NOT NULL,
  pipedrive_person_id text,
  pipedrive_org_id text,
  lead_ids text[] NOT NULL,            -- every lead this batch covers
  named_lead_ids text[] NOT NULL,      -- up to 3, newest bid first
  names text[] NOT NULL,               -- their short names, same order
  anchor_bid_date date NOT NULL,       -- newest bid date in the batch
  customer boolean NOT NULL,
  customer_reason text,
  owner_user_id text,                  -- Pipedrive owner of the organization (else the lead)
  mailbox_id uuid REFERENCES sdr_mailboxes(id),
  sender_reason text CHECK (sender_reason IN ('customer_owner','rotation')),
  timezone text NOT NULL DEFAULT 'America/Chicago',
  next_step text CHECK (next_step IN ('e1','e2','e3')),   -- NULL when finished
  next_due_at timestamptz,
  gmail_thread_id text,
  first_rfc_message_id text,
  first_subject text,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','held','replied','bounced','stopped','finished')),
  hold_reason text,
  stop_reason text,
  send_failures int NOT NULL DEFAULT 0,
  owner_task_activity_id text,
  owner_task_due date,
  owner_task_attempts int NOT NULL DEFAULT 0,
  owner_task_error text,
  reply_checked_at timestamptz,        -- last reply check that read Gmail/Pipedrive (bounded per run)
  paused_at timestamptz,               -- the contact wrote to a rep (not to us): next email held back
  pause_reason text,
  reply_detected_at timestamptz,
  reply_source text,
  reply_handled_at timestamptz,
  reply_task_activity_id text,
  reply_task_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bid_invite_batches_due ON bid_invite_batches(state, next_due_at);
CREATE INDEX IF NOT EXISTS bid_invite_batches_contact ON bid_invite_batches(contact_email);

CREATE TABLE IF NOT EXISTS bid_invite_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES bid_invite_batches(id),
  step text NOT NULL CHECK (step IN ('e1','e2','e3')),
  mailbox_id uuid NOT NULL REFERENCES sdr_mailboxes(id),
  recipient_email text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  rfc_message_id text NOT NULL,        -- we set it: <bid-{id}@proswppp.co>
  status text NOT NULL CHECK (status IN ('claimed','sent','failed','uncertain')),
  gmail_message_id text,
  gmail_thread_id text,
  error text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (batch_id, step)
);
CREATE INDEX IF NOT EXISTS bid_invite_sends_mailbox_day ON bid_invite_sends(mailbox_id, sent_at);
CREATE INDEX IF NOT EXISTS bid_invite_sends_recipient ON bid_invite_sends(lower(recipient_email), sent_at);

COMMIT;
