import { createHash, randomUUID } from 'node:crypto';
import { readContactSendDaysAgo } from './apolloCollision.js';
import {observeOutreachPolicy} from './sdrPolicyRollout.js';
import {canonicalDraftRevision} from './sdrChangeJournal.js';

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

export function assessMembership(expected, contact) {
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
  if (!((expected.membershipId && id===String(expected.membershipId)) || (time(expected.addedAt) && time(expected.addedAt)===time(m.added_at)))) return protect('generation_unverified');
  if (m.status!=='active') return protect(`membership_${m.status || 'unknown'}`);
  return protect('conditional_generation_stop_unverified');
}

async function inspectStop(client, apollo, operation) {
  const expected=operation.expected_membership;
  const owned=(await client.query(`SELECT id,pipedrive_lead_id FROM sdr_sends
    WHERE apollo_contact_id=$1 AND apollo_sequence_id=$2`,[expected.contactId,expected.campaignId])).rows;
  const own=owned.find(s=>String(s.id)===expected.sendId && String(s.pipedrive_lead_id)===expected.leadId);
  // Historical rows lack a proven generation. Any other send is conservative ambiguity,
  // including a later send on this same lead; never delete another project's membership.
  if (!own) return {status:'protected_external_state',reason:'send_ownership_unverified'};
  if (owned.some(s=>String(s.id)!==expected.sendId)) return {status:'superseded',reason:'another_send_owns_or_reused_contact_campaign'};
  let contact;
  try { contact=await apollo.getContact(expected.contactId); } catch { return {status:'unresolved',reason:'membership_read_failed'}; }
  const result=assessMembership(expected,contact);
  const m=contact?.contact_campaign_statuses?.find(s=>String(s?.emailer_campaign_id)===expected.campaignId);
  await client.query(`INSERT INTO sdr_provider_membership_observations
    (operation_id,contact_id,campaign_id,membership_id,added_at,membership_status,evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[operation.id,expected.contactId,expected.campaignId,text(m?.emailer_campaign_contact_id ?? m?.id),text(m?.added_at),m?.status || (result.reason==='membership_absent' ? 'absent' : 'unknown'),JSON.stringify({reason:result.reason,membership:m || null})]);
  return result;
}

async function reconcileLocked(client,apollo,operation) {
  if (operation.state==='confirmed' || operation.state==='pre_add_refused') return {status:operation.state,operationId:operation.id,receipt:operation.receipt};
  const token=randomUUID();
  const claimed=(await client.query(`UPDATE sdr_provider_operations SET lease_token=$2,fence=fence+1,
    lease_until=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE id=$1 RETURNING *`,[operation.id,token])).rows[0];
  // Enrollment uncertainty requires a provider operation receipt, never just current absence.
  const result=claimed.kind==='stop' ? await inspectStop(client,apollo,claimed) : {status:'unresolved',reason:'enrollment_receipt_requires_review'};
  const saved=await client.query(`UPDATE sdr_provider_operations SET state=$2,reason=$3,lease_token=NULL,lease_until=NULL,updated_at=NOW()
    WHERE id=$1 AND lease_token=$4 AND fence=$5 RETURNING id`,[operation.id,result.status,result.reason,token,claimed.fence]);
  if (!saved.rowCount) return {status:'unresolved',operationId:operation.id,receipt:null};
  return {...result,operationId:operation.id,receipt:null,applicationActionsBlocked:true,
    providerStopStatus:result.status==='superseded' ? 'superseded' : 'unresolved',
    reviewAction:'Review the current enrollment explicitly; contact+campaign removal can race with external re-enrollment.'};
}

export async function stopOwnedEnrollment({pool,apollo,expected,actionId,controlId=null}) {
  const e=identity(expected);
  if (!actionId || !e.contactId || !e.campaignId || !e.leadId || !e.sendId) throw new Error('provider_operation_identity_required');
  return withProviderContactLock(pool,e.contactId,[e.leadId],async client=>{
    const key=hash({kind:'stop',expected:e});
    const operation=(await client.query(`INSERT INTO sdr_provider_operations
      (id,operation_key,kind,contact_id,campaign_id,lead_id,expected_membership,action_id,control_id,state)
      VALUES($1,$2,'stop',$3,$4,$5,$6::jsonb,$7,$8,'unresolved')
      ON CONFLICT(operation_key) DO UPDATE SET operation_key=EXCLUDED.operation_key RETURNING *`,
    [randomUUID(),key,e.contactId,e.campaignId,e.leadId,JSON.stringify(e),String(actionId),controlId])).rows[0];
    return reconcileLocked(client,apollo,operation);
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
  const previous=(await pool.query(newMode
    ? 'SELECT * FROM sdr_provider_operations WHERE contact_id=$1 OR lead_id=$2'
    : 'SELECT id FROM sdr_provider_operations WHERE contact_id=$1 OR lead_id=$2 LIMIT 1',[contactId,String(context.leadId)])).rows;
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
  const history=(await pool.query('SELECT id::text FROM sdr_sends WHERE apollo_contact_id=$1 UNION ALL SELECT id::text FROM permit_sends WHERE apollo_contact_id=$1 LIMIT 1',[contactId])).rows;
  // Absence following our historical enrollment is unexplained external state. Finished,
  // paused and failed memberships require their own reviewed replacement/resume decision.
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
