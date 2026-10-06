CREATE TABLE IF NOT EXISTS sdr_outreach_controls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id text NOT NULL,
 lead_id text, scope_kind text NOT NULL CHECK(scope_kind IN ('draft','service','lead','recipient','channel')),
 scope_id text NOT NULL, channel text, reason text NOT NULL,
 context_hash text NOT NULL, actor jsonb NOT NULL, owner_id text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','released')),
 version integer NOT NULL DEFAULT 1, provider_stop_status text NOT NULL DEFAULT 'unverified'
 CHECK(provider_stop_status IN ('unverified','requested','confirmed','unresolved')),
 review_after timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sdr_controls_active_scope ON sdr_outreach_controls(company_id,lead_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS sdr_outreach_control_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), control_id uuid NOT NULL REFERENCES sdr_outreach_controls(id),
 version integer NOT NULL, decision text NOT NULL, evidence text NOT NULL, context_hash text NOT NULL,
 actor jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(control_id,version)
);
