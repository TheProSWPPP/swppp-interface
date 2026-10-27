// Auto-outreach engine. When enabled (sdr_settings.auto_outreach_enabled), fills each
// ACTIVE mailbox's remaining daily cap with the top lead-score eligible leads (fresh +
// has a trigger), rotating across senders. Default mode 'queue' only creates drafts — a
// human still approves before anything sends (approve-and-send does the live dedup). All
// existing guardrails (warmup ramp, unique-draft index) apply.
import { isBidInviteOrigin, notOnOpenBidInviteLead, bidInviteLeadFor } from './bidInviteGuard.js';
import { buildDraftFromLead } from "./sdrDraftGenerator.js";
import { dailyCap, mailboxBounceHealth } from "./sendRamp.js";
import { crmLifecycleEnabled } from './sdrCrmGuard.js';
import {randomUUID} from 'node:crypto';
import {withLeadLock} from './sdrAccess.js';
import {assertOutreachAllowed} from './sdrOutreachControls.js';
import {recentReplyEmails,normalEmail} from './recentReply.js';
import {canonicalVerdict,looksLikeEmail} from './emailVerify.js';
import {enrollmentRetryEnabled,retryableDraftAgeDays} from './sdrEnrollmentRetry.js';
import {isCustomerLead} from './customerSuppression.js';
import {softGuardState,SOFT_VERDICT_VALUES,VALID_VERDICT_VALUES} from './softVerdictGuard.js';
import {FAILED_DRAFT_BACKOFF_DAYS,DRAFT_EXPIRY_DAYS,STAFF_DRAFT_EXPIRY_DAYS,AUTO_EXPIRED_REASON_PREFIX,staffApproval,outreachHistoryBlocks,presentTables} from './outreachHistory.js';

// Draft history rules live in lib/outreachHistory.js (shared with the verification pass).
export {FAILED_DRAFT_BACKOFF_DAYS,DRAFT_EXPIRY_DAYS,STAFF_DRAFT_EXPIRY_DAYS,AUTO_EXPIRED_REASON_PREFIX};

// Same freshness window as the verification cache (STALE_MS in lib/emailVerifyRefresh.js).
const VERIFIED_MAX_AGE_DAYS = 90;
// The verdict automation may send on: a fresh one (under 90 days) for this exact address, which
// must look like an address. 'valid', or 'soft' (catch-all/unknown) since 2026-10-27, when Ivan
// asked for bid-list contacts with a soft verdict to be emailed too (lib/softVerdictGuard.js
// caps them per day and stops them for a sequence that is bouncing). Anything else is null:
// never verified (the verification pass checks it first), stale, or confident-bad.
// Verdicts come from the contacts-refresh pass (runVerificationPass, VERIFY_PASS_LIMIT per sync).
export function sendableVerdict(lead, email = lead?.person_email, now = Date.now()) {
  if (!lead || !looksLikeEmail(email) || lead.email_verified_value !== email || !lead.email_verified_at) return null;
  if (now - new Date(lead.email_verified_at).getTime() >= VERIFIED_MAX_AGE_DAYS * 86400000) return null;
  const verdict = canonicalVerdict(lead.email_verify_status);
  return verdict === 'valid' || verdict === 'soft' ? verdict : null;
}
// Valid only: used where a soft verdict is not enough (Apollo's job-change retry).
export function emailConfirmedValid(lead, email = lead?.person_email, now = Date.now()) {
  return sendableVerdict(lead, email, now) === 'valid';
}

// Mirrors the scoped-control contract for bulk housekeeping. Missing service/recipient
// evidence retains a potentially applicable restriction; calls do not block email.
const withoutHold=(alias,parameter)=>`NOT EXISTS(SELECT 1 FROM sdr_outreach_controls c
 WHERE c.company_id=${parameter} AND c.status='active'
 AND (c.lead_id IS NULL OR c.lead_id=${alias}.pipedrive_lead_id) AND (c.channel IS NULL OR c.channel='email')
 AND CASE c.scope_kind
 WHEN 'lead' THEN c.scope_id=${alias}.pipedrive_lead_id
 WHEN 'draft' THEN c.scope_id=${alias}.id::text
 WHEN 'recipient' THEN ${alias}.contact_email_snapshot IS NULL OR c.scope_id=lower(trim(${alias}.contact_email_snapshot))
 WHEN 'service' THEN ${alias}.metadata->>'service_id' IS NULL OR c.scope_id=${alias}.metadata->>'service_id'
 WHEN 'channel' THEN c.scope_id='email' ELSE TRUE END)`;


