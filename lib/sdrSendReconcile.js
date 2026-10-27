// Stuck-enrollment reconciler. A send row says "enrolled" from the moment Apollo accepts the
// contact, and only the message poll moves it on, from messages Apollo actually sent. When Apollo
// refuses to send (invalid MX, likely to bounce) or the membership disappears (the Oct 15 removal
// from the paused PB/LBA sequences), no message ever arrives and the row says "enrolled" forever:
// 21 October rows and 168 August-September rows on 2026-10-27, none of which will ever send.
//
// Once a day this reads the Apollo contact for rows still enrolled with no email two days on and
// copies what Apollo shows onto the row:
//   - no membership in that sequence (removed)        -> failed, step 'removed'
//   - failed, Apollo refused before sending           -> failed, step 'refused'
//   - failed after an attempt (bounced, spam blocked) -> bounced
//   - finished without any email                      -> failed, step 'finished'
//   - active or paused                                -> left alone (still in the sequence)
// When Apollo refused for an invalid MX record but the domain does publish mail servers, the
// lead owner gets a Pipedrive task to email the person by hand (7 of 11 such domains on Oct 27
// were on Outlook or Mimecast).
//
// Reads only Apollo contacts (bounded per run; a 429 ends the run). Writes only our send rows
// and, for the MX case, one Pipedrive task per row (the row leaves "enrolled" in the same pass,
// so it is never raised twice).
import { promises as dns } from 'node:dns';

export const RECONCILE_AFTER_DAYS = 2;
export const RECONCILE_LIMIT = 100;
const MX_REFUSAL = /invalid mx/i;
const PRE_SEND_REFUSAL = /invalid mx|likely to bounce|not sent/i;
const ATTEMPTED_FAILURE = /bounce|spam/i;

// What Apollo's membership says about one of our rows. Exported for tests.
export function reconcileOutcome(contact, campaignId) {
  const statuses = Array.isArray(contact?.contact_campaign_statuses) ? contact.contact_campaign_statuses : null;
  if (!statuses) return { action: 'unverified' };
  const matches = statuses.filter(s => String(s?.emailer_campaign_id) === String(campaignId));
  if (matches.length > 1) return { action: 'unverified' };
  if (!matches.length) return { action: 'update', status: 'failed', step: 'removed', reason: 'membership_absent' };
  const m = matches[0];
  const status = String(m.status || '').toLowerCase();
  const reason = String(m.inactive_reason || m.paused_reason || '');
  if (status === 'failed') {
    if (PRE_SEND_REFUSAL.test(reason)) return { action: 'update', status: 'failed', step: 'refused', reason, mxRefusal: MX_REFUSAL.test(reason) };
    if (ATTEMPTED_FAILURE.test(reason)) return { action: 'update', status: 'bounced', step: 'bounced', reason };
    return { action: 'update', status: 'failed', step: 'refused', reason: reason || 'failed' };
  }
  if (status === 'finished') return { action: 'update', status: 'failed', step: 'finished', reason: reason || 'finished' };
  return { action: 'leave', reason: status || 'unknown' };
}

const domainOf = email => String(email || '').trim().toLowerCase().split('@')[1] || null;

export async function reconcileStuckSends(pool, {
  apollo, addActivity, resolveMx = dns.resolveMx, limit = RECONCILE_LIMIT, afterDays = RECONCILE_AFTER_DAYS,
} = {}) {
  const stats = { checked: 0, removed: 0, refused: 0, bounced: 0, finished: 0, left: 0, unverified: 0, mxTasks: 0, rateLimited: false };
  const { rows } = await pool.query(
    `SELECT s.id, s.pipedrive_lead_id, s.apollo_contact_id, s.apollo_sequence_id, d.contact_email_snapshot AS email
       FROM sdr_sends s LEFT JOIN sdr_drafts d ON d.id = s.draft_id
      WHERE s.status = 'enrolled'
        AND s.sent_at < NOW() - make_interval(days => $1::int)
        AND s.apollo_contact_id IS NOT NULL AND s.apollo_sequence_id IS NOT NULL
        AND s.apollo_emailer_message_id IS NULL
        AND coalesce(s.step_status,'') NOT IN ('sent','replied','bounced','completed','finished')
        AND NOT EXISTS (SELECT 1 FROM sdr_message_facts f WHERE f.provider='apollo' AND f.direction='out'
              AND f.provider_status='completed' AND f.occurred_at >= s.sent_at - INTERVAL '1 hour'
              AND lower(btrim(f.prospect_email)) = lower(btrim(d.contact_email_snapshot)))
      ORDER BY s.sent_at ASC
      LIMIT $2`,
    [afterDays, limit],
  );
  for (const row of rows) {
    let contact;
    try { contact = await apollo.getContact(String(row.apollo_contact_id)); }
    catch (error) {
      if (Number(error?.status) === 429) { stats.rateLimited = true; break; }
      stats.unverified++; continue;
    }
    stats.checked++;
    if (String(contact?.id) !== String(row.apollo_contact_id)) { stats.unverified++; continue; }
    const outcome = reconcileOutcome(contact, row.apollo_sequence_id);
    if (outcome.action === 'unverified') { stats.unverified++; continue; }
    if (outcome.action === 'leave') { stats.left++; continue; }
    const updated = await pool.query(
      `UPDATE sdr_sends SET status=$2, step_status=$3, next_send_at=NULL, last_status_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND status='enrolled' AND apollo_emailer_message_id IS NULL RETURNING id`,
      [row.id, outcome.status, outcome.step],
    );
    if (!updated.rowCount) continue;
    stats[outcome.step] = (stats[outcome.step] || 0) + 1;
    if (outcome.mxRefusal && addActivity && row.pipedrive_lead_id) {
      const domain = domainOf(row.email);
      let mailServers = [];
      try { mailServers = domain ? await resolveMx(domain) : []; } catch { mailServers = []; }
      if (mailServers.length) {
        try {
          await addActivity({
            leadId: row.pipedrive_lead_id, type: 'task',
            subject: `Email ${row.email} by hand: Apollo refused it (invalid MX) but the domain has mail servers`,
            note: `Apollo would not send the cold sequence to ${row.email} ("${outcome.reason}"). DNS shows mail servers for ${domain} (${mailServers.slice(0, 3).map(m => m.exchange).join(', ')}), so the address is likely fine. Nothing was sent. Please email them from your own inbox.`,
          });
          stats.mxTasks++;
        } catch (error) { console.warn(`[send-reconcile] MX task not created for lead ${row.pipedrive_lead_id}: ${error.message}`); }
      }
    }
  }
  return stats;
}
