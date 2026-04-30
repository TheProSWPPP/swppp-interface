-- Lead import jobs table — tracks status of CSV uploads from React app through n8n unified flow
-- Replaces the manual Dropbox folder rotation that previously coordinated workflows
-- LTLKMWy5GSqqwKTC and qolP4jPeS7FHoJEU.

CREATE TABLE IF NOT EXISTS lead_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  uploaded_by TEXT,
  total_rows INT,
  cleaned_rows INT DEFAULT 0,
  uploaded_rows INT DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded','cleaning','ready','uploading','done','error')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_import_jobs_status ON lead_import_jobs(status);
CREATE INDEX IF NOT EXISTS idx_lead_import_jobs_created_at ON lead_import_jobs(created_at DESC);
