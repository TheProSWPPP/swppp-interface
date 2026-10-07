-- Additive: historical origin and approvals are deliberately not inferred.
ALTER TABLE sdr_drafts ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
ALTER TABLE sdr_drafts ADD COLUMN IF NOT EXISTS content_origin text NOT NULL DEFAULT 'unknown';
CREATE TABLE IF NOT EXISTS sdr_draft_approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid NOT NULL REFERENCES sdr_drafts(id),
 revision bigint NOT NULL, context_hash text NOT NULL, subject text NOT NULL, body text NOT NULL,
 context jsonb NOT NULL, actor jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sdr_draft_approvals_version ON sdr_draft_approvals(draft_id,revision);
CREATE OR REPLACE FUNCTION sdr_protect_draft_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.sent_at IS NOT NULL OR OLD.status='sent' OR EXISTS(SELECT 1 FROM sdr_sends WHERE draft_id=OLD.id) THEN
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Sent draft is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-'revision'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'revision'-'updated_at') THEN
  NEW.revision=OLD.revision+1;
 ELSE NEW.revision=OLD.revision;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sdr_protect_draft_revision ON sdr_drafts;
CREATE TRIGGER sdr_protect_draft_revision BEFORE UPDATE ON sdr_drafts FOR EACH ROW EXECUTE FUNCTION sdr_protect_draft_revision();
CREATE OR REPLACE FUNCTION sdr_protect_approval_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Draft approval receipts are append-only' USING ERRCODE='23514'; END $$;
DROP TRIGGER IF EXISTS sdr_protect_approval_receipt ON sdr_draft_approvals;
CREATE TRIGGER sdr_protect_approval_receipt BEFORE UPDATE OR DELETE ON sdr_draft_approvals FOR EACH ROW EXECUTE FUNCTION sdr_protect_approval_receipt();
