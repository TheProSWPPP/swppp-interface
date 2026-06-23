import pg from 'pg';
import { sweepSentOutreach } from './lib/outreachSync.js';
const pool = new pg.Pool({ connectionString:'postgresql://postgres:EQBDBavxyARYZGeafCVguWQuhUsmMMGb@switchback.proxy.rlwy.net:12018/railway', ssl:{rejectUnauthorized:false} });
const q=(s,p)=>pool.query(s,p).then(r=>r.rows);

// DDL (same as will go into initDB)
await pool.query(`CREATE TABLE IF NOT EXISTS sdr_outreach_log (
  pipedrive_lead_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('pipedrive','interface')),
  sent_at TIMESTAMPTZ NOT NULL,
  sender_name TEXT, sender_email TEXT, subject TEXT, external_ref TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pipedrive_lead_id, source))`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_outreach_log_lead ON sdr_outreach_log(pipedrive_lead_id)`);
await pool.query(`CREATE TABLE IF NOT EXISTS sdr_outreach_sweep_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id=1), last_swept_at TIMESTAMPTZ, last_thread_ts TIMESTAMPTZ)`);
await pool.query(`INSERT INTO sdr_outreach_sweep_state (id) VALUES (1) ON CONFLICT DO NOTHING`);

console.time('sweep');
const r = await sweepSentOutreach(pool, { full:true });
console.timeEnd('sweep');
console.log('SWEEP:', JSON.stringify(r));

console.log('\nrows by source:', JSON.stringify(await q(`SELECT source, COUNT(*)::int n FROM sdr_outreach_log GROUP BY 1`)));
console.log('distinct leads:', (await q(`SELECT COUNT(DISTINCT pipedrive_lead_id)::int n FROM sdr_outreach_log`))[0].n);

const check = async (lid,label)=>{const r=await q(`SELECT to_char(sent_at,'YYYY-MM-DD') d, sender_name, sender_email, left(subject,46) subj FROM sdr_outreach_log WHERE pipedrive_lead_id=$1 AND source='pipedrive'`,[lid]);console.log(label, JSON.stringify(r[0]||'NONE'));};
await check('3353d9e0-4a6d-11f1-9de3-3f7fba6a5600','Dallanara Well Site (expect 2026-05-11 Derek):');

// the bthomas multi-lead pair (expect Knollwood=05-11, WY210=06-03) - look up by title
const bt = await q(`SELECT s.lead_title, to_char(o.sent_at,'YYYY-MM-DD') d, o.sender_name
  FROM sdr_lead_state s JOIN sdr_outreach_log o ON o.pipedrive_lead_id=s.pipedrive_lead_id AND o.source='pipedrive'
  WHERE s.person_email='bthomas@simonteam.com' ORDER BY o.sent_at`);
console.log('bthomas leads:', JSON.stringify(bt));

// coverage vs book
const cov = await q(`SELECT COUNT(*)::int n FROM sdr_lead_state s WHERE EXISTS (SELECT 1 FROM sdr_outreach_log o WHERE o.pipedrive_lead_id=s.pipedrive_lead_id)`);
console.log('book leads with a ledger row:', cov[0].n, '/ 7434');
await pool.end();
