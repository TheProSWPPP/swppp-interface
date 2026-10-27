import { createHash, randomUUID } from 'node:crypto';
import { readContactSendDaysAgo } from './apolloCollision.js';
import {observeOutreachPolicy} from './sdrPolicyRollout.js';
import {canonicalDraftRevision} from './sdrChangeJournal.js';
import {presentTables,undeliveredFailedSend,spentEnrollOperation} from './outreachHistory.js';

const lockedClients = new WeakSet();
const lockScopes = new WeakMap();
const ownedReservations = new WeakMap();
const text = value => value == null ? null : String(value);
const time = value => value && Number.isFinite(+new Date(value)) ? new Date(value).toISOString() : null;
const identity = expected => ({ contactId:text(expected.contactId),campaignId:text(expected.campaignId),membershipId:text(expected.membershipId),addedAt:time(expected.addedAt),sendId:text(expected.sendId),leadId:text(expected.leadId) });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// A local lock serializes only our writers. It never establishes conditional provider support.
// All callers must acquire this BEFORE any lead lock; hold it through shared-field mutation.
export async function withProviderContactLock(pool, contactId, leadIds, work) {
  if (!contactId) throw new Error('provider_contact_required');
  const client = await pool.connect();
  const key = `sdr-provider-contact:${contactId}`;
  try {
    await client.query('SELECT pg_advisory_lock_shared(hashtextextended($1,0))',['outreach-global-controls']);
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
    // Session locks permit durable intent commits before network IO.
    for (const lead of [...new Set(leadIds.map(String))].sort()) {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lead]);
    }
    lockedClients.add(client);
    lockScopes.set(client, Symbol('provider-lock-scope'));
    return await work(client);
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally {
    lockedClients.delete(client);
    lockScopes.delete(client);
    // This dedicated connection owns only the locks above.
    try { await client.query('SELECT pg_advisory_unlock_all()'); } finally { client.release(); }
  }
}

// Apollo marks a membership "finished" (last step done, replied, manually finished) or
// "failed" (bounced, spam blocked, invalid MX). Neither sends again, so either is the stop
// receipt. Our own enrollments are added within a second or two of the sdr_sends row
// (measured on 96 production stops: -1.3s..+1.8s), so an added_at that close to our
// send's sent_at proves the open membership is the one this app created.
export const OWNED_ADD_WINDOW_MS = 120 * 1000;
export const STOP_RECHECK_MS = 24 * 3600 * 1000;
const TERMINAL_MEMBERSHIP = new Set(['finished','failed']);
const OPEN_MEMBERSHIP = new Set(['active','paused']);
// Inspect-only results that an allowed removal could change.
const REMOVABLE_REASONS = new Set(['conditional_generation_stop_unverified','membership_paused']);
const INSPECTION_VERSION = '2';

export function assessMembership(expected, contact, { ownedSentAt = null } = {}) {
  const protect = reason => ({status:'protected_external_state',reason});
  if (String(contact?.id) !== String(expected.contactId) || !Array.isArray(contact?.contact_campaign_statuses)
      || contact.contact_campaign_statuses.some(s=>!s?.emailer_campaign_id)) return {status:'unresolved',reason:'membership_unverified'};
  const matches=contact.contact_campaign_statuses.filter(s=>String(s.emailer_campaign_id)===String(expected.campaignId));
  if (!matches.length) return protect('membership_absent');
  if (matches.length!==1) return protect('membership_ambiguous');
  const m=matches[0];
  const id=text(m.emailer_campaign_contact_id ?? m.id);
  if (expected.membershipId && id && String(expected.membershipId)!==id) return {status:'superseded',reason:'membership_generation_changed'};
  if (expected.addedAt && m.added_at && time(expected.addedAt)!==time(m.added_at)) return {status:'superseded',reason:'membership_generation_changed'};
  const status=String(m.status || '').toLowerCase();
  if (TERMINAL_MEMBERSHIP.has(status)) return {status:'confirmed',reason:`membership_${status}`,
    receipt:{id:id || `${expected.contactId}:${expected.campaignId}`,membershipStatus:status,inactiveReason:m.inactive_reason ?? null,finishedAt:m.finished_at ?? null}};
  const sentAt=time(ownedSentAt), addedAt=time(m.added_at);
  const proven=(expected.membershipId && id===String(expected.membershipId)) || (time(expected.addedAt) && time(expected.addedAt)===addedAt)
    || (sentAt && addedAt && Math.abs(+new Date(addedAt)-+new Date(sentAt))<=OWNED_ADD_WINDOW_MS);
  if (!proven) return protect('generation_unverified');
  if (OPEN_MEMBERSHIP.has(status)) return {status:'owned_open',reason:`membership_${status}`,membershipId:id};
  return protect(`membership_${status || 'unknown'}`);
}

