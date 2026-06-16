-- Permit Engine — per-facility enrichment (contact + address from TCEQ)
-- permit_enrichment: one row per external_permit_nmbr, FK to permit_facilities.
-- Stores scraped contact/address data; channel defaults to 'mail' (primary outreach).
-- Mirrors initDB() in server.js; idempotent (IF NOT EXISTS), additive only.

CREATE TABLE IF NOT EXISTS permit_enrichment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_permit_nmbr TEXT UNIQUE NOT NULL
    REFERENCES permit_facilities(external_permit_nmbr) ON DELETE CASCADE,
  operator_key TEXT,
  customer_number TEXT,
  contact_name TEXT,
  mailing_address TEXT,
  site_address TEXT,
  sic_code TEXT,
  sector TEXT,
  channel TEXT NOT NULL DEFAULT 'mail' CHECK (channel IN ('mail','email','phone','none')),
  tceq_status TEXT,
  source TEXT NOT NULL DEFAULT 'tceq',
  enriched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_permit_enrichment_channel ON permit_enrichment(channel);
