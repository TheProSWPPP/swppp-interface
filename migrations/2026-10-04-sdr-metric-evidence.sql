-- Additive provenance for SDR conversion metrics. Existing fact identities and readers stay intact.
ALTER TABLE sdr_message_facts ADD COLUMN IF NOT EXISTS outreach_classification text NOT NULL DEFAULT 'unknown';
ALTER TABLE sdr_message_facts ADD COLUMN IF NOT EXISTS classification_evidence text;
ALTER TABLE sdr_deal_facts ADD COLUMN IF NOT EXISTS quote_evidence jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sdr_message_outreach_classification_check'
    AND conrelid='sdr_message_facts'::regclass) THEN
    ALTER TABLE sdr_message_facts ADD CONSTRAINT sdr_message_outreach_classification_check
      CHECK (outreach_classification IN ('unknown','sales_outreach','warmup','automatic','unrelated'));
  END IF;
END $$;
