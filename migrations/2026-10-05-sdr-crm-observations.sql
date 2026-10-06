-- Additive, observation-only schema. Apply explicitly during rollout.
BEGIN;
CREATE TABLE IF NOT EXISTS sdr_crm_event_inbox (
  company_id text NOT NULL,
  event_id text NOT NULL,
  entity text NOT NULL CHECK(entity IN ('lead','deal','activity','note','person','organization')),
  entity_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('create','change','delete')),
  source_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','done','dead')),
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  lease_token uuid,
  retry_at timestamptz NOT NULL DEFAULT now(),
  error_category text,
  processed_at timestamptz,
  PRIMARY KEY(company_id,event_id)
);
CREATE INDEX IF NOT EXISTS sdr_crm_inbox_due ON sdr_crm_event_inbox(company_id,retry_at,received_at) WHERE status IN ('pending','leased');
CREATE TABLE IF NOT EXISTS sdr_crm_snapshots (
  company_id text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  data jsonb,
  source_updated_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  source_read_started_at timestamptz,
  lifecycle text NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','archived','deleted','merged','unresolved')),
  merged_to_id text,
  source_event_id text,
  source_url text,
  access_status text NOT NULL DEFAULT 'accessible' CHECK(access_status IN ('accessible','denied')),
  access_checked_at timestamptz,
  is_test boolean NOT NULL DEFAULT false,
  test_evidence text,
  PRIMARY KEY(company_id,entity,entity_id),
  CHECK(NOT is_test OR test_evidence IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS sdr_crm_snapshot_updated ON sdr_crm_snapshots(company_id,entity,source_updated_at DESC);
CREATE TABLE IF NOT EXISTS sdr_crm_revisions (
  id bigserial PRIMARY KEY,
  company_id text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  origin text NOT NULL CHECK(origin IN ('webhook','reconciliation')),
  event_id text,
  source_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  action text,
  lifecycle text,
  data jsonb,
  previous jsonb,
  source_url text,
  UNIQUE(company_id,event_id)
);
CREATE INDEX IF NOT EXISTS sdr_crm_revision_entity ON sdr_crm_revisions(company_id,entity,entity_id,observed_at DESC);
CREATE TABLE IF NOT EXISTS sdr_crm_links (
  company_id text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  link_type text NOT NULL CHECK(link_type IN ('lead','deal','person','organization')),
  linked_id text NOT NULL,
  evidence text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,entity,entity_id,link_type,linked_id)
);
CREATE INDEX IF NOT EXISTS sdr_crm_links_target ON sdr_crm_links(company_id,link_type,linked_id);
CREATE TABLE IF NOT EXISTS sdr_crm_reviewed_exclusions (
  company_id text NOT NULL,
  entity text NOT NULL CHECK(entity IN ('lead','deal','activity','note','person','organization')),
  match_type text NOT NULL CHECK(match_type IN ('id','title_pattern')),
  match_value text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('exclude','include')),
  evidence text NOT NULL,
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,entity,match_type,match_value),
  CHECK(length(trim(match_value)) > 0 AND length(trim(evidence)) > 0 AND length(trim(reviewed_by)) > 0)
);
CREATE TABLE IF NOT EXISTS sdr_crm_scope_coverage (
  company_id text NOT NULL,
  scope text NOT NULL,
  status text NOT NULL CHECK(status IN ('partial','complete','error')),
  cursor text,
  window_started_at timestamptz,
  completed_through timestamptz,
  scan_mode text NOT NULL DEFAULT 'full' CHECK(scan_mode IN ('full','delta')),
  last_full_at timestamptz,
  last_seen_source_at timestamptz,
  pages integer NOT NULL DEFAULT 0,
  records integer NOT NULL DEFAULT 0,
  error_category text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(company_id,scope)
);
COMMIT;