// Prune queued drafts that went stale: the contact got emailed in Pipedrive AFTER we
// queued the draft (person last_outgoing_mail_time moved past the draft's created_at).
// Auto-rejects them so a rep never approves an already-contacted lead. Returns the count.
export async function pruneStaleQueuedDrafts(pool,{companyId=process.env.SDR_CRM_COMPANY_ID}={}) {
  if(!companyId)return 0;
  const { rowCount } = await pool.query(`
    UPDATE sdr_drafts d
       SET status = 'rejected',
           reject_reason = 'auto: contact emailed in Pipedrive after this was queued',
           updated_at = NOW()
      FROM sdr_lead_state s
     WHERE d.pipedrive_lead_id = s.pipedrive_lead_id
       AND d.status = 'pending' AND d.content_origin = 'machine'
       AND d.sent_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM sdr_sends sent WHERE sent.draft_id=d.id)
       AND NOT ${staffApproval('d')}
       AND ${withoutHold('d','$1')}
       AND s.last_outgoing_mail_time IS NOT NULL
       AND s.last_outgoing_mail_time > d.created_at
  `,[String(companyId)]);
  return rowCount || 0;
}

// Auto-reject queued drafts that simply aged out. Without this they sit in the Queue
// forever — 92 of them on 2026-08-06, the oldest from June 28 — where a rep can still
// approve one and send bid copy about a job that closed a month ago.
// Every origin expires: machine copy and legacy drafts of unknown origin by age, a draft a
// person edited or regenerated only once nobody touched it for STAFF_DRAFT_EXPIRY_DAYS. A
// person's approval receipt or an active hold still keeps a draft where it is.
// With enrollment retry on, a draft whose automatic send is scheduled for another attempt
// (receipt 'pending') or is in flight ('running') is left alone while the send gate would still
// accept its age (staleDraftBlock). After that the retry claim marks it draft_expired and the
// next expiry pass rejects it as usual.
export async function expireStaleQueuedDrafts(pool, { days = DRAFT_EXPIRY_DAYS,staffDays=STAFF_DRAFT_EXPIRY_DAYS,companyId=process.env.SDR_CRM_COMPANY_ID,retryEnabled=enrollmentRetryEnabled() } = {}) {
  if(!companyId)return 0;
  const { rowCount } = await pool.query(
    `UPDATE sdr_drafts
        SET status = 'rejected',
            reject_reason = '${AUTO_EXPIRED_REASON_PREFIX}' || $1::int || ' days',
            updated_at = NOW()
      WHERE status = 'pending'
        AND sent_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM sdr_sends sent WHERE sent.draft_id=sdr_drafts.id)
        AND NOT ${staffApproval('sdr_drafts')}
        AND ${withoutHold('sdr_drafts','$2')}
        ${retryEnabled ? `AND NOT (created_at > NOW() - make_interval(days => $4::int) AND EXISTS(
          SELECT 1 FROM sdr_enrollment_attempts retry WHERE retry.draft_id=sdr_drafts.id AND retry.status IN ('pending','running')))` : ''}
        AND created_at < NOW() - make_interval(days => $1::int)
        AND (content_origin = 'machine'
          OR (content_origin = 'unknown' AND initiated_by IN ('automatic','auto-switch'))
          OR coalesce(updated_at, created_at) < NOW() - make_interval(days => $3::int))`,
    retryEnabled ? [days,String(companyId),staffDays,retryableDraftAgeDays()] : [days,String(companyId),staffDays],
  );
  return rowCount || 0;
}