async function observe(client, operation, expected, contact, result) {
  const m=contact?.contact_campaign_statuses?.find(s=>String(s?.emailer_campaign_id)===expected.campaignId);
  await client.query(`INSERT INTO sdr_provider_membership_observations
    (operation_id,contact_id,campaign_id,membership_id,added_at,membership_status,evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[operation.id,expected.contactId,expected.campaignId,text(m?.emailer_campaign_contact_id ?? m?.id),text(m?.added_at),m?.status || (result.reason==='membership_absent' ? 'absent' : 'unknown'),JSON.stringify({reason:result.reason,membership:m || null,version:INSPECTION_VERSION})]);
}

const rateLimited = (error, prefix) => {
  const seconds=Number(error.retryAfterSec);
  const retryAfterSec=Number.isFinite(seconds)&&seconds>0 ? seconds : 86400;
  return {status:'unresolved',reason:`${prefix}_rate_limited`,retryAfterSec,
    retryAt:error.retryAt&&Number.isFinite(+new Date(error.retryAt)) ? new Date(error.retryAt) : new Date(Date.now()+retryAfterSec*1000)};
};

async function inspectStop(client, apollo, operation, { allowRemoval = false } = {}) {
  const expected=operation.expected_membership;
  const owned=(await client.query(`SELECT * FROM sdr_sends
    WHERE apollo_contact_id=$1 AND apollo_sequence_id=$2`,[expected.contactId,expected.campaignId])).rows;
  const own=owned.find(s=>String(s.id)===expected.sendId && String(s.pipedrive_lead_id)===expected.leadId);
  // Any other send is conservative ambiguity, including a later send on this same lead;
  // never touch another project's membership.
  if (!own) return {status:'protected_external_state',reason:'send_ownership_unverified'};
  if (owned.some(s=>String(s.id)!==expected.sendId)) return {status:'superseded',reason:'another_send_owns_or_reused_contact_campaign'};
  let contact;
  try { contact=await apollo.getContact(expected.contactId); }
  catch(error) {
    if (Number(error?.status)===429) return rateLimited(error,'membership');
    return {status:'unresolved',reason:'membership_read_failed'};
  }
  const ownedSentAt=own.sent_at ?? null;
  let result=assessMembership(expected,contact,{ownedSentAt});
  if (result.status==='owned_open' && !allowRemoval)
    result={status:'protected_external_state',reason:result.reason==='membership_paused' ? 'membership_paused' : 'conditional_generation_stop_unverified'};
  await observe(client,operation,expected,contact,result);
  if (result.status!=='owned_open') return result;
  // Only a reply/bounce stop reaches here, for the one membership proven to be ours.
  // Record the intent before network IO so a crash leaves an explainable row.
  await client.query(`UPDATE sdr_provider_operations SET reason='stop_requested',updated_at=NOW() WHERE id=$1`,[operation.id]);
  let response;
  if (typeof apollo.finishContactInSequence!=='function') return {status:'unresolved',reason:'stop_request_unavailable'};
  try { response=await apollo.finishContactInSequence(expected.campaignId,expected.contactId); }
  catch(error) {
    if (Number(error?.status)===429) return rateLimited(error,'stop');
    return {status:'unresolved',reason:'stop_request_failed'};
  }
  // The receipt is Apollo's own status for this membership, never the write's 200.
  let after=Array.isArray(response?.contacts) ? response.contacts.find(c=>String(c?.id)===expected.contactId) : null;
  if (!Array.isArray(after?.contact_campaign_statuses)) {
    try { after=await apollo.getContact(expected.contactId); }
    catch { return {status:'unresolved',reason:'stop_requested_awaiting_receipt'}; }
  }
  const check=assessMembership(expected,after,{ownedSentAt});
  await observe(client,operation,expected,after,check);
  if (check.status==='confirmed') return {...check,reason:'stopped_by_app',receipt:{...check.receipt,via:'mark_as_finished'}};
  if (check.status==='owned_open') return {status:'unresolved',reason:'stop_requested_awaiting_receipt'};
  return check;
}

async function recentInspection(client, operation) {
  if (operation.kind!=='stop' || operation.state!=='protected_external_state') return false;
  return (await client.query(`SELECT 1 FROM sdr_provider_membership_observations WHERE operation_id=$1
    AND evidence->>'version'=$2 AND observed_at > NOW() - make_interval(secs => $3::double precision) LIMIT 1`,
  [operation.id,INSPECTION_VERSION,STOP_RECHECK_MS/1000])).rowCount>0;
}

async function reconcileLocked(client,apollo,operation,{allowRemoval=false}={}) {
  if (operation.state==='confirmed' || operation.state==='pre_add_refused') return {status:operation.state,reason:operation.reason || null,operationId:operation.id,receipt:operation.receipt};
  // A protected stop is read again at most once a day: repeated reads of the same contact
  // spent Apollo's 2,000/day contact-read quota (2026-10-15..19). A reply stop still gets a
  // fresh read when the cached reason is one its removal could change.
  if ((!allowRemoval || !REMOVABLE_REASONS.has(operation.reason)) && await recentInspection(client,operation))
    return {status:operation.state,reason:operation.reason,operationId:operation.id,receipt:null,cached:true,applicationActionsBlocked:true,providerStopStatus:'unresolved'};
  const token=randomUUID();
  const claimed=(await client.query(`UPDATE sdr_provider_operations SET lease_token=$2,fence=fence+1,
    lease_until=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE id=$1 RETURNING *`,[operation.id,token])).rows[0];
  // Enrollment uncertainty requires a provider operation receipt, never just current absence.
  const result=claimed.kind==='stop' ? await inspectStop(client,apollo,claimed,{allowRemoval}) : {status:'unresolved',reason:'enrollment_receipt_requires_review'};
  const confirmed=result.status==='confirmed';
  const saved=await client.query(`UPDATE sdr_provider_operations SET state=$2,reason=$3,lease_token=NULL,lease_until=NULL,updated_at=NOW(),
    receipt=CASE WHEN $6::boolean THEN $7::jsonb ELSE receipt END
    WHERE id=$1 AND lease_token=$4 AND fence=$5 RETURNING id`,[operation.id,result.status,result.reason,token,claimed.fence,confirmed,confirmed ? JSON.stringify(result.receipt) : null]);
  if (!saved.rowCount) return {status:'unresolved',operationId:operation.id,receipt:null};
  if (confirmed) return {status:'confirmed',reason:result.reason,operationId:operation.id,receipt:result.receipt};
  return {...result,operationId:operation.id,receipt:null,applicationActionsBlocked:true,
    providerStopStatus:result.status==='superseded' ? 'superseded' : 'unresolved',
    reviewAction:'Review the current enrollment explicitly; contact+campaign removal can race with external re-enrollment.'};
}

// allowRemoval: only reply/bounce stops may mark the app's own proven membership finished.
// Every other caller (CRM-change auto-switch, email verification, provider events) inspects
// only and accepts Apollo's finished/failed status as the receipt.
export async function stopOwnedEnrollment({pool,apollo,expected,actionId,controlId=null,allowRemoval=false}) {
  const e=identity(expected);
  if (!actionId || !e.contactId || !e.campaignId || !e.leadId || !e.sendId) throw new Error('provider_operation_identity_required');
  return withProviderContactLock(pool,e.contactId,[e.leadId],async client=>{
    const key=hash({kind:'stop',expected:e});
    const operation=(await client.query(`INSERT INTO sdr_provider_operations
      (id,operation_key,kind,contact_id,campaign_id,lead_id,expected_membership,action_id,control_id,state)
      VALUES($1,$2,'stop',$3,$4,$5,$6::jsonb,$7,$8,'unresolved')
      ON CONFLICT(operation_key) DO UPDATE SET operation_key=EXCLUDED.operation_key RETURNING *`,
    [randomUUID(),key,e.contactId,e.campaignId,e.leadId,JSON.stringify(e),String(actionId),controlId])).rows[0];
    return reconcileLocked(client,apollo,operation,{allowRemoval});
  });
}

export async function reconcileProviderOperation({pool,apollo,operationId}) {
  const operation=(await pool.query('SELECT * FROM sdr_provider_operations WHERE id=$1',[operationId])).rows[0];
  if (!operation) throw new Error('provider_operation_not_found');
  return withProviderContactLock(pool,operation.contact_id,[operation.lead_id],async client=>{
    const current=(await client.query('SELECT * FROM sdr_provider_operations WHERE id=$1',[operationId])).rows[0];
    if (!current) throw new Error('provider_operation_not_found');
    return reconcileLocked(client,apollo,current);
  });
}

const enrollmentBlocked = code => Object.assign(new Error('Provider enrollment requires review'),{code,status:409,preserveDraft:true});
// Call inside withProviderContactLock, on its autocommit client, BEFORE writing shared fields.
// A reservation is a durable attempt, not permission to replay after a crash.
export async function reserveEnrollment({pool,apollo,context,draftRevision,actionId,enrollmentMode}) {
  if (!lockedClients.has(pool)) {
    return withProviderContactLock(pool,context.apolloContactId,[context.leadId],client=>
      reserveEnrollment({pool:client,apollo,context,draftRevision,actionId,enrollmentMode}));
  }
  let result,failure;
  try { result=await reserveEnrollmentLocked({pool,apollo,context,draftRevision,actionId,enrollmentMode}); }
  catch(error) { failure=error; }
  // Trusted context comes from assertSendSafety, never from the request body.
  // Permit callers retain their existing provider guards without role-policy inference.
  if(context.policyRollout)await observeOutreachPolicy(pool,{context,...context.policyRollout,phase:'provider_reservation',
    invariantDecision:{outcome:failure?'hold':'allow',reasonCodes:failure?[failure.code||'provider_reservation_unverified']:[]}});
  if(failure)throw failure;
  return result;
}
async function reserveEnrollmentLocked({pool,apollo,context,draftRevision,actionId,enrollmentMode}) {
  const guard=(await import('./sdrOutreachControls.js')).assertOutreachAllowed;
  await guard(pool,context,{action:'enroll'});
  const contactId=text(context.apolloContactId);
  // Automatic permits have no versioned draft and retain their explicit zero sentinel.
  const revision=context.serviceId==='permits'&&draftRevision===0?'0':canonicalDraftRevision(draftRevision);
  if (context.technicalComplete !== true || !contactId || !context.leadId || !context.sequenceId || !actionId || !revision) throw enrollmentBlocked('provider_context_incomplete');
  const newMode=enrollmentMode==='sdr_draft_v1';
  if (enrollmentMode && !newMode) throw enrollmentBlocked('provider_context_incomplete');
  if (newMode) {
    const fields=['companyId','leadId','personId','recipientEmail','organizationId','projectRole','stage','trigger','mailboxId','sequenceId','scheduledFor','overrideDecisionId','roleExceptionId','cadence','sourceRevision','draftId','channel','serviceId'];
    if (fields.some(key=>!Object.hasOwn(context,key)) ||
        ['companyId','leadId','personId','recipientEmail','organizationId','stage','trigger','mailboxId','sequenceId','sourceRevision','draftId','channel'].some(key=>!text(context[key])))
      throw enrollmentBlocked('provider_context_incomplete');
  }
  const normalized={...(newMode ? {schemaVersion:'sdr_draft_v1',draftId:text(context.draftId),channel:text(context.channel),serviceId:text(context.serviceId)} : {}),companyId:text(context.companyId),leadId:text(context.leadId),personId:text(context.personId),recipientEmail:text(context.recipientEmail)?.trim().toLowerCase() || null,organizationId:text(context.organizationId),projectRole:text(context.projectRole),stage:text(context.stage),trigger:text(context.trigger),mailboxId:text(context.mailboxId),sequenceId:text(context.sequenceId),scheduledFor:time(context.scheduledFor),overrideDecisionId:text(context.overrideDecisionId),roleExceptionId:text(context.roleExceptionId),cadence:text(context.cadence),sourceRevision:text(context.sourceRevision),draftRevision:revision};
  const contextHash=hash(normalized);
  if (normalized.scheduledFor && +new Date(normalized.scheduledFor)>Date.now()) throw enrollmentBlocked('scheduled_for_future');
  // An enrollment receipt whose membership never produced an email (the PB/LBA paused-sequence
  // cleanup removed 516 such contacts from Apollo without a message) is not history to protect:
  // spentEnrollOperation in lib/outreachHistory.js, the same rule the automatic selector applies.
  const tables=await presentTables(pool);
  const previous=(await pool.query(newMode
    ? `SELECT * FROM sdr_provider_operations po WHERE (po.contact_id=$1 OR po.lead_id=$2) AND NOT ${spentEnrollOperation('po',tables)}`
    : `SELECT id FROM sdr_provider_operations po WHERE (po.contact_id=$1 OR po.lead_id=$2) AND NOT ${spentEnrollOperation('po',tables)} LIMIT 1`,[contactId,String(context.leadId)])).rows;
  if (previous.some(row=>!newMode || row.kind!=='enroll' || row.state!=='pre_add_refused' ||
      row.enrollment_phase===null || !['reserved','fields_completed'].includes(row.enrollment_phase) ||
      row.expected_membership?.schemaVersion!=='sdr_draft_v1' || row.contact_id!==contactId ||
      row.lead_id!==String(context.leadId) || row.campaign_id!==String(context.sequenceId) ||
      row.draft_revision?.toString()!==revision || row.context_hash!==contextHash ||
      Object.keys(row.expected_membership).length!==Object.keys(normalized).length ||
      Object.entries(normalized).some(([key,value])=>row.expected_membership[key]!==value))) throw enrollmentBlocked('provider_operation_requires_review');
  let contact;
  try { contact=await apollo.getContact(contactId); } catch { throw enrollmentBlocked('provider_membership_unverified'); }
  if (String(contact?.id)!==contactId || !Array.isArray(contact?.contact_campaign_statuses)) throw enrollmentBlocked('provider_membership_unverified');
  const history=(await pool.query(`SELECT s.id::text FROM sdr_sends s WHERE s.apollo_contact_id=$1 AND NOT ${undeliveredFailedSend('s',tables)}
    UNION ALL SELECT id::text FROM permit_sends WHERE apollo_contact_id=$1 LIMIT 1`,[contactId])).rows;
  // Absence following our historical enrollment is unexplained external state. Finished,
  // paused and failed memberships require their own reviewed replacement/resume decision.
  // A send row marked failed that never produced an email is not such history: its membership
  // was removed without a message, and Apollo shows no membership for it (checked 2026-10-26).
  if (history.length || contact.contact_campaign_statuses.length) {
    const {setOutreachControl}=await import('./sdrOutreachControls.js');
    await pool.query('BEGIN');
    await setOutreachControl({query:(...args)=>pool.query(...args)},{companyId:context.companyId,leadId:String(context.leadId),
      scope:{kind:'lead',id:String(context.leadId)},channel:context.channel || 'email',
      reason:'Provider membership requires review; no automatic resume or replacement',contextHash,
      actor:{source:'service',accountId:'provider-operations',execution:'automatic',ownership:'matched_own_receipt'},
    });
    await pool.query('COMMIT');
    throw enrollmentBlocked('external_membership_requires_review');
  }
  const daysAgo=await readContactSendDaysAgo(pool,{apolloContactId:contactId,recipientEmail:context.recipientEmail});
  const setting=(await pool.query('SELECT contact_cooldown_days FROM sdr_settings WHERE id=1')).rows[0];
  const cooldown=setting?.contact_cooldown_days ?? 14;
  if (!Number.isInteger(cooldown) || cooldown<0 || (daysAgo!==null && daysAgo<=cooldown)) throw enrollmentBlocked('contact_cooldown');
  const reservationId=randomUUID();
  const inserted=await pool.query(`INSERT INTO sdr_provider_operations
    (id,operation_key,kind,contact_id,campaign_id,lead_id,expected_membership,draft_revision,context_hash,action_id,state,enrollment_phase,lease_token,fence)
    VALUES($1,$2,'enroll',$3,$4,$5,$6::jsonb,$7,$8,$9,'reserved',$10,$11,$12) ON CONFLICT(operation_key) DO NOTHING RETURNING id`,
  [reservationId,hash({kind:'enroll',actionId:String(actionId)}),contactId,String(context.sequenceId),String(context.leadId),JSON.stringify(normalized),revision,contextHash,String(actionId),newMode?'reserved':null,newMode?randomUUID():null,newMode?1:0]);
  if (!inserted.rowCount) throw enrollmentBlocked('provider_operation_requires_review');
  const reservation={reservationId,contextHash};
  if(newMode) {
    const row=(await pool.query('SELECT lease_token,fence FROM sdr_provider_operations WHERE id=$1',[reservationId])).rows[0];
    reservation.leaseToken=row.lease_token; reservation.fence=row.fence;
    ownedReservations.set(reservation,{client:pool,scope:lockScopes.get(pool)});
  }
  return reservation;
}

function assertOwned(pool,reservation) {
  const owner=ownedReservations.get(reservation);
  if (!owner || owner.client!==pool || !lockedClients.has(pool) || owner.scope!==lockScopes.get(pool)) throw enrollmentBlocked('provider_reservation_owner_lost');
  return reservation;
}
const transitions={reserved:'fields_started',fields_started:'fields_completed',fields_completed:'add_started'};
export async function advanceEnrollmentPhase({pool,reservation,expectedPhase,nextPhase}) {
  assertOwned(pool,reservation);
  if (transitions[expectedPhase]!==nextPhase) throw enrollmentBlocked('provider_phase_conflict');
  const result=await pool.query(`UPDATE sdr_provider_operations SET enrollment_phase=$2,updated_at=NOW()
    WHERE id=$1 AND kind='enroll' AND state='reserved' AND enrollment_phase=$3 AND lease_token=$4 AND fence=$5 RETURNING id`,
    [reservation.reservationId,nextPhase,expectedPhase,reservation.leaseToken,reservation.fence]);
  if(result.rowCount!==1)throw enrollmentBlocked('provider_phase_conflict');
}
export async function recordPreAddRefusal({pool,reservation,refusal}) {
  assertOwned(pool,reservation);
  if (!['crm_returned_denial','local_guard_refusal'].includes(refusal?.kind) || !refusal?.reason) throw enrollmentBlocked('provider_refusal_unverified');
  const result=await pool.query(`UPDATE sdr_provider_operations SET state='pre_add_refused',reason=$2,updated_at=NOW()
    WHERE id=$1 AND kind='enroll' AND state='reserved' AND enrollment_phase IN ('reserved','fields_completed')
      AND lease_token=$3 AND fence=$4 RETURNING id`,
    [reservation.reservationId,String(refusal.reason),reservation.leaseToken,reservation.fence]);
  if(result.rowCount!==1)throw enrollmentBlocked('provider_phase_conflict');
}

export async function recordEnrollmentReceipt({pool,reservationId,receipt,reservation}) {
  if (!receipt?.id || !receipt.contactId || !receipt.campaignId) throw enrollmentBlocked('provider_receipt_unverified');
  if(reservation) { assertOwned(pool,reservation); if(reservation.reservationId!==reservationId)throw enrollmentBlocked('provider_reservation_owner_lost'); }
  const saved=await pool.query(`UPDATE sdr_provider_operations SET state='confirmed',receipt=$2::jsonb,updated_at=NOW()
    WHERE id=$1 AND kind='enroll' AND state='reserved' AND contact_id=$3 AND campaign_id=$4
      AND ((enrollment_phase IS NULL AND $5::boolean=FALSE) OR (enrollment_phase='add_started' AND $5::boolean=TRUE AND lease_token=$6 AND fence=$7)) RETURNING id`,
  [reservationId,JSON.stringify(receipt),String(receipt.contactId),String(receipt.campaignId),!!reservation,reservation?.leaseToken||null,reservation?.fence||null]);
  if (!saved.rowCount) throw enrollmentBlocked('provider_receipt_conflict');
}

// Provider acknowledgement is retained without inventing generation ownership.
export async function recordEnrollmentUncertainty({pool,reservationId,receipt=null,reason='completion_uncertain',reservation}) {
  if(reservation) { assertOwned(pool,reservation); if(reservation.reservationId!==reservationId)throw enrollmentBlocked('provider_reservation_owner_lost'); }
  const saved=await pool.query(`UPDATE sdr_provider_operations SET state='unresolved',receipt=$2::jsonb,reason=$3,updated_at=NOW()
    WHERE id=$1 AND kind='enroll' AND state IN ('reserved','unresolved')
      AND ((enrollment_phase IS NULL AND $4::boolean=FALSE) OR (enrollment_phase='add_started' AND $4::boolean=TRUE AND lease_token=$5 AND fence=$6)) RETURNING id`,[reservationId,JSON.stringify(receipt),reason,!!reservation,reservation?.leaseToken||null,reservation?.fence||null]);
  if (!saved.rowCount) throw enrollmentBlocked('provider_receipt_conflict');
}
