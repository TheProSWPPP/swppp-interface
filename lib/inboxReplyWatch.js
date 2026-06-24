// Inbox reply watch — a SAFETY NET for lead replies the Apollo engagement poll can't see.
//
// Apollo only flags replies to its own sequence emails. Replies on threads it doesn't
// track (the TX05 permit channel, a colleague replying from a different address, anything
// Apollo's detection misses) land in the Gmail inbox but never produce a Pipedrive task.
// This job reads every connected mailbox directly and creates the follow-up activity + note
// for those, assigned to the mailbox's rep.
//
// It DEFERS to Apollo to avoid duplicating the fast path: it only acts on a reply once it's
// older than DEFER_MS (Apollo's 2-min poll has long since handled any sequenced reply by
// then), and it skips any lead that already has a reply event in the last 48h — so a reply
// is turned into exactly one activity no matter which poll saw it first. Dedup is anchored
// on the Gmail message id, so the same message is never processed twice.

import * as gmailInbox from "./gmailInbox.js";
import * as pipedriveClient from "./pipedriveClient.js";

const DEREK_PD_USER_ID = 19499202; // fallback assignee when a rep has no Pipedrive seat mapped
const DEFER_MS = 20 * 60 * 1000; // let Apollo's faster poll own sequenced replies first

export async function ensureReplyLogTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sdr_inbox_reply_log (
      gmail_message_id   TEXT PRIMARY KEY,
      thread_id          TEXT,
      mailbox_email      TEXT,
      from_addr          TEXT,
      pipedrive_lead_id  TEXT,
      activity_id        TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function pollInboxReplies(pool, { getToken, appBase }) {
  if (!process.env.PIPEDRIVE_API_TOKEN) return { skipped: "no-pipedrive" };
  await ensureReplyLogTable(pool);
  const base = appBase || process.env.PUBLIC_BASE_URL || "https://swppp-interface-production.up.railway.app";

  const { rows: boxes } = await pool.query(
    `SELECT a.mailbox_email AS email, m.pipedrive_sender_id
       FROM sdr_inbox_accounts a
       JOIN sdr_mailboxes m ON m.email = a.mailbox_email`,
  );

  const cutoff = Date.now() - DEFER_MS;
  let scanned = 0;
  let created = 0;

  for (const box of boxes) {
    let token;
    try {
      token = await getToken(box.email);
    } catch {
      continue; // mailbox not connected / token failure — skip, try the rest
    }
    let threads;
    try {
      threads = await gmailInbox.listThreads(token, { q: "in:inbox newer_than:7d", maxResults: 25 });
    } catch {
      continue;
    }

    for (const t of threads) {
      if (t.lastOutbound) continue; // our message is the latest → nothing waiting on us
      if (!t.lastMessageId) continue;
      const when = Date.parse(t.date || "") || 0;
      if (when && when > cutoff) continue; // too fresh — give Apollo first crack
      scanned++;

      // Anchor dedup on the message id: claim it once, never reprocess.
      const claim = await pool.query(
        `INSERT INTO sdr_inbox_reply_log (gmail_message_id, thread_id, mailbox_email, from_addr)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (gmail_message_id) DO NOTHING
         RETURNING gmail_message_id`,
        [t.lastMessageId, t.id, box.email, String(t.from || "").slice(0, 250)],
      );
      if (!claim.rows.length) continue; // already handled this message

      const parts = Array.isArray(t.participants) ? t.participants : [];
      if (!parts.length) continue;

      const { rows: leadRows } = await pool.query(
        `SELECT pipedrive_lead_id, lead_title, person_email
           FROM sdr_lead_state WHERE lower(person_email) = ANY($1) LIMIT 1`,
        [parts],
      );
      const lead = leadRows[0];
      if (!lead) continue; // not a known SDR lead (e.g. a permit operator with no Pipedrive lead)

      // Defer to whatever already flagged this lead's reply (Apollo or an earlier pass).
      const { rows: recent } = await pool.query(
        `SELECT 1 FROM sdr_engagement_events
          WHERE pipedrive_lead_id = $1
            AND event_type IN ('email_replied','reply_received')
            AND occurred_at > NOW() - INTERVAL '48 hours' LIMIT 1`,
        [lead.pipedrive_lead_id],
      );
      await pool.query(`UPDATE sdr_inbox_reply_log SET pipedrive_lead_id = $1 WHERE gmail_message_id = $2`, [
        lead.pipedrive_lead_id,
        t.lastMessageId,
      ]);
      if (recent.length) continue; // already covered — no second task

      const contactEmail = parts.find((p) => p === String(lead.person_email || "").toLowerCase()) || parts[0];

      // Record a reply event so the next pass (and the Apollo poll's own dedup window) see it.
      await pool.query(
        `INSERT INTO sdr_engagement_events
           (source, event_type, apollo_event_id, pipedrive_lead_id, mailbox_email, occurred_at, payload, process_status, processed_at)
         VALUES ('gmail', 'email_replied', $1, $2, $3, NOW(), '{}'::jsonb, 'processed', NOW())
         ON CONFLICT (apollo_event_id) DO NOTHING`,
        [`gmail:${t.lastMessageId}:replied`, lead.pipedrive_lead_id, box.email],
      );

      try {
        const act = await pipedriveClient.addActivity({
          leadId: lead.pipedrive_lead_id,
          subject: `Reply received${contactEmail ? ` from ${contactEmail}` : ""} — follow up`,
          type: "task",
          done: false,
          userId: box.pipedrive_sender_id || DEREK_PD_USER_ID,
          note:
            `Replied to ${box.email} outreach — follow up.` +
            `\nOpen in interface: ${base}/#/sdr?lead=${lead.pipedrive_lead_id}`,
        });
        await pipedriveClient.addNote({
          leadId: lead.pipedrive_lead_id,
          content:
            `[Auto] Inbox: REPLY received${contactEmail ? ` from ${contactEmail}` : ""} — hot lead, follow up.` +
            `\nOpen in interface: ${base}/#/sdr?lead=${lead.pipedrive_lead_id}`,
        });
        await pool.query(`UPDATE sdr_inbox_reply_log SET activity_id = $1 WHERE gmail_message_id = $2`, [
          String(act?.id || ""),
          t.lastMessageId,
        ]);
        created++;
      } catch (e) {
        console.error("[inbox-reply-watch] Pipedrive write failed:", e.message);
      }
    }
  }
  return { scanned, created };
}
