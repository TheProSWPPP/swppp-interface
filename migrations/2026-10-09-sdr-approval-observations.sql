-- Explicit additive migration. Never run from approval handlers or startup initDB.
-- HTTP response observations only; no business FKs, triggers, recovery or backfill.
CREATE TABLE IF NOT EXISTS sdr_approval_observations (
 observation_id UUID PRIMARY KEY,
 company_id TEXT NOT NULL CHECK (company_id='13105180'),
 draft_id UUID NOT NULL,
 origin TEXT NOT NULL CHECK (origin IN ('interactive','machine')),
 completed_at TIMESTAMPTZ NOT NULL CHECK (isfinite(completed_at)),
 http_status SMALLINT NOT NULL CHECK (http_status BETWEEN 200 AND 599 AND http_status NOT IN (401,403,404)),
 response_code TEXT NOT NULL CHECK (response_code IN (
  'unknown','daily_cap_reached','existing_customer','already_outreached','contact_cooldown','replied','email_unverified',
  'draft_stale','draft_version_required','approval_missing','draft_too_old','already_sent','draft_revision_changed','draft_recipient_context_changed',
  'scheduled_for_future','mailbox_inactive','sender_context_changed','crm_unverified','crm_context_changed','crm_trigger_changed','outreach_company_unverified','source_context_incomplete',
  'outreach_held','provider_state_requires_review','sequence_cadence_unverified','award_only_requires_matching_sequence','reviewed_context_changed','project_role_unverified','cadence_unverified','draft_review_context_changed','cohort_context_changed','policy_rollout_unconfigured','policy_cohort_unverified','policy_action_identity_required',
  'provider_contact_unverified','provider_context_incomplete','provider_operation_requires_review','provider_membership_unverified','external_membership_requires_review','provider_receipt_unverified','provider_receipt_conflict','apollo_skipped','enrollment_lease_missing','enrollment_in_progress','enrollment_uncertain')),
 category TEXT NOT NULL CHECK (category IN ('unknown','capacity','history','address','draft','schedule','context','protection','provider','retry_guard')),
 observation_kind TEXT NOT NULL CHECK (observation_kind=CASE WHEN http_status>=500 THEN 'http_error' WHEN http_status>=400 THEN 'http_refusal' WHEN http_status<300 THEN 'http_success_response' ELSE 'unclassified' END),
 contract_version SMALLINT NOT NULL CHECK (contract_version=1)
);
CREATE INDEX IF NOT EXISTS sdr_approval_observations_company_time ON sdr_approval_observations(company_id,completed_at DESC);
CREATE INDEX IF NOT EXISTS sdr_approval_observations_draft_time ON sdr_approval_observations(company_id,draft_id,completed_at DESC);
COMMENT ON TABLE sdr_approval_observations IS 'Partial observed approval HTTP responses since rollout; not delivery, eligibility, retry permission, or complete attempt history. Retention unmanaged; preserve until separately reviewed archive/purge.';
