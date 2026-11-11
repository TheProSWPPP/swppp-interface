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

const SWEEP_MAX_PAGES = 1000; // ~90k threads; the sent folder held 33,772 on 2026-11-11
const PAGE_SIZE = 100;
// Each page starts a few threads before the last one ended. A thread deleted while the sweep
// runs shifts the rest up by one, and without the overlap the thread at the page edge is skipped.
const PAGE_OVERLAP = 10;
const OVERLAP_MS = 2 * 60 * 60 * 1000; // re-scan a 2h overlap on incremental runs
const SWEEP_LOCK = "sdr_outreach_sweep";
const firstTimestamp = (...values) => values.find((v) => v && Number.isFinite(Date.parse(v))) || null;

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
// One sweep at a time, across processes: the whole run, from reading the watermark to writing
// it, holds a database advisory lock on one connection and does all its queries on it. Two
// overlapping runs could otherwise leave the watermark of one beside the backfill mark of the other.
//
// The result says how far the ledger can be trusted:
//   complete   this run reached its watermark or the end of the folder. False at the page cap,
//              and when a page came back without a clear "more pages / no more pages" answer.
//   undated    threads tied to a lead that do not say when their last message went out: they
//              cannot be logged. When a thread was started or last changed is not that time.
//   backfilled a run has read the whole folder to its end, and no run since was incomplete or
//              met an undated thread. An incomplete run still moves the watermark, so the
//              threads it never reached stay unread until the next full sweep: backfilled_at
//              is cleared until then.
// onLock(true) is called once this run holds the sweep lock, onLock(false) when it stands aside.
export async function sweepSentOutreach(pool, { full = false, client = pd, maxPages = SWEEP_MAX_PAGES, onLock = () => {} } = {}) {
  if (sweeping) { onLock(false); return { skipped: "already_running" }; }
  sweeping = true;
  let db;
  let discard = false;
  try {
    db = await pool.connect();
    const { rows: lock } = await db.query(`SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked`, [SWEEP_LOCK]);
    if (!lock[0]?.locked) { onLock(false); return { skipped: "already_running" }; }
    onLock(true);
    try {
      return await sweepLocked(db, { full, client, maxPages });
    } finally {
      // An unlock that fails leaves the lock on the connection: closing the connection frees it.
      await db.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [SWEEP_LOCK]).catch(() => { discard = true; });
    }
  } catch (error) {
    if (error?.code && /^(08|57)/.test(String(error.code))) discard = true;
    throw error;
  } finally {
    if (db) db.release(discard);
    sweeping = false;
  }
}

// `db` is the connection holding the sweep lock. Every query runs on it, so a connection that
// drops (and with it the lock) fails the run before it can write the state row.
async function sweepLocked(db, { full, client, maxPages }) {
  let watermark = null;
  if (!full) {
    const { rows } = await db.query(`SELECT last_thread_ts FROM sdr_outreach_sweep_state WHERE id = 1`);
    const ts = rows[0]?.last_thread_ts;
    if (ts) watermark = new Date(ts).getTime() - OVERLAP_MS;
  }

  let start = 0;
  let scanned = 0;
  let leadsUpserted = 0;
  let undated = 0;
  let maxTs = 0;
  // True once the sweep saw everything it had to: the watermark, or the end of the folder.
  // Stopping at the page cap leaves it false, and callers that need the full ledger wait.
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const { data, pagination } = await client.listMailThreads({ folder: "sent", start, limit: PAGE_SIZE });
    // Pipedrive says on every page whether more follow. Only its explicit "no more" ends the folder.
    const more = pagination?.more_items_in_collection;
    let reachedWatermark = false;
    for (const t of data || []) {
      scanned++;
      // The sent folder is ordered by SEND time (newest first), so the watermark and
      // the stop test must key off last_message_sent_timestamp — NOT last_message_timestamp,
      // which jumps forward when a reply is received and would break the ordering assumption.
      const sentTs = firstTimestamp(t.last_message_sent_timestamp, t.last_message_timestamp);
      const sortTs = Date.parse(sentTs || "");
      if (Number.isFinite(sortTs)) maxTs = Math.max(maxTs, sortTs);
      // Incremental: threads are newest-first, so once we pass the watermark we're done.
      if (watermark !== null && Number.isFinite(sortTs) && sortTs < watermark) {
        reachedWatermark = true;
        break;
      }
      if (!t.lead_id) continue;
      // A thread on a lead always counts as mail on that lead. Only the time of its last message
      // says when that mail went out: a thread started months ago can carry a hand email from
      // today, so its start or change time never stands in. Without it the ledger cannot hold
      // the thread, and is not whole.
      if (!sentTs) { undated++; continue; }
      const from =
        (t.parties?.from || []).find((f) => f.latest_sent) || (t.parties?.from || [])[0] || null;
      await upsertOutreach(db, {
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
    if (reachedWatermark || more === false) { complete = true; break; }
    const next = Number(pagination?.next_start);
    // No clear answer, or a cursor that does not move forward: the rest of the folder is unread.
    if (more !== true || !Number.isInteger(next) || next <= start) break;
    start = Math.max(start + 1, next - PAGE_OVERLAP);
  }

  // Read to the end with no watermark, every lead thread logged: the whole folder is in the ledger.
  const gap = !complete || undated > 0;
  const wholeFolder = !gap && watermark === null;
  const { rows: state } = await db.query(
    `UPDATE sdr_outreach_sweep_state
       SET last_swept_at = NOW(),
           last_thread_ts = GREATEST(COALESCE(last_thread_ts, 'epoch'::timestamptz), $1),
           backfilled_at = CASE WHEN $2::boolean THEN NULL WHEN $3::boolean THEN NOW() ELSE backfilled_at END
     WHERE id = 1
     RETURNING backfilled_at`,
    [maxTs ? new Date(maxTs).toISOString() : null, gap, wholeFolder],
  );
  // No state row, no mark: the ledger is not known to be whole.
  return { scanned, leadsUpserted, undated, maxTs: maxTs ? new Date(maxTs).toISOString() : null, complete, backfilled: Boolean(state[0]?.backfilled_at) };
}