// Pending automatic drafts from before enrollment retry was on have no attempt receipt, so
// the retry path never picks them up and they expire after DRAFT_EXPIRY_DAYS. This gives the
// ones that could still send a receipt due now. It only schedules: every attempt still goes
// through refreshRetryDraft and the full approve-and-send checks. Idempotent (one receipt per
// draft, ON CONFLICT DO NOTHING) and limited to drafts the send path would not refuse for a
// reason visible here:
// - machine copy the automation created, still pending, never approved, sent or held, with a
//   sender, and young enough for the send gate's age check;
// - an address with a fresh valid verdict (approve-and-send refuses anything else);
// - an address we have never sequenced: the provider membership guard refuses a contact with
//   any earlier enrollment and places a lead hold (lib/sdrProviderOperations.js);
// - no recent human reply from the address, an active CRM lead;
// - no earlier automatic refusal with a code that does not clear by waiting.
const WAITABLE_REFUSALS = ['daily_cap_reached','sequence_paused','crm_unverified','unknown','soft_cap_reached','soft_bounce_guard'];
export async function adoptPendingAutomaticDrafts(pool,{companyId=process.env.SDR_CRM_COMPANY_ID,now=new Date(),lifecycleEnabled=crmLifecycleEnabled()}={}) {
  if(!enrollmentRetryEnabled())return {skipped:'disabled',adopted:0};
  if(!companyId)return {skipped:'company_scope_unverified',adopted:0};
  const replied=await recentReplyEmails(pool);
  const observed=Boolean((await pool.query("SELECT to_regclass('sdr_approval_observations') AS t")).rows[0]?.t);
  const {rowCount}=await pool.query(`INSERT INTO sdr_enrollment_attempts
      (draft_id,origin,status,category,attempt_count,first_attempt_at,last_attempt_at,next_retry_at)
    SELECT d.id,'auto','pending','adopted',0,$1,$1,$1
      FROM sdr_drafts d JOIN sdr_lead_state s ON s.pipedrive_lead_id=d.pipedrive_lead_id
     WHERE d.status='pending' AND d.content_origin='machine' AND d.initiated_by='automatic'
       AND d.sent_at IS NULL AND d.assigned_user_id IS NOT NULL AND d.assigned_mailbox_id IS NOT NULL
       AND d.created_at > $1::timestamptz - make_interval(days => $2::int)
       AND NOT EXISTS(SELECT 1 FROM sdr_sends x WHERE x.draft_id=d.id)
       AND NOT EXISTS(SELECT 1 FROM sdr_draft_approvals a WHERE a.draft_id=d.id)
       AND ${withoutHold('d','$3')}
       AND (s.crm_company_id IS NULL OR s.crm_company_id=$3)
       ${lifecycleEnabled ? "AND s.crm_status='active'" : ''}
       AND s.email_verified_value=d.contact_email_snapshot
       AND s.email_verified_at > $1::timestamptz - make_interval(days => $4::int)
       AND lower(btrim(s.email_verify_status)) IN ('ok','valid')
       AND NOT (lower(trim(d.contact_email_snapshot)) = ANY($5::text[]))
       AND NOT EXISTS(SELECT 1 FROM sdr_sends x JOIN sdr_drafts prior ON prior.id=x.draft_id
         WHERE lower(trim(prior.contact_email_snapshot))=lower(trim(d.contact_email_snapshot)))
       AND NOT EXISTS(SELECT 1 FROM sdr_message_facts f WHERE f.provider='apollo' AND f.direction='out'
         AND lower(trim(f.prospect_email))=lower(trim(d.contact_email_snapshot)))
       ${observed ? `AND NOT EXISTS(SELECT 1 FROM sdr_approval_observations o WHERE o.draft_id=d.id AND o.origin='machine'
         AND o.observation_kind='http_refusal' AND NOT (o.response_code = ANY($6::text[])))` : ''}
    ON CONFLICT (draft_id) DO NOTHING`,
  [now,retryableDraftAgeDays(),String(companyId),VERIFIED_MAX_AGE_DAYS,[...replied],...(observed?[WAITABLE_REFUSALS]:[])]);
  return {adopted:rowCount||0};
}

