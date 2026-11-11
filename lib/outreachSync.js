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
import { canonicalMailbox } from "./mailboxAliases.js";

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
      row.sender_email ? canonicalMailbox(row.sender_email) : null,
      row.subject || null,
      row.external_ref || null,
    ],
  );
}

let sweeping = false;

// Sweep the Pipedrive "sent" folder → upsert latest send per lead.
// full=true pages to the end (initial backfill); otherwise stops once threads
// fall before the last watermark (cheap incremental run in the 6h sync cron).
//
// The result says how far the ledger can be trusted:
//   complete   this run reached its watermark or the end of the folder (false at the page cap)
//   backfilled a run has read the whole folder to its end, and no run since stopped at the cap.
//              A capped run still moves the watermark, so the threads it never reached stay
//              unread until the next full sweep: backfilled_at is cleared until then.
export async function sweepSentOutreach(pool, { full = false, client = pd, maxPages = SWEEP_MAX_PAGES } = {}) {
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
    // True once the sweep saw everything it had to: the watermark, or the end of the folder.
    // Stopping at the page cap leaves it false, and callers that need the full ledger wait.
    let complete = false;
    for (let page = 0; page < maxPages; page++) {
      const { data, pagination } = await client.listMailThreads({ folder: "sent", start, limit: 100 });
      if (!data.length) { complete = true; break; }
      let reachedWatermark = false;
      for (const t of data) {
        scanned++;
        // The sent folder is ordered by SEND time (newest first), so the watermark and
        // the stop test must key off last_message_sent_timestamp — NOT last_message_timestamp,
        // which jumps forward when a reply is received and would break the ordering assumption.
        const sentTs = t.last_message_sent_timestamp || t.last_message_timestamp;
        const sortTs = Date.parse(sentTs || "");
        if (Number.isFinite(sortTs)) maxTs = Math.max(maxTs, sortTs);
        // Incremental: threads are newest-first, so once we pass the watermark we're done.
        if (watermark !== null && Number.isFinite(sortTs) && sortTs < watermark) {
          reachedWatermark = true;
          break;
        }
        if (!t.lead_id) continue;
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
      if (reachedWatermark || !pagination?.more_items_in_collection) { complete = true; break; }
      start = pagination.next_start;
    }

    // Read to the end with no watermark: the whole folder is in the ledger.
    const wholeFolder = complete && watermark === null;
    const { rows: state } = await pool.query(
      `UPDATE sdr_outreach_sweep_state
         SET last_swept_at = NOW(),
             last_thread_ts = GREATEST(COALESCE(last_thread_ts, 'epoch'::timestamptz), $1),
             backfilled_at = CASE WHEN $2::boolean THEN NULL WHEN $3::boolean THEN NOW() ELSE backfilled_at END
       WHERE id = 1
       RETURNING backfilled_at`,
      [maxTs ? new Date(maxTs).toISOString() : null, !complete, wholeFolder],
    );

    return { scanned, leadsUpserted, maxTs: maxTs ? new Date(maxTs).toISOString() : null, complete, backfilled: Boolean(state[0]?.backfilled_at) };
  } finally {
    sweeping = false;
  }
}
