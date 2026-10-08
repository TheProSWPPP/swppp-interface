-- Private writing workspace. No automation status or provider linkage.
CREATE TABLE IF NOT EXISTS sdr_followup_drafts (
 company_id text NOT NULL,
 lead_id text NOT NULL,
 author_id uuid NOT NULL REFERENCES sdr_users(id),
 subject text NOT NULL CHECK(length(subject)<=500),
 body text NOT NULL CHECK(length(trim(body))>0 AND length(body)<=20000),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 context_token text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,lead_id,author_id)
);
