-- Explicit release migration (additive, idempotent). Apply before SDR_SALES_SOURCE=orders.
-- One row per website order (app project with exactly one Trello card on the orders board),
-- refreshed by lib/orderSales.js. Reporting only: nothing here is written back to Trello,
-- Pipedrive or the project record.
BEGIN;
CREATE TABLE IF NOT EXISTS sdr_order_facts (
  project_id text PRIMARY KEY,
  card_id text NOT NULL,
  ordered_on date NOT NULL,
  ordered_on_source text NOT NULL CHECK (ordered_on_source IN ('date_received','card_created')),
  value_usd numeric,
  value_source text CHECK (value_source IN ('pipedrive','invoice')),
  paid text NOT NULL DEFAULT 'unknown' CHECK (paid IN ('paid','unpaid','unknown')),
  pipedrive_deal_id text,
  deal_match text NOT NULL DEFAULT 'unmatched' CHECK (deal_match IN ('reviewed','email','unmatched','ambiguous')),
  current boolean NOT NULL DEFAULT true,
  observed_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sdr_order_facts_day ON sdr_order_facts(ordered_on) WHERE current;
-- Reviewed project/card -> Pipedrive deal links (lib/sdrOrderReconciliation.js semantics).
-- Filled by staff when an order and its deal cannot be matched by email; read by the refresh.
CREATE TABLE IF NOT EXISTS sdr_order_deal_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text,
  card_id text,
  pipedrive_deal_id text NOT NULL,
  evidence jsonb NOT NULL,
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT NOW(),
  active boolean NOT NULL DEFAULT true,
  CHECK (project_id IS NOT NULL OR card_id IS NOT NULL)
);
COMMIT;
