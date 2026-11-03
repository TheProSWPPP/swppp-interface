// When a prospect replies on LinkedIn: their sequence has already stopped (the local hold is
// committed before this runs). Derek gets the reply by email with a suggested answer, then a
// reminder after 1 business day if it is still open, and again after 3. Nothing is ever sent to
// the prospect from here: Derek answers by hand in LinkedIn.
import { addBusinessDays, linkedinWindowOpen } from './sdrLinkedinPolicy.js';
import { enqueueExitOnly } from './replyExit.js';

const fail = code => Object.assign(new Error(code), { code });
const email = v => String(v || '').trim().toLowerCase();
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || '');
const CENTRAL = { timezone: 'America/Chicago', sendWindow: { weekdays: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' } };
export const LANE_LABELS = { A: 'New in the seat', B: 'Old contact who moved', C: 'Replacement at an old customer', D: 'Talking about stormwater' };
const MODEL = () => process.env.SDR_LINKEDIN_LINE_MODEL || process.env.REPLY_INTENT_MODEL || 'gemini-3.6-flash';
const STEP_LABELS = { invite: 'Connection request (no note)', dm1: 'Message 1', followup1: 'Message 2', followup2: 'Message 3', inmail: 'InMail' };

export const fallbackSuggestedAnswer = firstName => `Hey ${firstName || 'there'}, thanks for getting back to me. What's the best number to reach you on?`;
const plain = text => String(text || '').replace(/[—–]/g, ',').trim();

// The thread link uses LinkedIn's own conversation id (chat.provider_id), never Unipile's chat id.
export const linkedinThreadUrl = (chat, fallback) => (chat?.provider_id ? `https://www.linkedin.com/messaging/thread/${encodeURIComponent(chat.provider_id)}/` : fallback || null);

export async function suggestReplyAnswer({ lane, firstName, sent = [], reply, apiKey = process.env.GEMINI_API_KEY, transport = fetch }) {
  const fallback = fallbackSuggestedAnswer(firstName);
  if (!apiKey || !reply) return fallback;
  const prompt = [
    'You draft a LinkedIn reply for Derek, who runs ProSWPPP (SWPPP and stormwater plans for general contractors).',
    `Lane: ${LANE_LABELS[lane] || lane}. Their first name: ${firstName || 'unknown'}.`,
    'What Derek sent, oldest first:', ...sent.map(m => `- ${m}`),
    `Their reply:\n"""${String(reply).slice(0, 2000)}"""`,
    "Write Derek's next message: short (under 50 words), friendly, plain words, his casual voice. No price, no dates or deadlines promised, no attachments, no links, no dashes.",
    'If they ask for something Derek must check, say he will check and ask for the best number or email to reach them.',
    'Respond with ONLY minified JSON: {"answer":"..."}',
  ].join('\n');
  try {
    const response = await transport(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } }),
    });
    if (!response.ok) return fallback;
    const data = await response.json().catch(() => ({}));
    const raw = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    const answer = plain(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')).answer);
    if (!answer || answer.length > 600 || /\$\s?\d|https?:\/\//i.test(answer)) return fallback;
    return answer;
  } catch { return fallback; }
}

async function sentMessages(db, candidate) {
  const rows = (await db.query(`SELECT step,body,confirmed_at FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND state='confirmed' ORDER BY confirmed_at NULLS LAST,created_at`, [candidate.company_id, candidate.account_id, candidate.person_id])).rows;
  return rows.map(row => {
    let text = row.body || '';
    if (row.step === 'inmail') { try { const parsed = JSON.parse(row.body); text = `${parsed.subject}: ${parsed.body}`; } catch { /* stored as text */ } }
    return `${STEP_LABELS[row.step] || row.step}${text ? `: "${text}"` : ''}`;
  });
}

