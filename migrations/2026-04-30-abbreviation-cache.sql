-- Idempotency cache for AI-generated project name abbreviations.
-- Same input always returns same output → prevents Pipedrive dedup breakage from non-deterministic AI calls.

CREATE TABLE IF NOT EXISTS abbreviation_cache (
  raw TEXT PRIMARY KEY,
  clean TEXT NOT NULL,
  fallback BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_abbreviation_cache_created ON abbreviation_cache(created_at DESC);
