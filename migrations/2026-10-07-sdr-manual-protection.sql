-- Apply after base SDR schema and 2026-10-05-sdr-crm-observations.sql.
-- Additive evidence only: no production correction, enrollment or release of holds.
BEGIN;
CREATE TABLE IF NOT EXISTS sdr_change_intents (
  action_id text PRIMARY KEY, company_id text NOT NULL, entity text NOT NULL, entity_id text NOT NULL,
  expected_fields jsonb NOT NULL, proposed_fields jsonb NOT NULL, actor jsonb NOT NULL,
  reason text NOT NULL, context_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS sdr_change_receipts (
  id bigserial PRIMARY KEY, action_id text NOT NULL REFERENCES sdr_change_intents(action_id),
  status text NOT NULL CHECK(status IN ('confirmed','unresolved','failed','superseded','protected_external_state')),
  provider_receipt jsonb, observed_fields jsonb, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS sdr_change_entity ON sdr_change_intents(company_id,entity,entity_id,created_at);
CREATE INDEX IF NOT EXISTS sdr_change_receipt_action ON sdr_change_receipts(action_id,id);
CREATE OR REPLACE FUNCTION sdr_reject_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append_only_evidence'; END $$;
DROP TRIGGER IF EXISTS sdr_change_intents_immutable ON sdr_change_intents;
CREATE TRIGGER sdr_change_intents_immutable BEFORE UPDATE OR DELETE ON sdr_change_intents FOR EACH ROW EXECUTE FUNCTION sdr_reject_evidence_mutation();
DROP TRIGGER IF EXISTS sdr_change_receipts_immutable ON sdr_change_receipts;
CREATE TRIGGER sdr_change_receipts_immutable BEFORE UPDATE OR DELETE ON sdr_change_receipts FOR EACH ROW EXECUTE FUNCTION sdr_reject_evidence_mutation();
ALTER TABLE sdr_crm_revisions ADD COLUMN IF NOT EXISTS event_payload jsonb,
  ADD COLUMN IF NOT EXISTS observed_data jsonb,
  ADD COLUMN IF NOT EXISTS actor_evidence jsonb,
  ADD COLUMN IF NOT EXISTS observation_source_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_read_started_at timestamptz;
ALTER TABLE IF EXISTS sdr_lead_state ADD COLUMN IF NOT EXISTS crm_company_id text,
  ADD COLUMN IF NOT EXISTS crm_source_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS crm_source_read_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS crm_person_source_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS crm_person_source_read_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS safety_context jsonb NOT NULL DEFAULT '{}';
-- Mirror accepted observations and batch ordering in the same database transaction.
-- This protects local projections only; it never locks or writes Pipedrive.
CREATE OR REPLACE FUNCTION sdr_project_crm_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE read_at timestamptz; selected_person text; stage text; derived_trigger text; person_emails jsonb;
BEGIN
  IF to_regclass('sdr_lead_state') IS NULL OR NEW.data IS NULL OR NEW.access_status!='accessible' OR NEW.lifecycle!='active' THEN RETURN NEW; END IF;
  read_at:=COALESCE(NEW.source_read_started_at,NEW.observed_at);
  IF NEW.entity='lead' THEN
    selected_person:=COALESCE(NEW.data->'person_id'->>'id',NEW.data->>'person_id');
    stage:=NEW.data->>'7c1852c27664d1118f75660223a6af9e99d10f2c';
    derived_trigger:=CASE
      WHEN COALESCE(NEW.data->'4e555902fff229d66c1a631ea2135e3676d710c4','null') NOT IN ('null','false','0','""','[]') THEN 'AGC'
      WHEN COALESCE(NEW.data->'310a6cfbcf364587467a42835b369cd4bf1766fa','null') NOT IN ('null','false','0','""','[]') THEN 'LBA'
      WHEN COALESCE(NEW.data->'5fd5cb8c79f7be331ae9af9b03285d9fe1756699','null') NOT IN ('null','false','0','""','[]') THEN 'CM'
      WHEN COALESCE(NEW.data->'61435d2e87311ced7c75007334828fa2de9e9628','null') NOT IN ('null','false','0','""','[]') THEN 'PB'
      WHEN upper(trim(stage)) IN ('AGC','LBA','CM','PB') THEN upper(trim(stage))
      WHEN upper(trim(stage)) IN ('OB','PRE-BID') THEN 'PB' END;
    UPDATE sdr_lead_state SET
      crm_company_id=NEW.company_id,pipedrive_person_id=selected_person,
      person_email=CASE WHEN pipedrive_person_id IS NOT DISTINCT FROM selected_person THEN person_email ELSE NULL END,
      person_name=CASE WHEN pipedrive_person_id IS NOT DISTINCT FROM selected_person THEN person_name ELSE NULL END,
      crm_person_source_updated_at=CASE WHEN pipedrive_person_id IS NOT DISTINCT FROM selected_person THEN crm_person_source_updated_at ELSE NULL END,
      crm_person_source_read_started_at=CASE WHEN pipedrive_person_id IS NOT DISTINCT FROM selected_person THEN crm_person_source_read_started_at ELSE NULL END,
      pipedrive_org_id=COALESCE(NEW.data->'organization_id'->>'id',NEW.data->>'organization_id'),
      project_stage=stage,trigger_type=COALESCE(trigger_override,derived_trigger),
      sequence_started=NEW.data->>'48c4bb758e8642d6372c7fff9df3c0ea716170f1',
      crm_source_updated_at=NEW.source_updated_at,crm_source_read_started_at=read_at
    WHERE pipedrive_lead_id=NEW.entity_id
      AND (crm_company_id IS NULL OR crm_company_id=NEW.company_id)
      AND (crm_source_read_started_at IS NULL OR read_at>=crm_source_read_started_at)
      AND (crm_source_updated_at IS NULL OR NEW.source_updated_at>=crm_source_updated_at);
  ELSIF NEW.entity='person' THEN
    -- Match the decision-context v2/v1 precedence, including authoritative empty arrays.
    person_emails:=CASE WHEN jsonb_typeof(NEW.data->'emails')='array' THEN NEW.data->'emails'
      WHEN jsonb_typeof(NEW.data->'email')='array' THEN NEW.data->'email' END;
    UPDATE sdr_lead_state SET crm_company_id=NEW.company_id,person_name=NEW.data->>'name',person_email=NULLIF(lower(btrim(CASE
      WHEN person_emails IS NOT NULL THEN
        (SELECT e->>'value' FROM jsonb_array_elements(person_emails) WITH ORDINALITY AS emails(e,position)
          ORDER BY CASE WHEN e->'primary'='true'::jsonb THEN 0 ELSE 1 END,position LIMIT 1)
      ELSE COALESCE(NULLIF(NEW.data->>'primary_email',''),NEW.data->>'email') END)),''),
      crm_person_source_updated_at=NEW.source_updated_at,crm_person_source_read_started_at=read_at
    WHERE pipedrive_person_id=NEW.entity_id
      AND crm_company_id=NEW.company_id
      AND (crm_person_source_read_started_at IS NULL OR read_at>=crm_person_source_read_started_at)
      AND (crm_person_source_updated_at IS NULL OR NEW.source_updated_at>=crm_person_source_updated_at);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sdr_crm_operational_projection ON sdr_crm_snapshots;
CREATE TRIGGER sdr_crm_operational_projection AFTER INSERT OR UPDATE OF data,source_updated_at,source_read_started_at ON sdr_crm_snapshots
  FOR EACH ROW EXECUTE FUNCTION sdr_project_crm_observation();
COMMIT;