// The automatic-outreach candidate query, exported so the funnel can be measured read-only
// against real data (it only reads). `replied` is recentReplyEmails(); `tables` presentTables().
//
// Eligible leads: fresh (no prior contact), has a trigger, score floor honored, no open
// draft already, and the project START date is in the future — the work hasn't begun, so
// they still need SWPPP. Past-start projects are already underway; we don't auto-chase
// those. Manual sends ignore this gate.
//
// Both gates widen from sdr_settings, and both default to the original hardcoded behaviour
// (see the column comments in server.js). 'clear' alone is a permanent lockout because
// nothing ever converts 'contacted_stale' back — recontact_after_days is what expires it.
export async function selectAutoOutreachCandidates(db,{settings,companyId,lifecycleEnabled=crmLifecycleEnabled(),replied=new Set(),tables,seen=new Set(),limit=100,softAllowed=true}) {
  tables = tables || await presentTables(db);
  const minScore = settings.auto_min_score;
  const recontactAfterDays = settings.recontact_after_days ?? null;
  const startGraceDays = settings.start_date_grace_days ?? 0;
  return db.query(
    `SELECT s.pipedrive_lead_id, s.trigger_type, s.pipedrive_person_id, s.pipedrive_org_id, s.person_email, s.project_stage, s.trigger_override, s.crm_company_id,
            s.email_verify_status, s.email_verified_at, s.email_verified_value
       FROM sdr_lead_state s
      WHERE (
              s.outreach_status = 'clear'
              OR ($3::int IS NOT NULL
                  AND s.outreach_status = 'contacted_stale'
                  AND s.last_outgoing_mail_time < NOW() - make_interval(days => $3::int))
            )
        AND (s.crm_company_id IS NULL OR s.crm_company_id=$5)
        AND NOT (s.pipedrive_lead_id = ANY($6::text[]))
        AND s.trigger_type IS NOT NULL
        ${lifecycleEnabled ? "AND s.crm_status = 'active'" : ''}
        AND ($1::float8 IS NULL OR s.lead_score >= $1)
        AND s.start_date >= CURRENT_DATE - $4::int
        -- Bid-tracker contacts (Lead Origin "Bid Invite...") are customers and warm leads:
        -- never part of the cold drip, whatever their dates. See lib/bidInviteGuard.js.
        AND lower(btrim(coalesce(s.lead_origin,''))) NOT LIKE 'bid invite%'
        -- ...nor through another lead when the same person is on an open bid-sheet lead.
        AND ${notOnOpenBidInviteLead('s')}
        AND NOT (lower(trim(coalesce(s.person_email,''))) = ANY($7::text[]))
        -- Only a fresh valid or soft verdict for the current address (see sendableVerdict); soft
        -- ones only while the day's soft quota lasts ($9). Valid addresses come first.
        -- Skipped here, these leads use no scan budget and no sender capacity.
        -- Not "na", a phone number or a name (looksLikeEmail in lib/emailVerify.js).
        AND s.person_email LIKE '%_@_%._%' AND s.person_email !~ '\\s'
        AND s.email_verified_value = s.person_email
        AND s.email_verified_at > NOW() - make_interval(days => $8::int)
        AND (lower(btrim(s.email_verify_status)) = ANY($10::text[]) OR ($9::boolean AND lower(btrim(s.email_verify_status)) = ANY($11::text[])))
        -- Draft, send and person history (outreachHistoryBlocks). A staff rejection or
        -- cancellation stays a review decision indefinitely and a CRM edit does not release it;
        -- a draft that only aged out does not. Failures keep their bounded backoff, the same
        -- window as the in-lock history check below (FAILED_DRAFT_BACKOFF_DAYS). A lead we ever
        -- sent to stays out in any state (a reply clears the Pipedrive Sequence_Started field,
        -- which flips outreach_status back to 'clear'), except a send row marked failed that
        -- never produced an email.
        AND NOT ${outreachHistoryBlocks({lead:'s.pipedrive_lead_id',person:'s.pipedrive_person_id',emails:"ARRAY[lower(btrim(s.person_email))]"},tables)}
        -- An active hold on the lead or on this address would refuse the draft anyway
        -- (assertOutreachAllowed below stays the authoritative check).
        AND NOT EXISTS(SELECT 1 FROM sdr_outreach_controls c WHERE c.company_id=$5 AND c.status='active'
          AND (c.channel IS NULL OR c.channel='email')
          AND (c.scope_kind='lead' AND c.scope_id=s.pipedrive_lead_id
            OR c.scope_kind='recipient' AND c.scope_id=lower(btrim(s.person_email)) AND (c.lead_id IS NULL OR c.lead_id=s.pipedrive_lead_id)
            OR c.scope_kind='channel' AND c.scope_id='email' AND (c.lead_id IS NULL OR c.lead_id=s.pipedrive_lead_id)))
        -- AUTHORITATIVE dedup: the outreach ledger captures EVERY send, including a rep's
        -- manual Pipedrive email (source 'pipedrive') that never stamped the person's
        -- last_outgoing_mail_time (so outreach_status read 'clear' and the lead looked fresh).
        -- This is the guard that stops auto-outreach double-touching an already-emailed lead.
        AND NOT EXISTS (
          SELECT 1 FROM sdr_outreach_log ol
           WHERE ol.pipedrive_lead_id = s.pipedrive_lead_id
             AND ol.sent_at > NOW() - INTERVAL '60 days'
        )
      ORDER BY (lower(btrim(s.email_verify_status)) = ANY($10::text[])) DESC, s.lead_score DESC NULLS LAST, s.synced_at ASC NULLS LAST, s.pipedrive_lead_id ASC
      LIMIT $2`,
    [minScore ?? null, limit, recontactAfterDays, startGraceDays,String(companyId),[...seen],[...replied],VERIFIED_MAX_AGE_DAYS,
      softAllowed,VALID_VERDICT_VALUES,SOFT_VERDICT_VALUES],
  );
}

