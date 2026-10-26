// Replies that reach a rep's real proswppp.com inbox never touch the Gmail .co mailboxes the
// reply watch reads, so they used to sit only in Pipedrive's synced mail copy
// (sdr_conversation_messages, provider 'pipedrive'). 2026-10-15: CLR "Br Rep CR-400N" asked
// Derek to resend the proposal and then received sequence steps 2 and 3; 2026-10-19:
// Concrete Strategies' "no longer works here" auto-reply, then step 3.
//
// This feeds those messages into the same reply-action ledger as Gmail replies
// (lib/sdrReplyActions.js enqueueReplyActions): stop the sequence, note, and a task for the
// mailbox rep when the reply needs one. Only messages that
//   - Pipedrive itself linked to a lead (thread/message lead link stored by the sync),
//   - came from outside proswppp,
//   - arrived after a still-live send (enrolled/sent) on that lead,
// are considered. Each is fetched once from Pipedrive for subject/body, classified exactly
// like Gmail (bounce / auto-reply / left-company / human intent) and recorded once under
// its own id, so it is never processed twice. A copy already caught by the Gmail watch
// (same sender, same project, within 30 minutes) adds no second task.

import * as pipedriveClient from './pipedriveClient.js';
import { classifyInbound, classifyReplyIntent, isDepartureNotice, extractFailedRecipient } from './inboxReplyWatch.js';
import { enqueueReplyActions } from './sdrReplyActions.js';
import { htmlToText, addressOf } from './sdrReplyTask.js';

export const PIPEDRIVE_REPLY_LOOKBACK_DAYS = 14;
const LABELS = new Set(['interested','question','nurture','in_house','not_interested','unsubscribe','no_action']);
export const pipedriveReplyIntakeEnabled = () => process.env.SDR_PIPEDRIVE_REPLY_INTAKE !== 'off';

export async function selectPipedriveReplyCandidates(db, { now = new Date(), lookbackDays = PIPEDRIVE_REPLY_LOOKBACK_DAYS, limit = 25 } = {}) {
  return (await db.query(`SELECT m.provider_message_id, m.account_key, m.provider_thread_id, m.from_address, m.occurred_at, m.pipedrive_lead_id, m.link_evidence,
      (SELECT mb.email FROM sdr_sends s LEFT JOIN sdr_mailboxes mb ON mb.id=s.mailbox_id
        WHERE s.pipedrive_lead_id=m.pipedrive_lead_id AND s.status IN ('enrolled','sent') AND s.sent_at < m.occurred_at
        ORDER BY s.sent_at DESC LIMIT 1) AS send_mailbox,
      ls.person_email, ls.lead_title,
      (SELECT array_agg(DISTINCT lower(trim(d.contact_email_snapshot))) FROM sdr_sends s JOIN sdr_drafts d ON d.id=s.draft_id
        WHERE s.pipedrive_lead_id=m.pipedrive_lead_id AND s.status IN ('enrolled','sent') AND d.contact_email_snapshot IS NOT NULL) AS send_emails
    FROM sdr_conversation_messages m
    LEFT JOIN sdr_lead_state ls ON ls.pipedrive_lead_id=m.pipedrive_lead_id
    WHERE m.provider='pipedrive' AND m.direction='in' AND m.pipedrive_lead_id IS NOT NULL AND m.link_evidence IS NOT NULL
      AND m.occurred_at > $1::timestamptz - make_interval(days => $2::int) AND m.occurred_at <= $1::timestamptz
      AND lower(coalesce(substring(m.from_address from '<([^>]+)>'), m.from_address, '')) !~ '@proswppp\\.(co|com)$'
      AND NOT EXISTS (SELECT 1 FROM sdr_reply_messages r WHERE r.provider_message_id = 'pipedrive:' || m.account_key || ':' || m.provider_message_id)
      AND EXISTS (SELECT 1 FROM sdr_sends s WHERE s.pipedrive_lead_id=m.pipedrive_lead_id AND s.status IN ('enrolled','sent')
        AND s.sent_at < m.occurred_at AND s.apollo_contact_id IS NOT NULL AND s.apollo_sequence_id IS NOT NULL)
    ORDER BY m.occurred_at, m.provider_message_id LIMIT $3`, [now, lookbackDays, limit])).rows;
}

