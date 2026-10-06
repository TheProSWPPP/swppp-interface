CREATE TABLE IF NOT EXISTS sdr_crm_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id text NOT NULL, entity text NOT NULL,
 entity_id text NOT NULL, proposed_fields jsonb NOT NULL, fingerprint text NOT NULL,
 reason text NOT NULL, source text NOT NULL, status text NOT NULL DEFAULT 'review',
 first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 1, UNIQUE(company_id,entity,entity_id,fingerprint)
);
