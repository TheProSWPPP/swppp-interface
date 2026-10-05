-- Reporting metadata only. Apply explicitly before deploying the matching readers/writers.
BEGIN;
ALTER TABLE sdr_message_facts ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
ALTER TABLE sdr_message_facts ADD COLUMN IF NOT EXISTS test_evidence text;
ALTER TABLE sdr_deal_facts ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
ALTER TABLE sdr_deal_facts ADD COLUMN IF NOT EXISTS test_evidence text;
CREATE OR REPLACE VIEW sdr_reporting_messages AS SELECT * FROM sdr_message_facts WHERE NOT is_test;
CREATE OR REPLACE VIEW sdr_reporting_deals AS SELECT * FROM sdr_deal_facts WHERE NOT is_test;
COMMIT;
