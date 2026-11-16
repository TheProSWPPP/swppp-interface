import { softGuardState, softDraft, sequenceBounceRates } from './softVerdictGuard.js';
export const SOFT_SEQUENCE_BATCH = 5;
export const SOFT_SETTLE_HOURS = 72;
// Only positive, matching no-send receipts free a reservation. Any other operation for
// the draft keeps it held, including a crash or timeout after add_started.
const noSendReceipt = c => `(EXISTS (SELECT 1 FROM sdr_provider_operations p
  WHERE p.kind='enroll' AND p.expected_membership->>'draftId'=${c}.draft_id::text
    AND p.draft_revision=${c}.draft_revision AND p.campaign_id=${c}.sequence_id
    AND p.expected_membership->>'recipientEmail'=${c}.recipient_email
    AND p.created_at>=${c}.checked_at AND p.state IN ('pre_add_refused','provider_skipped'))
  AND NOT EXISTS (SELECT 1 FROM sdr_provider_operations p
    WHERE p.kind='enroll' AND p.expected_membership->>'draftId'=${c}.draft_id::text
      AND p.state NOT IN ('pre_add_refused','provider_skipped')))`;
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
  const prior = (await client.query(`SELECT c.*,${noSendReceipt('c')} AS released FROM sdr_soft_enrollment_checks c WHERE draft_id=$1 AND draft_revision=$2`, [draft.id, draft.revision])).rows[0];
  if (prior) {
    if (prior.sequence_id !== sequence || prior.recipient_email !== email) throw hold('soft_bounce_guard', 'Uncertain-address reservation no longer matches this draft.');
    if (!prior.released) return prior; // Ambiguous outcomes retain the same slot.
    // A definite refusal released this slot. A retry must compete for a new slot below.
  }
  const usage = await softEnrollmentUsage(client,sequence);
  if (!usage || !Number.isInteger(usage.daily) || !Number.isInteger(usage.unsettled) || usage.daily >= guard.cap || usage.unsettled >= SOFT_SEQUENCE_BATCH)
    throw hold('soft_cap_reached', 'Uncertain address waiting for its small batch to settle. Verified addresses can continue.');
  const rate = (await sequenceBounceRates(client)).find(r=>r.sequenceId===sequence);
  if (rate?.paused) throw hold('soft_bounce_guard', 'New bounce evidence requires the uncertain address to wait.');
  const result = await client.query(`INSERT INTO sdr_soft_enrollment_checks(draft_id,draft_revision,sequence_id,recipient_email,evidence)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(draft_id,draft_revision) DO UPDATE
    SET checked_at=NOW(),evidence=EXCLUDED.evidence RETURNING *`, [draft.id,draft.revision,sequence,email,JSON.stringify({daily:usage.daily,unsettled:usage.unsettled,dailyCap:guard.cap,batch:SOFT_SEQUENCE_BATCH,settleHours:SOFT_SETTLE_HOURS,coverage:'complete_recent',fullScanAt:guard.coverage.completedAt,observedAt:guard.coverage.observedBySequence[sequence],bounce:rate || {sequenceId:sequence,bounced:0,attempted:0,rate:null}})]);
  return result.rows[0];
}

// A bounded historical audit can save this result without changing sends or CRM state.
// Identity and a complete membership array are mandatory; an absent field never proves removal.
export function legacySoftOutcome(send, contact) {
  const email = value => String(value || '').trim().toLowerCase();
  if (!send?.id || !send.apollo_contact_id || contact?.id !== send.apollo_contact_id
    || !email(send.recipient_email) || email(contact.email) !== email(send.recipient_email)
    || !Array.isArray(contact.contact_campaign_statuses)
    || contact.contact_campaign_statuses.some(m=>!m?.emailer_campaign_id)) return null;
  const memberships = contact.contact_campaign_statuses.filter(m=>String(m.emailer_campaign_id)===String(send.sequence_id));
  if (memberships.length>1) return null;
  const outcome = memberships.length ? memberships[0].status : 'absent';
  if (!['absent','finished','failed'].includes(outcome)) return null;
  return {sendId:send.id,sequenceId:send.sequence_id,contactId:send.apollo_contact_id,recipientEmail:email(send.recipient_email),outcome,
    evidence:{source:'apollo_contact_read',membership:memberships[0] || null}};
}

