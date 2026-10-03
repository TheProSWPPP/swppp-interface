import { randomUUID } from 'node:crypto';
import { chicagoBusinessHours } from './sdrJobRuns.js';

const MAX_ATTEMPTS = 5;
const LEASE_MS = 10 * 60 * 1000;
const ORIGINS = new Set(['auto','auto-switch']);
const REVIEW_CODES = new Set(['campaign_conflict','customer','invalid_address','invalid_email','crm_archived',
  'crm_missing','draft_expired','contact_changed','replied','unsubscribed','active_membership','contact_cooldown',
  'draft_stale','already_sent','not_eligible','enrollment_uncertain','email_unverified','apollo_skipped']);
const REVIEW_ALIASES = new Map([['existing_customer','customer'],['draft_too_old','draft_expired'],['already_outreached','contact_cooldown']]);
const localDay = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'});
export function enrollmentRetryEnabled() { return process.env.SDR_ENROLLMENT_RETRY_ENABLED === 'true'; }

// An internal-route transport failure / generic 5xx cannot prove Apollo did not enroll.
// Only definite refusal or explicit pre-provider evidence permits automatic retry.
export function classifyEnrollmentRefusal({ httpStatus, code, preEnrollment = false, retryAfterSec } = {}) {
  const after = Number(retryAfterSec);
  const delay = (fallback) => Number.isFinite(after) && after > 0 ? after * 1000 : fallback;
  if (code === 'daily_cap_reached') return { category:'capacity',retryable:true,retryAfterMs:delay(3600000) };
  if (code === 'crm_unverified') return { category:'crm_unverified',retryable:true,retryAfterMs:delay(900000) };
  if (REVIEW_ALIASES.has(code)) return { category:REVIEW_ALIASES.get(code),retryable:false,retryAfterMs:null };
  if (REVIEW_CODES.has(code)) return { category:code,retryable:false,retryAfterMs:null };
  if (httpStatus === 429) return { category:'rate_limit',retryable:true,retryAfterMs:delay(900000) };
  if (httpStatus >= 500 && preEnrollment) return { category:'provider_error',retryable:true,retryAfterMs:delay(300000) };
  if (!httpStatus || httpStatus >= 500) return { category:'enrollment_uncertain',retryable:false,retryAfterMs:null };
  return { category:'unclassified',retryable:false,retryAfterMs:null };
}

function retrySlot(now, policy, result) {
  let candidate = new Date(now.getTime() + policy.retryAfterMs);
  // A local daily cap won't recover later the same day. Provider reset timing wins
  // when explicitly supplied; otherwise choose the next Chicago business day.
  const nextDay = policy.category === 'capacity' && !(Number(result.retryAfterSec) > 0);
  const day = localDay.format(now);
  if (chicagoBusinessHours(candidate) && (!nextDay || localDay.format(candidate) !== day)) return candidate;
  candidate = new Date(Math.ceil(candidate.getTime()/60000)*60000);
  while (!chicagoBusinessHours(candidate) || (nextDay && localDay.format(candidate) === day)) candidate = new Date(candidate.getTime()+60000);
  return candidate;
}

/** Durable receipt BEFORE a first automatic request. A crashed request enters review. */
export async function beginEnrollmentAttempt(pool,draftId,{origin,now=new Date(),leaseMs=LEASE_MS}={}) {
  if (!enrollmentRetryEnabled()) return {skipped:'disabled'};
  if (!ORIGINS.has(origin)) return {skipped:'not_automatic'};
  const token = randomUUID();
  const {rows} = await pool.query(`INSERT INTO sdr_enrollment_attempts
    (draft_id,origin,status,category,attempt_count,first_attempt_at,last_attempt_at,lease_token,lease_expires_at)
    SELECT d.id,$2,'running','in_progress',0,$3,$3,$4,$5 FROM sdr_drafts d
    WHERE d.id=$1 AND d.status IN ('pending','approved','edited') AND d.sent_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM sdr_sends s WHERE s.draft_id=d.id)
    ON CONFLICT(draft_id) DO NOTHING RETURNING *`,
  [draftId,origin,now,token,new Date(now.getTime()+leaseMs)]);
  return rows[0] || null;
}

/** Validate ownership immediately before a guarded request; expired leases never revive. */
export async function renewEnrollmentLease(pool,draftId,leaseToken,{now=new Date(),leaseMs=LEASE_MS}={}) {
  if (!enrollmentRetryEnabled() || !leaseToken) return false;
  const {rowCount}=await pool.query(`UPDATE sdr_enrollment_attempts
    SET lease_expires_at=GREATEST(lease_expires_at,$4::timestamptz),updated_at=$3
    WHERE draft_id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at > $3`,
  [draftId,leaseToken,now,new Date(now.getTime()+leaseMs)]);
  return rowCount === 1;
}

