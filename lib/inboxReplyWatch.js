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
import * as apolloClient from "./apolloClient.js";

const DEREK_PD_USER_ID = 19499202; // fallback assignee when a rep has no Pipedrive seat mapped
const SEQUENCE_STARTED_FIELD = "48c4bb758e8642d6372c7fff9df3c0ea716170f1"; // PD custom field, mirrors server.js

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

// Classify inbound mail that is NOT a genuine prospect reply. NDRs and auto-responders often
// quote the original recipient, so they'd match a lead by participant and (wrongly) get
// forwarded + spawn a follow-up task. Returns:
//   "bounce" → a non-delivery report / blocked message → record it as a bounce, stop sequence
//   "auto"   → out-of-office / vacation auto-reply → silently ignore
//   null     → a real reply → forward + task as normal
export function classifyInbound(from, subject, snippet) {
  const f = String(from || "").toLowerCase();
  const s = `${subject || ""} ${snippet || ""}`.toLowerCase();
  const bounceFrom = /mailer-daemon|postmaster@|mail delivery (subsystem|system)/i.test(f);
  const bounceText =
    /delivery status notification|undeliverable|mail delivery (failed|subsystem)|returned mail|delivery (has )?failed|delivery incomplete|failure notice|message (was )?not delivered|address (not found|couldn'?t be found)|recipient.*not found|could ?n'?t be delivered|wasn'?t delivered|message (blocked|rejected)|550 5\./i.test(
      s,
    );
  if (bounceFrom || bounceText) return "bounce";
  // Out-of-office / vacation / leave auto-responders. Kept high-precision: each alternative is a
  // phrase that appears in auto-replies but not in a genuine "yes let's talk" reply. Note the
  // hyphen/space tolerance — "out-of-office" is as common as "out of office", and leave notices
  // (maternity/medical/annual) are the other big class the old pattern missed.
  const autoText =
    /automatic reply|auto[- ]?reply|out[-\s]?of[-\s]?(the[-\s]?)?office|on (maternity|paternity|parental|medical|sick|annual|extended|family|bereavement) leave|\bon leave\b|(currently|presently) (out of|away|on leave|unavailable)|away (from (my|the) (desk|office)|until|on vacation)|on (vacation|holiday|pto)\b|(i will|i'll|will) (be back|return)( to (the )?office)? (on|in|by)|return(ing)? to (the )?office on|limited access to (my )?(e-?mail|inbox)/i;
  if (autoText.test(s)) return "auto";
  return null;
}

// Pull email addresses out of NDR text (subject + snippet + body), dropping our own mailboxes
// and the daemon senders, so the remaining address is the prospect we failed to reach.
function extractFailedRecipient(text) {
  const found = String(text || "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
  for (const e of found) {
    if (/@proswppp\.(co|com)$/.test(e)) continue; // our sending mailboxes
    if (/mailer-daemon|postmaster|googlemail|google\.com|apollo\.io/.test(e)) continue; // infra
    return e;
  }
  return null;
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
  let bounced = 0;

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

      // Bounces / NDRs / auto-responders are not replies: don't forward, don't make a task.
      const klass = classifyInbound(t.from, t.subject, t.snippet);
      if (klass === "auto") {
        await pool.query(`UPDATE sdr_inbox_reply_log SET from_addr = $1 WHERE gmail_message_id = $2`, [
          `[auto-reply] ${String(t.from || "").slice(0, 230)}`,
          t.lastMessageId,
        ]);
        continue;
      }
      if (klass === "bounce") {
        try {
          const handled = await recordInboxBounce(pool, token, t, box, base);
          if (handled) bounced++;
        } catch (e) {
          console.error("[inbox-reply-watch] bounce record failed:", e.message);
        }
        await pool.query(`UPDATE sdr_inbox_reply_log SET from_addr = $1 WHERE gmail_message_id = $2`, [
          `[bounce] ${String(t.from || "").slice(0, 230)}`,
          t.lastMessageId,
        ]);
        continue;
      }

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
          const link = `${base}/#/sdr?inboxLead=${lead.pipedrive_lead_id}`;
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
            `\nOpen in interface: ${base}/#/sdr?inboxLead=${lead.pipedrive_lead_id}`,
        });
        await pipedriveClient.addNote({
          leadId: lead.pipedrive_lead_id,
          content:
            `[Auto] Inbox: REPLY received${contactEmail ? ` from ${contactEmail}` : ""} — hot lead, follow up.` +
            `\nOpen in interface: ${base}/#/sdr?inboxLead=${lead.pipedrive_lead_id}`,
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
  return { scanned, created, forwarded, bounced };
}

// Record an inbound NDR (bounce) that Apollo may not have flagged: find the failed prospect by
// the address quoted in the NDR, leave a "bounced" comment on the lead, mark the send bounced,
// clear Sequence_Started, and pull the contact from Apollo so we stop sending to a dead address.
// Deduped against any bounce event on the lead in the last 48h so it stays one note across paths.
async function recordInboxBounce(pool, token, t, box, base) {
  // Build the searchable NDR text (subject + snippet + full body) and pull the failed address.
  let body = "";
  try {
    const full = await gmailInbox.getThread(token, t.id);
    body = (full.messages || []).map((m) => m.body || "").join("\n");
  } catch {
    /* body is best-effort; subject + snippet usually carry the address too */
  }
  const failed = extractFailedRecipient(`${t.subject || ""} ${t.snippet || ""} ${body}`);
  if (!failed) return false;

  const { rows: leadRows } = await pool.query(
    `SELECT pipedrive_lead_id, lead_title FROM sdr_lead_state WHERE lower(person_email) = $1 LIMIT 1`,
    [failed],
  );
  const lead = leadRows[0];
  if (!lead) return false; // not a known SDR lead
  await pool.query(`UPDATE sdr_inbox_reply_log SET pipedrive_lead_id = $1 WHERE gmail_message_id = $2`, [
    lead.pipedrive_lead_id,
    t.lastMessageId,
  ]);

  // Dedup: if a bounce was already recorded for this lead in the last 48h (Apollo or a prior
  // pass), don't double-note. Stable synthetic event id makes the insert itself idempotent too.
  const { rows: recent } = await pool.query(
    `SELECT 1 FROM sdr_engagement_events
      WHERE pipedrive_lead_id = $1 AND event_type IN ('email_bounced','bounce')
        AND occurred_at > NOW() - INTERVAL '48 hours' LIMIT 1`,
    [lead.pipedrive_lead_id],
  );
  await pool.query(
    `INSERT INTO sdr_engagement_events
       (source, event_type, apollo_event_id, pipedrive_lead_id, mailbox_email, occurred_at, payload, process_status, processed_at)
     VALUES ('gmail', 'email_bounced', $1, $2, $3, NOW(), '{}'::jsonb, 'processed', NOW())
     ON CONFLICT (apollo_event_id) DO NOTHING`,
    [`gmail:${t.lastMessageId}:bounced`, lead.pipedrive_lead_id, box.email],
  );
  if (recent.length) return true; // already flagged — event recorded, but no second note

  // Mark the send bounced + grab the Apollo handle so we can stop the sequence.
  const { rows: sendRows } = await pool.query(
    `UPDATE sdr_sends SET status = 'bounced', last_status_at = NOW(), updated_at = NOW()
      WHERE pipedrive_lead_id = $1 AND status IN ('enrolled','sent')
      RETURNING apollo_contact_id, apollo_sequence_id`,
    [lead.pipedrive_lead_id],
  );

  try {
    await pipedriveClient.updateLead(lead.pipedrive_lead_id, { [SEQUENCE_STARTED_FIELD]: "" });
    await pipedriveClient.addNote({
      leadId: lead.pipedrive_lead_id,
      content: `[Auto] BOUNCED — delivery failed to ${failed} (rejected by the recipient's mail server). Sequence stopped.`,
    });
  } catch (e) {
    console.error("[inbox-reply-watch] Pipedrive bounce write failed:", e.message);
  }

  // Hard-stop remaining Apollo follow-ups to the bouncing address.
  const snd = sendRows[0];
  if (snd?.apollo_contact_id && snd?.apollo_sequence_id && process.env.APOLLO_API_KEY) {
    try {
      await apolloClient.removeContactsFromSequence(snd.apollo_sequence_id, [snd.apollo_contact_id], "remove");
    } catch (e) {
      console.error("[inbox-reply-watch] Apollo remove-on-bounce failed:", e.message);
    }
  }
  return true;
}