// Same order as the Gmail collector: delivery failure, departure notice, out-of-office,
// then the intent classifier for a genuine human reply.
export async function classifyPipedriveReply(candidate, message, { classifyIntent = classifyReplyIntent } = {}) {
  const from = message?.from?.[0]?.email_address ? `${message.from[0].name || ''} <${message.from[0].email_address}>` : candidate.from_address;
  const subject = message?.subject || '';
  const body = htmlToText(message?.body) || message?.snippet || '';
  const text = `${message?.snippet || ''}\n${body}`.slice(0, 4000);
  if (/^(e2e\b|internal test\b)/i.test(subject) || /^e2e\b/i.test(candidate.lead_title || '') || /ivan\.manfredi2001|prodtest|@example\./i.test(from || ''))
    return { kind: 'auto', label: 'test_contact', from, subject };
  const klass = classifyInbound(from, subject, text);
  if (klass === 'bounce') {
    // A delivery failure only counts for this project when it names an address this project
    // is mailing: the live send's recipient or the lead's person.
    const failed = extractFailedRecipient(`${subject} ${text}`);
    const own = new Set([addressOf(candidate.person_email), ...(candidate.send_emails || []).map(addressOf)].filter(Boolean));
    return failed && own.has(failed) ? { kind: 'bounce', label: 'bounce', worth: false, from, subject, failed }
      : { kind: 'auto', label: 'unrelated_bounce', from, subject, failed };
  }
  if (isDepartureNotice(subject, text)) return { kind: 'bounce', label: 'left_company', worth: false, from, subject };
  if (klass === 'auto') return { kind: 'auto', label: 'auto', from, subject };
  let intent;
  try { intent = await classifyIntent({ from, subject, body: text }); }
  catch { intent = { worth: true, label: 'unknown', reason: 'classifier_error' }; }
  if (!LABELS.has(intent?.label)) intent = { worth: true, label: 'unknown', reason: intent?.label && intent.label !== 'unknown' ? `invalid_label:${String(intent.label).slice(0, 30)}` : String(intent?.reason || 'unclassified').slice(0, 120) };
  return { kind: 'human', label: intent.label, worth: intent.worth !== false, reason: intent.reason || null, from, subject };
}

// dryRun: read and classify only; returns the decisions and writes nothing.
export async function collectPipedriveReplies(pool, { pipedrive = pipedriveClient, classifyIntent = classifyReplyIntent, now = new Date(),
  lookbackDays = PIPEDRIVE_REPLY_LOOKBACK_DAYS, limit = 25, dryRun = false, enabled = pipedriveReplyIntakeEnabled() } = {}) {
  if (!enabled) return { skipped: 'disabled' };
  const counts = { candidates: 0, detected: 0, enqueued: 0, unreadable: 0, unclassified: 0 };
  const decisions = [];
  const candidates = await selectPipedriveReplyCandidates(pool, { now, lookbackDays, limit });
  for (const c of candidates) {
    counts.candidates++;
    let message, intent;
    try { message = await pipedrive.getMailMessage(c.provider_message_id, { includeBody: true }); }
    catch (error) {
      // Deleted in Pipedrive: record it once so it is not re-read every run. Anything else retries.
      if (![404, 410].includes(Number(error?.status))) { counts.unreadable++; continue; }
      intent = { kind: 'auto', label: 'unreadable', from: c.from_address, subject: null };
    }
    if (!intent && (!message || String(message.id) !== String(c.provider_message_id))) { counts.unreadable++; continue; }
    intent ||= await classifyPipedriveReply(c, message, { classifyIntent });
    if (intent.label === 'unknown') counts.unclassified++;
    const event = {
      messageId: `pipedrive:${c.account_key}:${c.provider_message_id}`, source: 'pipedrive', account: c.account_key,
      sourceMessageId: String(c.provider_message_id), threadId: c.provider_thread_id ? String(c.provider_thread_id) : null,
      mailbox: c.send_mailbox || c.account_key, receivedAt: c.occurred_at, fromEmail: addressOf(intent.from),
      subject: intent.subject || null, staffResponseAt: null,
      leadLink: { status: 'verified', leadId: c.pipedrive_lead_id, evidence: `pipedrive-thread-lead:${c.provider_thread_id || c.provider_message_id}` },
      intent: { kind: intent.kind, label: intent.label, worth: Boolean(intent.worth), ...(intent.reason ? { reason: intent.reason } : {}) },
    };
    decisions.push({ messageId: event.messageId, leadId: c.pipedrive_lead_id, project: c.lead_title || null, mailbox: event.mailbox,
      receivedAt: c.occurred_at, from: event.fromEmail, subject: event.subject, kind: intent.kind, label: intent.label, reason: intent.reason || null });
    if (dryRun) continue;
    const saved = await enqueueReplyActions(pool, event);
    counts.detected += saved.detected; counts.enqueued += saved.enqueued;
  }
  return { coverage: counts.unreadable ? 'partial' : 'complete', counts, decisions };
}
