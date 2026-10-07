-- Additive ledger. No legacy send status is promoted into generation ownership.
CREATE TABLE IF NOT EXISTS sdr_provider_operations (
  id uuid PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('stop','enroll')),
  contact_id text NOT NULL,
  campaign_id text NOT NULL,
  lead_id text NOT NULL,
  expected_membership jsonb NOT NULL,
  draft_revision bigint,
  context_hash text,
  action_id text NOT NULL,
  control_id text,
  state text NOT NULL CHECK (state IN ('reserved','unresolved','confirmed','superseded','protected_external_state')),
  reason text,
  lease_token uuid,
  fence bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sdr_provider_operations_contact ON sdr_provider_operations(contact_id,state);
CREATE TABLE IF NOT EXISTS sdr_provider_membership_observations (
  id bigserial PRIMARY KEY,
  operation_id uuid REFERENCES sdr_provider_operations(id),
  contact_id text NOT NULL,
  campaign_id text NOT NULL,
  membership_id text,
  added_at text,
  membership_status text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  evidence jsonb NOT NULL
);
