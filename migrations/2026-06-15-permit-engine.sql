-- Permit Engine — facility pool + operator rollup
-- permit_facilities: one row per active TXR050000 NOI coverage, with score + status lifecycle.
-- permit_operators: deduped company rollup keyed by operator_key.
-- Mirrors initDB() in server.js; idempotent (IF NOT EXISTS), additive only.

CREATE TABLE IF NOT EXISTS permit_facilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_permit_nmbr TEXT UNIQUE NOT NULL,
  master_permit TEXT NOT NULL DEFAULT 'TXR050000',
  state TEXT NOT NULL DEFAULT 'TX',
  operator_name TEXT,
  operator_key TEXT NOT NULL DEFAULT '',
  coverage_type TEXT NOT NULL DEFAULT 'NOI' CHECK (coverage_type IN ('NOI','NEC')),
  site_address TEXT,
  city TEXT,
  zip TEXT,
  sector_code TEXT,
  ownership_type TEXT,
  compliance_flags JSONB NOT NULL DEFAULT '{}',
  effective_date DATE,
  expiration_date DATE,
  original_issue_date DATE,
  score NUMERIC(8,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pool'
    CHECK (status IN ('pool','promoted','scraped','enriched','enrolled','exported','engaged','dead')),
  last_pulled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_permit_facilities_master ON permit_facilities(master_permit);
CREATE INDEX IF NOT EXISTS idx_permit_facilities_status ON permit_facilities(status);
CREATE INDEX IF NOT EXISTS idx_permit_facilities_opkey ON permit_facilities(operator_key);
CREATE INDEX IF NOT EXISTS idx_permit_facilities_score ON permit_facilities(score DESC);

CREATE TABLE IF NOT EXISTS permit_operators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_key TEXT UNIQUE NOT NULL,
  operator_name TEXT,
  customer_number TEXT,
  state TEXT NOT NULL DEFAULT 'TX',
  facility_count INT NOT NULL DEFAULT 0,
  best_score NUMERIC(8,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pool',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_permit_operators_score ON permit_operators(best_score DESC);