/** Record only explicitly automatic attempts; never store raw error bodies or drafts. */
export async function recordEnrollmentAttempt(pool,draftId,result={}) {
  if (!enrollmentRetryEnabled()) return {skipped:'disabled'};
  if (!ORIGINS.has(result.origin)) return {skipped:'not_automatic'};
  const now = result.now || new Date();
  const policy = result.accepted ? {category:'accepted',retryable:false} : classifyEnrollmentRefusal(result);
  const status = result.accepted ? 'accepted' : policy.retryable ? 'pending' : 'review';
  const next = policy.retryable ? retrySlot(now,policy,result) : null;
  const receipt = typeof result.receiptId === 'string' && /^[\w:./-]{1,254}$/.test(result.receiptId) ? result.receiptId : null;
  const {rows} = await pool.query(`INSERT INTO sdr_enrollment_attempts
    (draft_id,origin,status,category,attempt_count,first_attempt_at,last_attempt_at,next_retry_at,provider_receipt_id)
    VALUES($1,$2,$3,$4,1,$5,$5,$6,$7)
    ON CONFLICT(draft_id) DO UPDATE SET
      status=CASE WHEN sdr_enrollment_attempts.attempt_count+1 >= $9 AND $3='pending' THEN 'exhausted' ELSE $3 END,
      category=$4,attempt_count=sdr_enrollment_attempts.attempt_count+1,last_attempt_at=$5,
      next_retry_at=CASE WHEN sdr_enrollment_attempts.attempt_count+1 >= $9 THEN NULL ELSE $6 END,
      lease_token=NULL,lease_expires_at=NULL,provider_receipt_id=COALESCE($7,sdr_enrollment_attempts.provider_receipt_id),updated_at=$5
    WHERE sdr_enrollment_attempts.status NOT IN ('accepted','exhausted')
      AND sdr_enrollment_attempts.attempt_count < $9
      AND (($8::uuid IS NOT NULL AND sdr_enrollment_attempts.lease_token=$8)
        OR ($8::uuid IS NULL AND sdr_enrollment_attempts.status='pending'))
    RETURNING *`,
  [draftId,result.origin,status,policy.category,now,next,receipt,result.leaseToken || null,MAX_ATTEMPTS]);
  if (rows[0]) return rows[0];
  return (await pool.query('SELECT * FROM sdr_enrollment_attempts WHERE draft_id=$1',[draftId])).rows[0] || null;
}

/** CLAIM due receipts, never scan/adopt the historic pending-draft queue. No sending. */
export async function listDueEnrollmentRetries(pool,{now=new Date(),limit=25,leaseMs=LEASE_MS}={}) {
  if (!enrollmentRetryEnabled()) return [];
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Lease death may have occurred after a provider accepted the request. Do not replay.
    await client.query(`UPDATE sdr_enrollment_attempts SET status='review',category='enrollment_uncertain',
      next_retry_at=NULL,lease_expires_at=NULL,updated_at=$1
      WHERE status='running' AND lease_expires_at <= $1`,[now]);
    await client.query(`UPDATE sdr_enrollment_attempts a SET status='review',
      category=CASE WHEN d.created_at < $1::timestamptz - INTERVAL '14 days' THEN 'draft_expired'
        WHEN EXISTS(SELECT 1 FROM sdr_sends s WHERE s.draft_id=d.id) THEN 'local_send_exists' ELSE 'draft_unavailable' END,
      next_retry_at=NULL,updated_at=$1 FROM sdr_drafts d WHERE a.draft_id=d.id AND a.status='pending'
      AND (d.status NOT IN ('pending','approved','edited') OR d.sent_at IS NOT NULL
        OR d.created_at < $1::timestamptz - INTERVAL '14 days' OR d.assigned_user_id IS NULL OR d.assigned_mailbox_id IS NULL
        OR EXISTS(SELECT 1 FROM sdr_sends s WHERE s.draft_id=d.id))`,[now]);
    if (!chicagoBusinessHours(now)) { await client.query('COMMIT'); return []; }
    const boundedLimit = Math.max(1,Math.min(25,Number.isInteger(limit) ? limit : 25));
    const {rows}=await client.query(`WITH due AS (
      SELECT a.draft_id FROM sdr_enrollment_attempts a JOIN sdr_drafts d ON d.id=a.draft_id
      WHERE a.status='pending' AND a.next_retry_at <= $1 AND a.attempt_count < $4
        AND d.status IN ('pending','approved','edited') AND d.sent_at IS NULL
        AND d.assigned_user_id IS NOT NULL AND d.assigned_mailbox_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM sdr_sends s WHERE s.draft_id=d.id)
      ORDER BY a.next_retry_at,a.first_attempt_at FOR UPDATE OF a SKIP LOCKED LIMIT $2
    ), claimed AS (
      UPDATE sdr_enrollment_attempts a SET status='running',lease_token=gen_random_uuid(),lease_expires_at=$3,
        next_retry_at=NULL,updated_at=$1 FROM due WHERE a.draft_id=due.draft_id RETURNING a.*
    ) SELECT c.*,d.assigned_user_id,d.assigned_mailbox_id FROM claimed c JOIN sdr_drafts d ON d.id=c.draft_id`,
    [now,boundedLimit,new Date(now.getTime()+leaseMs),MAX_ATTEMPTS]);
    await client.query('COMMIT');
    return rows;
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally {client.release();}
}
