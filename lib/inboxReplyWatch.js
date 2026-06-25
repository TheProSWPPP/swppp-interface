// Inbox reply watch — reads every connected Gmail mailbox and does two things on a new
// lead reply:
//   1. FORWARD it to the rep's real @proswppp.com inbox (dc/jg/mh/th), with a link to the
//      interface, so reps catch replies in their normal inbox.
//   2. Create a Pipedrive follow-up activity + note, but only if nothing already flagged the
//      reply (Apollo's poll, or an earlier pass) in the last 48h — so a reply becomes exactly
//      one task. Apollo's own handler shares the same 48h guard, so whichever sees it first
//      wins and there's no duplicate.
// Both are deduped on the Gmail message id (the reply-log claim), so a message is processed
// once. This also catches replies Apollo can't see at all (permit channel, off-contact).

import * as gmailInbox from "./gmailInbox.js";
import * as pipedriveClient from "./pipedriveClient.js";

const DEREK_PD_USER_ID = 19499202; // fallback assignee when a rep has no Pipedrive seat mapped

export async function ensureReplyLogTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sdr_inbox_reply_log (
      gmail_message_id   TEXT PRIMARY KEY,
      thread_id          TEXT,
      mailbox_email      TEXT,
      from_addr          TEXT,
      pipedrive_lead_id  TEXT,
      activity_id        TEXT,
      forwarded_at       TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE sdr_inbox_reply_log ADD COLUMN IF NOT EXISTS forwarded_at TIMESTAMPTZ`);
}

// Don't forward obvious non-prospect mail (our own E2E test addresses) to a rep's inbox.
function isTestContact(email, leadTitle) {
  return /ivan\.manfredi2001|prodtest|@example\./i.test(email || "") || /^e2e\b/i.test(leadTitle || "");
}
const FORWARD_MAX_AGE_MS = 24 * 60 * 60 * 1000; // only forward genuinely fresh replies

export async function pollInboxReplies(pool, { getToken, appBase }) {
  if (!process.env.PIPEDRIVE_API_TOKEN) return { skipped: "no-pipedrive" };
  await ensureReplyLogTable(pool);
  const base = appBase || process.env.PUBLIC_BASE_URL || "https://swppp-interface-production.up.railway.app";

  const { rows: boxes } = await pool.query(
    `SELECT a.mailbox_email AS email, m.pipedrive_sender_id
       FROM sdr_inbox_accounts a
       JOIN sdr_mailboxes m ON m.email = a.mailbox_email`,
  );

  let scanned = 0;
  let created = 0;
  let forwarded = 0;

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
      await pool.query(`UPDATE sdr_inbox_reply_log SET pipedrive_lead_id = $1 WHERE gmail_message_id = $2`, [
        lead.pipedrive_lead_id,
        t.lastMessageId,
      ]);

      const contactEmail = parts.find((p) => p === String(lead.person_email || "").toLowerCase()) || parts[0];

      // FORWARD the reply to the rep's real @proswppp.com inbox (same local-part as the .co
      // sending mailbox: dc/jg/mh/th), with a link to the interface. Fires for EVERY fresh
      // reply, independent of the Pipedrive activity below. Deduped by the message-id claim.
      if (!isTestContact(contactEmail, lead.lead_title) && when && when > Date.now() - FORWARD_MAX_AGE_MS) {
        try {
          const full = await gmailInbox.getThread(token, t.id);
          const msgs = full.messages || [];
          const last = msgs[msgs.length - 1] || {};
          const com = `${String(box.email).split("@")[0]}@proswppp.com`;
          const link = `${base}/#/sdr?lead=${lead.pipedrive_lead_id}`;
          const note =
            `New reply on "${lead.lead_title || "a lead"}" from ${contactEmail}.\n` +
            `Open it in the SDR interface: ${link}`;
          await gmailInbox.sendMail(token, {
            from: box.email,
            to: com,
            subject: `Reply: ${lead.lead_title || contactEmail}`,
            bodyText: gmailInbox.buildForwardText(note, last),
            bodyHtml: gmailInbox.buildForwardHtml(note, last),
          });
          await pool.query(`UPDATE sdr_inbox_reply_log SET forwarded_at = NOW() WHERE gmail_message_id = $1`, [
            t.lastMessageId,
          ]);
          forwarded++;
        } catch (e) {
          console.error("[inbox-reply-watch] forward failed:", e.message);
        }
      }

      // Pipedrive activity — deferred to whatever already flagged this lead's reply (Apollo
      // or an earlier pass) so a reply becomes exactly one task.
      const { rows: recent } = await pool.query(
        `SELECT 1 FROM sdr_engagement_events
          WHERE pipedrive_lead_id = $1
            AND event_type IN ('email_replied','reply_received')
            AND occurred_at > NOW() - INTERVAL '48 hours' LIMIT 1`,
        [lead.pipedrive_lead_id],
      );
      if (recent.length) continue; // already covered — no second task

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
  return { scanned, created, forwarded };
}
