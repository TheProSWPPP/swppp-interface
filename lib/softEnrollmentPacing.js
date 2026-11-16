import { softGuardState, softDraft, sequenceBounceRates } from './softVerdictGuard.js';
export const SOFT_SEQUENCE_BATCH = 5;
export const SOFT_SETTLE_HOURS = 72;
const hold = (code, message) => Object.assign(new Error(message), { code, status: 409, preserveDraft: true });

// Caller owns a dedicated provider-contact-lock client and releases ALL session locks in its
// finally block. Serialize soft reservations across sequences to enforce both the daily cap
// and each sequence's five-address batch. Valid addresses never enter this function.
export async function claimSoftEnrollment(client, draft) {
  try { return await claim(client, draft); }
  catch (error) {
    if (error?.preserveDraft) throw error;
    throw hold('soft_bounce_guard', 'Uncertain-address checks are temporarily unavailable; this draft remains queued.');
  }
}
async function claim(client, draft) {
  await client.query("SELECT pg_advisory_lock(hashtextextended('sdr:soft-admission',0))");
  const settings = (await client.query('SELECT * FROM sdr_settings WHERE id=1')).rows[0];
  const guard = await softGuardState(client, settings);
  const sequence = String(draft.apollo_sequence_id || '');
  if (!guard.available || !guard.covered?.has(sequence) || guard.bouncing.has(sequence))
    throw hold('soft_bounce_guard', 'Uncertain address held until recent, complete delivery checks show this sequence below the bounce guard.');
  const email = String(draft.contact_email_snapshot || '').trim().toLowerCase();
  const prior = (await client.query('SELECT * FROM sdr_soft_enrollment_checks WHERE draft_id=$1 AND draft_revision=$2', [draft.id, draft.revision])).rows[0];
  if (prior) {
    if (prior.sequence_id !== sequence || prior.recipient_email !== email) throw hold('soft_bounce_guard', 'Uncertain-address reservation no longer matches this draft.');
    return prior; // Same attempted enrollment owns its slot, including ambiguous provider outcomes.
  }
  const { rows } = await client.query(`WITH admissions AS (
    SELECT draft_id,sequence_id,recipient_email,checked_at FROM sdr_soft_enrollment_checks
    UNION ALL
    SELECT d.id,s.apollo_sequence_id,lower(btrim(d.contact_email_snapshot)),s.created_at
      FROM sdr_sends s JOIN sdr_drafts d ON d.id=s.draft_id
      WHERE ${softDraft('d')} AND NOT EXISTS (SELECT 1 FROM sdr_soft_enrollment_checks c WHERE c.draft_id=d.id)
  ) SELECT count(DISTINCT draft_id) FILTER (WHERE checked_at >= (date_trunc('day',NOW() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'))::int AS daily,
    count(DISTINCT draft_id) FILTER (WHERE sequence_id=$1 AND (
      checked_at > NOW()-make_interval(hours=>$2::int) OR NOT EXISTS (
        SELECT 1 FROM sdr_reporting_messages m WHERE m.provider='apollo' AND m.direction='out'
          AND m.campaign_id=admissions.sequence_id AND lower(btrim(m.prospect_email))=admissions.recipient_email
          AND m.sequence_step=1 AND m.occurred_at>=admissions.checked_at
          AND m.occurred_at<=NOW()-make_interval(hours=>$2::int)
          AND (m.provider_status='completed' OR m.bounce IS TRUE OR m.spam_blocked IS TRUE)
      )))::int AS unsettled FROM admissions`, [sequence, SOFT_SETTLE_HOURS]);
  const usage = rows[0];
  if (!usage || !Number.isInteger(usage.daily) || !Number.isInteger(usage.unsettled) || usage.daily >= guard.cap || usage.unsettled >= SOFT_SEQUENCE_BATCH)
    throw hold('soft_cap_reached', 'Uncertain address waiting for its small batch to settle. Verified addresses can continue.');
  const rate = (await sequenceBounceRates(client)).find(r=>r.sequenceId===sequence);
  if (rate?.paused) throw hold('soft_bounce_guard', 'New bounce evidence requires the uncertain address to wait.');
  const result = await client.query(`INSERT INTO sdr_soft_enrollment_checks(draft_id,draft_revision,sequence_id,recipient_email,evidence)
    VALUES($1,$2,$3,$4,$5) RETURNING *`, [draft.id,draft.revision,sequence,email,JSON.stringify({daily:usage.daily,unsettled:usage.unsettled,dailyCap:guard.cap,batch:SOFT_SEQUENCE_BATCH,settleHours:SOFT_SETTLE_HOURS,coverage:'complete_recent',fullScanAt:guard.coverage.completedAt,observedAt:guard.coverage.observedBySequence[sequence],bounce:rate || {sequenceId:sequence,bounced:0,attempted:0,rate:null}})]);
  return result.rows[0];
}
