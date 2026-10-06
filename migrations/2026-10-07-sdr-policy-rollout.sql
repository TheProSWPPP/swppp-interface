-- Configuration is explicit and versioned. Installing this migration enables nobody.
CREATE TABLE IF NOT EXISTS sdr_policy_rollouts (
 company_id text NOT NULL, version integer NOT NULL CHECK(version>0),
 mode text NOT NULL CHECK(mode IN ('observe','enforce')),
 owner_id text NOT NULL, actor jsonb NOT NULL, evidence text NOT NULL CHECK(length(trim(evidence))>0),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,version)
);
CREATE TABLE IF NOT EXISTS sdr_policy_cohorts (
 company_id text NOT NULL, lead_id text NOT NULL, version integer NOT NULL CHECK(version>0), active boolean NOT NULL,
 dependency_hash text NOT NULL, context_hash text NOT NULL,
 owner_id text NOT NULL, actor jsonb NOT NULL, evidence text NOT NULL CHECK(length(trim(evidence))>0),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,lead_id,version)
);
CREATE TABLE IF NOT EXISTS sdr_policy_decisions (
 decision_key text PRIMARY KEY, company_id text NOT NULL, lead_id text NOT NULL,
 policy_version text NOT NULL, mode text NOT NULL, rollout_version integer NOT NULL, cohort_version integer,
 enforced boolean NOT NULL, action_key text NOT NULL, phase text NOT NULL,
 context_hash text NOT NULL, dependency_hash text NOT NULL, source_hash text NOT NULL,
 proposed_outcome text NOT NULL, reason_codes jsonb NOT NULL,
 invariant_outcome text NOT NULL, invariant_reasons jsonb NOT NULL,
 actual_outcome text NOT NULL, actual_reasons jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION sdr_policy_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'sdr_policy_append_only'; END;
$$;
DROP TRIGGER IF EXISTS sdr_policy_rollouts_immutable ON sdr_policy_rollouts;
CREATE TRIGGER sdr_policy_rollouts_immutable BEFORE UPDATE OR DELETE ON sdr_policy_rollouts FOR EACH ROW EXECUTE FUNCTION sdr_policy_append_only();
DROP TRIGGER IF EXISTS sdr_policy_cohorts_immutable ON sdr_policy_cohorts;
CREATE TRIGGER sdr_policy_cohorts_immutable BEFORE UPDATE OR DELETE ON sdr_policy_cohorts FOR EACH ROW EXECUTE FUNCTION sdr_policy_append_only();
DROP TRIGGER IF EXISTS sdr_policy_decisions_immutable ON sdr_policy_decisions;
CREATE TRIGGER sdr_policy_decisions_immutable BEFORE UPDATE OR DELETE ON sdr_policy_decisions FOR EACH ROW EXECUTE FUNCTION sdr_policy_append_only();
