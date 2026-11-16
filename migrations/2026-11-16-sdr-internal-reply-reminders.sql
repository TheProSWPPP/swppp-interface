-- Additive, internal notification records only. No CRM or customer-send writes.
CREATE TABLE IF NOT EXISTS sdr_internal_reply_reminder_checks (
 company_id text NOT NULL, task_id text NOT NULL, checked_at timestamptz NOT NULL,
 outcome text NOT NULL, PRIMARY KEY(company_id,task_id)
);
CREATE TABLE IF NOT EXISTS sdr_internal_reply_reminder_notices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id text NOT NULL,
 task_id text NOT NULL, action_id uuid NOT NULL, step text NOT NULL,
 local_day date NOT NULL, recipient text NOT NULL, owner_id bigint NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','sent','uncertain','cancelled')),
 context_hash text NOT NULL, message_id text NOT NULL UNIQUE, provider_id text,
 created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, reconciled_at timestamptz, safe_error text
);
CREATE UNIQUE INDEX IF NOT EXISTS sdr_internal_reminder_day ON sdr_internal_reply_reminder_notices(company_id,task_id,local_day) WHERE state<>'cancelled';
CREATE UNIQUE INDEX IF NOT EXISTS sdr_internal_reminder_step ON sdr_internal_reply_reminder_notices(company_id,task_id,step,recipient) WHERE state<>'cancelled';
