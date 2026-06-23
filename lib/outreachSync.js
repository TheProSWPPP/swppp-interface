// Per-lead outreach ledger (sdr_outreach_log). Reconstructs "who outreached this
// LEAD, when, on which system" — replacing the misleading person-level
// last_outgoing_mail_time ("Contact emailed any deal"), which bleeds across every
// lead a contact sits on.
//
// Two sources feed one row per (lead, source), latest send wins:
//   'pipedrive'  → swept from the Pipedrive "sent" folder. Each thread is tagged
//                  with lead_id + parties.from (real sender) + sent timestamp.
//                  Verified live: 83% of sent threads carry lead_id, subject == the
//                  lead's project title, single historical sender dc@proswppp.com.
//   'interface'  → written by approve-and-send when our engine sends via Apollo .co.
import * as pd from "./pipedriveClient.js";

const SWEEP_MAX_PAGES = 400; // 400 * 100 = 40k threads — covers the full sent folder
const OVERLAP_MS = 2 * 60 * 60 * 1000; // re-scan a 2h overlap on incremental runs

// Shared upsert: keep the LATER send for a given (lead, source).
export async function upsertOutreach(pool, row) {
  await pool.query(
    `INSERT INTO sdr_outreach_log
       (pipedrive_lead_id, source, sent_at, sender_name, sender_email, subject, external_ref, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (pipedrive_lead_id, source) DO UPDATE SET
       sent_at = EXCLUDED.sent_at,
       sender_name = EXCLUDED.sender_name,
       sender_email = EXCLUDED.sender_email,
       subject = EXCLUDED.subject,
       external_ref = EXCLUDED.external_ref,
       updated_at = NOW()
     WHERE EXCLUDED.sent_at > sdr_outreach_log.sent_at`,
    [
      row.pipedrive_lead_id,
      row.source,
      row.sent_at,
      row.sender_name || null,
      row.sender_email || null,
      row.subject || null,
      row.external_ref || null,
    ],
  );
}

let sweeping = false;

// Sweep the Pipedrive "sent" folder → upsert latest send per lead.
// full=true pages to the end (initial backfill); otherwise stops once threads
// fall before the last watermark (cheap incremental run in the 6h sync cron).
export async function sweepSentOutreach(pool, { full = false } = {}) {
  if (sweeping) return { skipped: "already_running" };
  sweeping = true;
  try {
    let watermark = null;
    if (!full) {
      const { rows } = await pool.query(
        `SELECT last_thread_ts FROM sdr_outreach_sweep_state WHERE id = 1`,
      );
      const ts = rows[0]?.last_thread_ts;
      if (ts) watermark = new Date(ts).getTime() - OVERLAP_MS;
    }

    let start = 0;
    let scanned = 0;
    let leadsUpserted = 0;
    let maxTs = 0;
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const { data, pagination } = await pd.listMailThreads({ folder: "sent", start, limit: 100 });
      if (!data.length) break;
      let reachedWatermark = false;
      for (const t of data) {
        scanned++;
        const sortTs = Date.parse(t.last_message_timestamp || t.last_message_sent_timestamp || "");
        if (Number.isFinite(sortTs)) maxTs = Math.max(maxTs, sortTs);
        // Incremental: threads are newest-first, so once we pass the watermark we're done.
        if (watermark !== null && Number.isFinite(sortTs) && sortTs < watermark) {
          reachedWatermark = true;
          break;
        }
        if (!t.lead_id) continue;
        const sentTs = t.last_message_sent_timestamp || t.last_message_timestamp;
        if (!sentTs) continue;
        const from =
          (t.parties?.from || []).find((f) => f.latest_sent) || (t.parties?.from || [])[0] || null;
        await upsertOutreach(pool, {
          pipedrive_lead_id: t.lead_id,
          source: "pipedrive",
          sent_at: sentTs,
          sender_name: from?.name || null,
          sender_email: (from?.email_address || "").toLowerCase() || null,
          subject: t.subject || null,
          external_ref: String(t.id),
        });
        leadsUpserted++;
      }
      if (reachedWatermark) break;
      if (!pagination?.more_items_in_collection) break;
      start = pagination.next_start;
    }

    await pool.query(
      `UPDATE sdr_outreach_sweep_state
         SET last_swept_at = NOW(),
             last_thread_ts = GREATEST(COALESCE(last_thread_ts, 'epoch'::timestamptz), $1)
       WHERE id = 1`,
      [maxTs ? new Date(maxTs).toISOString() : null],
    );

    return { scanned, leadsUpserted, maxTs: maxTs ? new Date(maxTs).toISOString() : null };
  } finally {
    sweeping = false;
  }
}