// Replaces the Pipedrive task handler for prospect candidates.
export function createProspectInboundHandler({ pool, client, mode = 'disabled', suggest = suggestReplyAnswer, enqueueExit = enqueueExitOnly }) {
  return async ({ candidate, event }) => {
    if (!candidate?.person_id || !event?.source_message_id || !event.chat_id || event.direction !== 'in') throw fail('inbound_identity_unverified');
    let replyText = 'Open LinkedIn to read the reply.', threadUrl = candidate.profile_url, suggested = null;
    // Only live reads the chat and asks the model for an answer; observe and dry_run record the
    // alert without a seat read or a model call.
    if (mode === 'live') {
      const chat = await client.getChat({ chatId: event.chat_id });
      const attendees = chat?.attendees_ids || [];
      if (chat?.account_id !== candidate.account_id || !(attendees.includes(candidate.provider_id) || chat?.attendee_provider_id === candidate.provider_id)) throw fail('inbound_chat_unverified');
      const history = await client.listMessages({ chatId: event.chat_id, maxPages: 1 });
      if (!history?.complete) throw fail('inbound_history_partial');
      const exact = history.items.filter(message => message.id === event.source_message_id && message.is_sender === false);
      if (exact.length !== 1 || !String(exact[0].text || '').trim()) throw fail('inbound_message_unverified');
      replyText = String(exact[0].text).slice(0, 4000);
      threadUrl = linkedinThreadUrl(chat, candidate.profile_url);
      const firstName = candidate.source_context?.firstNameVerified ? candidate.source_context.firstName : null;
      suggested = await suggest({ lane: candidate.lane, firstName, sent: await sentMessages(pool, candidate), reply: replyText });
    }
    // One open alert per person. A later message while it is open (or a replay of one already
    // recorded) is appended to that alert, so Derek gets one email and one set of reminders.
    let row = (await pool.query(`INSERT INTO sdr_linkedin_reply_alerts(company_id,account_id,candidate_id,source_message_id,chat_id,thread_url,reply_text,suggested_answer,lane)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
    [candidate.company_id, candidate.account_id, candidate.id, event.source_message_id, event.chat_id, threadUrl, replyText, suggested, candidate.lane])).rows[0];
    if (!row) row = (await pool.query(`UPDATE sdr_linkedin_reply_alerts SET reply_text=reply_text||E'\n\n'||$4,message_ids=array_append(message_ids,$3),suggested_answer=COALESCE($5,suggested_answer)
      WHERE company_id=$1 AND account_id=$2 AND candidate_id=$6 AND state IN ('pending','sent') AND source_message_id<>$3 AND NOT ($3=ANY(message_ids)) RETURNING id`,
    [candidate.company_id, candidate.account_id, event.source_message_id, replyText, suggested, candidate.id])).rows[0];
    // A prospect with an email on record also leaves every email sequence (#125 exit_person), at
    // the time they wrote. Off unless SDR_REPLY_EXIT_MODE is set; idempotent on the message id.
    let exit = null;
    if (validEmail(email(candidate.resolved_email))) {
      try {
        exit = await enqueueExit(pool, { messageId: `linkedin:${candidate.account_id}:${event.source_message_id}`, source: 'linkedin', mailbox: `linkedin:${candidate.account_id}`,
          receivedAt: event.source_at || event.observed_at || new Date(), fromEmail: email(candidate.resolved_email), threadId: event.chat_id || null, intent: 'linkedin_inbound' });
      } catch { console.error('[linkedin-reply] prospect reply exit enqueue failed'); }
    }
    return { state: 'held', reason: 'linkedin_inbound', alertId: row?.id || null, exit: exit ? { enqueued: exit.enqueued || 0, skipped: exit.skipped || null } : null };
  };
}

export function replyAlertContent(alert, { candidate, sent = [], appBase, reminder = 0 }) {
  const name = candidate?.source_context?.fullName || 'Someone';
  const company = candidate?.firm || 'their company';
  const subject = `${reminder ? 'Reminder: ' : ''}LinkedIn reply: ${name} (${company})`;
  const lines = [
    reminder ? `Still open after ${reminder} business day${reminder > 1 ? 's' : ''}: ${name} replied on LinkedIn and has no answer yet.` : `${name} replied on LinkedIn.`,
    '',
    `Who: ${name}${candidate?.role ? `, ${candidate.role}` : ''} at ${company}`,
    `Group: ${alert.lane ? `${alert.lane}. ${LANE_LABELS[alert.lane] || ''}` : 'unknown'}`,
    '',
    'What we sent:', ...(sent.length ? sent.map(m => `- ${m}`) : ['- Nothing recorded']),
    '',
    'Their reply:', `"${alert.reply_text}"`,
    '',
    'Suggested answer (edit it, then send it yourself in LinkedIn):', alert.suggested_answer || fallbackSuggestedAnswer(candidate?.source_context?.firstNameVerified ? candidate.source_context.firstName : null),
    '',
    `Open the LinkedIn conversation: ${alert.thread_url || candidate?.profile_url || 'open LinkedIn'}`,
    `Open in the interface: ${appBase}/#/sdr`,
    '',
    'LinkedIn outreach to this person has stopped. When you answer in LinkedIn, the reminders stop.',
  ];
  return { subject, bodyText: lines.join('\n') };
}

// Internal email only: from SDR_LINKEDIN_ALERT_FROM (a mailbox with a stored Gmail token) to
// SDR_LINKEDIN_ALERT_TO (Derek). The Message-ID and a body marker make a retry after a lost
// receipt find the earlier email instead of sending a second one.
export async function drainReplyAlerts(pool, { gmail, getToken, now = new Date(), companyId, accountId, enabled = process.env.SDR_LINKEDIN_REPLY_ALERTS_ENABLED === 'true', from = process.env.SDR_LINKEDIN_ALERT_FROM, to = process.env.SDR_LINKEDIN_ALERT_TO, appBase = process.env.PUBLIC_BASE_URL || 'https://swppp-interface-production.up.railway.app', limit = 10 } = {}) {
  // Answered = staff wrote in the same chat after the reply (not one of our own receipts).
  const answered = await pool.query(`UPDATE sdr_linkedin_reply_alerts r SET state='answered',answered_at=$3,answered_by='linkedin' FROM sdr_linkedin_candidates c
    WHERE c.id=r.candidate_id AND r.company_id=$1 AND r.account_id=$2 AND r.state IN ('pending','sent','reminded') AND (c.state='staff_takeover' OR EXISTS (
     SELECT 1 FROM sdr_linkedin_events e WHERE e.company_id=r.company_id AND e.account_id=r.account_id AND e.kind='message_received' AND e.direction='out' AND e.chat_id=r.chat_id
     AND e.observed_at>COALESCE((SELECT i.observed_at FROM sdr_linkedin_events i WHERE i.company_id=r.company_id AND i.account_id=r.account_id AND i.source_message_id=r.source_message_id LIMIT 1),r.created_at)
     AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_actions a WHERE a.company_id=e.company_id AND a.account_id=e.account_id AND a.provider_id=e.source_message_id)))`, [companyId, accountId, now]);
  if (!enabled) return { skipped: 'disabled', answered: answered.rowCount };
  if (!gmail?.sendMail || !getToken) return { skipped: 'gmail_unavailable', answered: answered.rowCount };
  const counts = { sent: 0, reminders: 0, failed: 0, reconciled: 0, answered: answered.rowCount };
  // Only work that is due holds a slot: unsent alerts (never-tried first), then reminders whose
  // time has come. An alert with both reminders sent is 'reminded' and leaves the drain.
  const rows = (await pool.query(`SELECT r.*,row_to_json(c.*) AS candidate FROM sdr_linkedin_reply_alerts r JOIN sdr_linkedin_candidates c ON c.id=r.candidate_id
    WHERE r.company_id=$1 AND r.account_id=$2 AND (r.state='pending' OR (r.state='sent' AND r.next_reminder_at<=$4))
    ORDER BY CASE WHEN r.state='pending' THEN 0 ELSE 1 END,r.attempted_at NULLS FIRST,r.next_reminder_at,r.created_at LIMIT $3`, [companyId, accountId, limit, now])).rows;
  for (const alert of rows) {
    const candidate = alert.candidate;
    const due = alert.state === 'pending' ? 0 : !alert.reminder1_sent_at ? 1 : !alert.reminder3_sent_at ? 3 : null;
    if (due === null) { await pool.query(`UPDATE sdr_linkedin_reply_alerts SET state='reminded',next_reminder_at=NULL WHERE id=$1 AND state='sent'`, [alert.id]); continue; }
    if (due && (new Date(now) < addBusinessDays(new Date(alert.sent_at), due, 'America/Chicago') || !linkedinWindowOpen(now, CENTRAL))) continue;
    if (!validEmail(email(to)) || !validEmail(email(from)) || email(to) === email(candidate?.resolved_email)) {
      await pool.query(`UPDATE sdr_linkedin_reply_alerts SET state='failed',failure_reason='routing_unverified' WHERE id=$1`, [alert.id]); counts.failed++; continue;
    }
    const suffix = due ? `-r${due}` : '';
    const messageId = `<sdr-li-reply-${alert.id}${suffix}@proswppp.co>`;
    const marker = `[SDR LinkedIn reply ${alert.id}${suffix}]`;
    const attemptColumn = due === 0 ? 'attempted_at' : `reminder${due}_attempted_at`;
    // Each send sets the next reminder time; the third-day reminder ends the drain for this alert.
    const doneColumns = due === 0 ? "state='sent',sent_at=$2,gmail_message_id=$3,next_reminder_at=$4"
      : due === 1 ? 'reminder1_sent_at=$2,next_reminder_at=$3' : "reminder3_sent_at=$2,state='reminded',next_reminder_at=NULL";
    const doneParams = extra => (due === 0 ? [extra, addBusinessDays(new Date(now), 1, 'America/Chicago')] : due === 1 ? [addBusinessDays(new Date(alert.sent_at), 3, 'America/Chicago')] : []);
    let token;
    try { token = await getToken(email(from)); } catch { counts.failed++; continue; }
    if (alert[attemptColumn]) {
      // A previous attempt may have reached Gmail: look for it before sending again.
      let found = null, complete = true;
      try {
        for (const query of [`in:sent rfc822msgid:${messageId}`, `in:sent "${marker}"`]) {
          const page = await gmail.listThreadPage(token, { query, maxResults: 10 });
          if (page.nextPageToken) complete = false;
          if (page.threads?.length) { found = page.threads[0].id; break; }
        }
      } catch { complete = false; }
      if (found) { await pool.query(`UPDATE sdr_linkedin_reply_alerts SET ${doneColumns} WHERE id=$1`, [alert.id, now, ...doneParams(found)]); counts.reconciled++; continue; }
      if (!complete) { counts.failed++; continue; }
    }
    await pool.query(`UPDATE sdr_linkedin_reply_alerts SET ${attemptColumn}=$2 WHERE id=$1`, [alert.id, now]);
    const sent = await sentMessages(pool, candidate);
    const content = replyAlertContent(alert, { candidate, sent, appBase, reminder: due });
    try {
      const receipt = await gmail.sendMail(token, { from: email(from), to: email(to), subject: content.subject, bodyText: `${content.bodyText}\n\n${marker}`, messageId });
      await pool.query(`UPDATE sdr_linkedin_reply_alerts SET ${doneColumns} WHERE id=$1`, [alert.id, now, ...doneParams(receipt?.id || null)]);
      if (due) counts.reminders++; else counts.sent++;
    } catch { counts.failed++; }
  }
  return counts;
}

export async function markReplyAlertHandled(pool, { companyId, accountId, alertId, actor, viewer, now = new Date() }) {
  const row = (await pool.query(`UPDATE sdr_linkedin_reply_alerts r SET state='answered',answered_at=$4,answered_by=$5 FROM sdr_linkedin_candidates c
    WHERE c.id=r.candidate_id AND r.company_id=$1 AND r.account_id=$2 AND r.id=$3 AND r.state IN ('pending','sent','reminded','failed') AND ($6::text IS NULL OR c.owner_id=$6) RETURNING r.id,r.state,r.answered_at`, [companyId, accountId, alertId, now, actor, viewer?.role === 'admin' ? null : viewer?.sub || ''])).rows[0];
  if (!row) throw fail('not_found');
  return row;
}

export async function listReplyAlerts(pool, { companyId, accountId, viewer, limit = 50 }) {
  return (await pool.query(`SELECT r.id,r.state,r.lane,r.reply_text,r.suggested_answer,r.thread_url,r.created_at,r.sent_at,r.reminder1_sent_at,r.reminder3_sent_at,r.answered_at,r.failure_reason,
    c.id AS candidate_id,c.source_context->>'fullName' AS name,c.firm AS company,c.role AS title,c.profile_url
    FROM sdr_linkedin_reply_alerts r JOIN sdr_linkedin_candidates c ON c.id=r.candidate_id
    WHERE r.company_id=$1 AND r.account_id=$2 AND ($3::text IS NULL OR c.owner_id=$3)
    ORDER BY CASE WHEN r.state IN ('pending','sent','reminded','failed') THEN 0 ELSE 1 END,r.created_at DESC LIMIT $4`, [companyId, accountId, viewer?.role === 'admin' ? null : viewer?.sub || '', Math.min(200, limit)])).rows;
}