export async function softEnrollmentUsage(client,sequence) {
  const { rows } = await client.query(`WITH admissions AS (
    SELECT draft_id,sequence_id,recipient_email,checked_at,COALESCE(${noSendReceipt('c')},FALSE) AS settled FROM sdr_soft_enrollment_checks c
    UNION ALL
    SELECT d.id,s.apollo_sequence_id,lower(btrim(d.contact_email_snapshot)),s.created_at,
      COALESCE(((s.last_status_at<=NOW()-make_interval(hours=>$2::int)
        AND ((s.status='failed' AND s.step_status IN ('refused','removed','finished') AND s.apollo_emailer_message_id IS NULL)
          OR s.status IN ('bounced','replied','unsubscribed')))
        OR EXISTS (SELECT 1 FROM sdr_soft_legacy_outcomes l WHERE l.send_id=s.id
          AND l.sequence_id=s.apollo_sequence_id AND l.contact_id=s.apollo_contact_id
          AND l.recipient_email=lower(btrim(d.contact_email_snapshot))
          AND l.observed_at<=NOW()-make_interval(hours=>$2::int)))
        AND NOT EXISTS (SELECT 1 FROM sdr_reporting_messages m WHERE m.provider='apollo' AND m.direction='out'
          AND m.campaign_id=s.apollo_sequence_id AND lower(btrim(m.prospect_email))=lower(btrim(d.contact_email_snapshot))
          AND m.occurred_at>=s.created_at AND m.occurred_at>NOW()-make_interval(hours=>$2::int)),FALSE)
      FROM sdr_sends s JOIN sdr_drafts d ON d.id=s.draft_id
      WHERE ${softDraft('d')} AND NOT EXISTS (SELECT 1 FROM sdr_soft_enrollment_checks c WHERE c.draft_id=d.id)
  ) SELECT count(DISTINCT draft_id) FILTER (WHERE checked_at >= (date_trunc('day',NOW() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'))::int AS daily,
    count(DISTINCT draft_id) FILTER (WHERE sequence_id=$1 AND NOT settled AND (
      checked_at > NOW()-make_interval(hours=>$2::int) OR NOT EXISTS (
        SELECT 1 FROM sdr_reporting_messages m WHERE m.provider='apollo' AND m.direction='out'
          AND m.campaign_id=admissions.sequence_id AND lower(btrim(m.prospect_email))=admissions.recipient_email
          AND m.sequence_step=1 AND m.occurred_at>=admissions.checked_at
          AND m.occurred_at<=NOW()-make_interval(hours=>$2::int)
          AND (m.provider_status='completed' OR m.bounce IS TRUE OR m.spam_blocked IS TRUE)
      )))::int AS unsettled,
    min(checked_at) FILTER (WHERE sequence_id=$1 AND NOT settled AND NOT EXISTS (
      SELECT 1 FROM sdr_reporting_messages m WHERE m.provider='apollo' AND m.direction='out'
        AND m.campaign_id=admissions.sequence_id AND lower(btrim(m.prospect_email))=admissions.recipient_email
        AND m.sequence_step=1 AND m.occurred_at>=admissions.checked_at
        AND m.occurred_at<=NOW()-make_interval(hours=>$2::int)
        AND (m.provider_status='completed' OR m.bounce IS TRUE OR m.spam_blocked IS TRUE)
    )) AS oldest_waiting FROM admissions`, [sequence, SOFT_SETTLE_HOURS]);
  return rows[0];
}