// Run one auto-outreach pass. `mailboxSentToday(id)` → today's send count for a mailbox
// (the shared SDR+permit daily counter). Creates drafts only (queue mode).
export async function runAutoOutreach(pool, { mailboxSentToday, maxDrafts, lifecycleEnabled = crmLifecycleEnabled(), companyId=process.env.SDR_CRM_COMPANY_ID } = {}) {
  const { rows: srows } = await pool.query(`SELECT * FROM sdr_settings WHERE id = 1`);
  const settings = srows[0];
  if (!settings || !settings.auto_outreach_enabled) return { skipped: "disabled" };
  if(!companyId)return {skipped:"company_scope_unverified",created:0};

  // Active, Apollo-linked mailboxes + remaining capacity under the warmup ramp.
  const { rows: mbs } = await pool.query(
    `SELECT id, email, owner_user_id, warmup_started_at, daily_send_limit
       FROM sdr_mailboxes
      WHERE active = TRUE AND apollo_mailbox_id IS NOT NULL AND owner_user_id IS NOT NULL`,
  );
  // One query for the whole rotation: a mailbox that has been bouncing gets held back a
  // rung or two, so the engine simply asks for fewer leads for it this pass.
  const health = await mailboxBounceHealth(pool);
  const perMailbox = [];
  for (const m of mbs) {
    const cap = dailyCap(m.warmup_started_at, { target: m.daily_send_limit, health: health.get(m.id) });
    const used = await mailboxSentToday(m.id);
    const remaining = Math.max(0, cap - used);
    if (remaining > 0) perMailbox.push({ mb: m, remaining });
  }
  if (!perMailbox.length) return { created: 0, note: "no remaining capacity" };

  // Rotate senders: round-robin one slot per mailbox per pass until each is exhausted.
  const rotated = [];
  let added = true;
  while (added) {
    added = false;
    for (const p of perMailbox) {
      if (p.remaining > 0) { rotated.push(p.mb); p.remaining--; added = true; }
    }
  }
  // Optional cap (used by the manual "Run now" trigger to create a small test batch).
  if (maxDrafts && rotated.length > maxDrafts) rotated.length = maxDrafts;

  // An old auto-switch label does not prove permission to restart outreach.
  // Such drafts stay in the rep's queue for explicit review.
  const resumable=[];

  // Eligible leads: see selectAutoOutreachCandidates.
  // People who wrote back recently are left to staff on every project (lib/recentReply.js).
  const replied = await recentReplyEmails(pool);
  const tables = await presentTables(pool);
  // Soft-verdict brakes (lib/softVerdictGuard.js): a daily quota, and no soft lead for a sequence
  // whose 7-day bounce rate is at the guard. Valid leads are never held by either.
  const softGuard = await softGuardState(pool, settings);
  const softCap = softGuard.cap, softUsed = softGuard.used, softRemaining = softGuard.remaining, bouncing = softGuard.bouncing;
  let softDrafted = 0, softCapped = 0, softPausedBounce = 0;
  const softOpen = () => softDrafted < softRemaining;
  const selectCandidates = (seen, limit) => selectAutoOutreachCandidates(pool, {settings,companyId,lifecycleEnabled,replied,tables,seen,limit,softAllowed:softOpen()});

  let created = 0;
  // Only new drafts are returned. Historical artifacts are never adopted here.
  const createdDrafts = [...resumable];
  const errors = [];
  const scanLimit = Math.min(1000, Math.max(50, rotated.length * 5));
  const seen = new Set();
  let scanned = 0, eligible = 0, exhausted = false, crmUnreadable = false;
  while (created < rotated.length && scanned < scanLimit) {
    const {rows: leads} = await selectCandidates(seen, Math.min(100, scanLimit - scanned));
    eligible += leads.length; // Selected rows, not an exhaustive population count.
    if (!leads.length) { exhausted = true; break; }
    for (const lead of leads) {
      if (created >= rotated.length || scanned >= scanLimit) break;
      if (seen.has(String(lead.pipedrive_lead_id))) continue;
      seen.add(String(lead.pipedrive_lead_id));
      if (sendableVerdict(lead) === 'soft') {
        const sequence = process.env[`APOLLO_SEQ_${lead.trigger_type}`];
        if (sequence && bouncing.has(String(sequence))) { softPausedBounce++; continue; }
        if (!softOpen()) { softCapped++; continue; }
      }
      scanned++;
      const mb = rotated[created];
    try {
      const draftId=randomUUID();
      const context={companyId,leadId:lead.pipedrive_lead_id,draftId,recipientEmail:lead.person_email,channel:'email',serviceId:null};
      await assertOutreachAllowed(pool,context,{action:'generate_draft'});
      // Existing customers are refused at send (approve-and-send), so drafting one only fills the
      // queue with a draft nobody can send. Checked live before the generator runs; an unreadable
      // Pipedrive throws crm_unverified and ends this pass (fail-closed).
      const customer = await isCustomerLead(lead.pipedrive_lead_id);
      if (customer) throw new Error('existing_customer');
      const payload = await buildDraftFromLead({
        pipedriveLeadId: lead.pipedrive_lead_id,
        triggerType: lead.trigger_type,
        pool,
        assignedUserId: mb.owner_user_id, // rotation chooses the sender, not Launch_Sequence
        assignedMailboxId: mb.id,
      });
      if (String(payload.assigned_mailbox_id) !== String(mb.id) || String(payload.assigned_user_id) !== String(mb.owner_user_id)) throw new Error('generated_mailbox_mismatch');
      const ins=await withLeadLock(pool,lead.pipedrive_lead_id,async client=>{
        const current=(await client.query('SELECT * FROM sdr_lead_state WHERE pipedrive_lead_id=$1 FOR UPDATE',[lead.pipedrive_lead_id])).rows[0];
        const keys=['crm_company_id','trigger_type','pipedrive_person_id','pipedrive_org_id','person_email','project_stage','trigger_override'];
        if(!current||keys.some(key=>String(current[key]??'')!==String(lead[key]??'')))throw new Error('draft_context_changed');
        if(isBidInviteOrigin(current.lead_origin))throw new Error('bid_invite_warm_lead');
        if(await bidInviteLeadFor(client,{personId:current.pipedrive_person_id,emails:[current.person_email,payload.contact_email_snapshot]}))throw new Error('bid_invite_warm_lead');
        await assertOutreachAllowed(client,{...context,recipientEmail:payload.contact_email_snapshot,serviceId:payload.metadata?.service_id},{action:'generate_draft'});
        if(replied.has(normalEmail(payload.contact_email_snapshot)))throw new Error('recent_reply_staff_owned');
        // The generator reads the address live from Pipedrive; it must be the one verified.
        const verdict=sendableVerdict(current,payload.contact_email_snapshot);
        if(!verdict)throw new Error('email_unconfirmed');
        if(verdict==='soft'&&bouncing.has(String(payload.apollo_sequence_id)))throw new Error('soft_bounce_guard');
        if(verdict==='soft'&&!softOpen())throw new Error('soft_cap_reached');
        payload.metadata={...(payload.metadata||{}),email_verdict:verdict};
        // A rejection, hold or send may have appeared while the remote generator waited.
        const emails=[...new Set([current.person_email,payload.contact_email_snapshot].map(normalEmail).filter(Boolean))];
        const history=await client.query(`SELECT ${outreachHistoryBlocks({lead:'$1::text',person:'$2::text',emails:'$3::text[]'},tables)} AS blocked`,
          [lead.pipedrive_lead_id,current.pipedrive_person_id==null?null:String(current.pipedrive_person_id),emails]);
        if(history.rows[0]?.blocked!==false)throw new Error('existing_draft_decision_requires_review');
        return client.query(
        `INSERT INTO sdr_drafts (
           pipedrive_lead_id, pipedrive_contact_id, pipedrive_org_id,
           contact_id_snapshot, contact_email_snapshot, org_id_snapshot,
           trigger_type, apollo_sequence_id, subject, body,
           assigned_mailbox_id, assigned_user_id, initiated_by, metadata, content_origin, id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'automatic',$13,'machine',$14)
         ON CONFLICT (pipedrive_lead_id, trigger_type)
           WHERE status IN ('pending','approved','edited') DO NOTHING
         RETURNING id, assigned_user_id`,
        [payload.pipedrive_lead_id, payload.pipedrive_contact_id, payload.pipedrive_org_id,
         payload.contact_id_snapshot, payload.contact_email_snapshot, payload.org_id_snapshot,
         payload.trigger_type, payload.apollo_sequence_id, payload.subject, payload.body,
         payload.assigned_mailbox_id, payload.assigned_user_id, payload.metadata,draftId],
        );
      });
      if (ins.rows[0]) {
        created++;
        createdDrafts.push(ins.rows[0]);
        if (payload.metadata?.email_verdict === 'soft') softDrafted++;
      }
    } catch (e) {
      errors.push({ lead: lead.pipedrive_lead_id, error: e.code === 'crm_unverified' ? 'crm_unverified' : e.message });
      if (e.code === 'crm_unverified') { crmUnreadable = true; break; }
    }
    }
    if (crmUnreadable) break;
  }
  return {
    mode: settings.auto_outreach_mode,
    created,
    resumed: resumable.length,
    createdDrafts,
    eligible,
    capacity: rotated.length,
    scanned,
    refused: scanned - created,
    scanLimitReached: !exhausted && scanned >= scanLimit && created < rotated.length,
    soft: { guardAvailable: softGuard.available, cap: softCap, usedBefore: softUsed, drafted: softDrafted, capped: softCapped, pausedBounce: softPausedBounce,
      bouncingSequences: [...bouncing.values()].map(r => ({ sequenceId: r.sequenceId, rate: Math.round(r.rate * 1000) / 10 })) },
    ...(crmUnreadable ? { stopped: 'crm_unverified' } : {}),
    errors: errors.slice(0, 5),
  };
}
