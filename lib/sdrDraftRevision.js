import {createHash} from 'node:crypto';
import {withLeadLock} from './sdrAccess.js';
const text=value=>value==null?null:String(value);
export function draftContext(draft) {
 const m=draft.metadata||{};
 return {companyId:text(draft.company_id),leadId:text(draft.pipedrive_lead_id),personId:text(draft.contact_id_snapshot),
  recipientEmail:text(draft.contact_email_snapshot)?.trim().toLowerCase()??null,organizationId:text(draft.org_id_snapshot),
  projectRole:text(m.project_role),roleExceptionId:text(m.role_exception_id),stage:text(m.project_stage),trigger:text(draft.trigger_type),
  mailboxId:text(draft.assigned_mailbox_id),senderEmail:text(m.sender_email)?.trim().toLowerCase()??null,senderProviderId:text(m.sender_provider_id),reviewedContextHash:text(m.reviewed_outreach_context_hash),assignedUserId:text(draft.assigned_user_id),sequenceId:text(draft.apollo_sequence_id),
  cadence:text(m.cadence),overrideDecisionId:text(m.override_decision_id),
  scheduledFor:draft.scheduled_for?new Date(draft.scheduled_for).toISOString():null};
}
export function draftContextHash(draft) {return createHash('sha256').update(JSON.stringify(draftContext(draft))).digest('hex');}
export function serializeDraft(draft) {return draft?{...draft,revision:String(draft.revision),contextHash:draftContextHash(draft)}:draft;}
export function checkViewedDraft({draft,expectedRevision,expectedContextHash}) {
 if(!draft||!['pending','approved','edited'].includes(draft.status)||draft.sent_at) return {allowed:false,code:'draft_stale'};
 if(expectedRevision==null||!expectedContextHash) return {allowed:false,code:'draft_version_required'};
 if(String(expectedRevision)!==String(draft.revision)||expectedContextHash!==draftContextHash(draft)) return {allowed:false,code:'draft_stale'};
 return {allowed:true};
}
export function draftConflict(code='draft_stale') {return Object.assign(new Error('Draft changed or is no longer editable. Reload and review the current version.'),{status:409,code,preserveDraft:true});}
export function checkDraftSchedule(draft,{now=new Date()}={}) {
 if(draft.scheduled_for && (!Number.isFinite(new Date(draft.scheduled_for).getTime())||new Date(draft.scheduled_for)>now)) return {allowed:false,code:'scheduled_for_future'};
 return {allowed:true};
}
const editable=new Set(['subject','body','scheduled_for','assigned_mailbox_id','assigned_user_id','apollo_sequence_id','status','reject_reason','contact_id_snapshot','contact_email_snapshot','org_id_snapshot','pipedrive_contact_id','pipedrive_org_id','metadata','content_origin','trigger_type']);
export async function mutateViewedDraft(pool,{draft,expectedRevision,expectedContextHash,fields}) {
 const initial=checkViewedDraft({draft,expectedRevision,expectedContextHash});if(!initial.allowed)throw draftConflict(initial.code);
 return withLeadLock(pool,draft.pipedrive_lead_id,async client=>{
  const current=(await client.query('SELECT * FROM sdr_drafts WHERE id=$1 FOR UPDATE',[draft.id])).rows[0];
  const checked=checkViewedDraft({draft:current,expectedRevision,expectedContextHash});if(!checked.allowed)throw draftConflict(checked.code);
  const params=[draft.id,expectedRevision];const sets=[];
  for(const [key,value]of Object.entries(fields)) {if(!editable.has(key))throw new Error(`Uneditable draft field: ${key}`);params.push(value);sets.push(`${key}=$${params.length}`);}
  const result=await client.query(`UPDATE sdr_drafts SET ${sets.join(',')},approved_at=NULL,approved_by=NULL,updated_at=NOW()
   WHERE id=$1 AND revision=$2 AND status IN ('pending','approved','edited') AND sent_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM sdr_sends s WHERE s.draft_id=sdr_drafts.id) RETURNING *`,params);
  if(!result.rows[0])throw draftConflict();return result.rows[0];
 });
}
export async function refreshViewedDraft(pool,{draft,expectedRevision,expectedContextHash,build}) {
 const initial=checkViewedDraft({draft,expectedRevision,expectedContextHash});if(!initial.allowed)throw draftConflict(initial.code);
 // The remote generator runs with no transaction or advisory lock held.
 const payload=await build({pipedriveLeadId:draft.pipedrive_lead_id,triggerType:draft.trigger_type,pool,assignedUserId:draft.assigned_user_id,assignedMailboxId:draft.assigned_mailbox_id,apolloSequenceId:draft.apollo_sequence_id});
 const fields={status:'pending',content_origin:'interactive'};
 for(const key of ['subject','body','contact_id_snapshot','contact_email_snapshot','org_id_snapshot','pipedrive_contact_id','pipedrive_org_id','metadata','trigger_type'])if(payload[key]!==undefined)fields[key]=payload[key];
 fields.metadata={...payload.metadata};
 // Regeneration cannot remove an existing service/cadence restriction. Only a
 // separate recorded review may supersede it; old approvals are never carried.
 if(draft.metadata?.cadence==='award_only')fields.metadata.cadence='award_only';
 if(draft.metadata?.service_id!=null)fields.metadata.service_id=draft.metadata.service_id;
 for(const key of ['reviewed_outreach_context_hash','role_exception_id','override_decision_id'])delete fields.metadata[key];
 if(!draft.apollo_sequence_id)fields.apollo_sequence_id=payload.apollo_sequence_id;
 return mutateViewedDraft(pool,{draft,expectedRevision,expectedContextHash,fields});
}
export async function recordDraftApproval(db,draft,actor) {
 await db.query(`INSERT INTO sdr_draft_approvals(draft_id,revision,context_hash,subject,body,context,actor) VALUES($1,$2,$3,$4,$5,$6,$7)`,
 [draft.id,draft.revision,draftContextHash(draft),draft.subject,draft.body,draftContext(draft),{accountId:actor.sub??null,execution:actor.machine?'automatic':'interactive',source:actor.machine?'service':'sdr_ui'}]);
}
export async function checkApprovedDraft(db,draft) {
 const receipt=(await db.query('SELECT * FROM sdr_draft_approvals WHERE draft_id=$1 AND revision=$2 ORDER BY created_at DESC LIMIT 1',[draft.id,draft.revision])).rows[0];
 if(!receipt)return {allowed:false,code:'approval_missing'};
 return receipt.context_hash===draftContextHash(draft)&&receipt.subject===draft.subject&&receipt.body===draft.body?{allowed:true}:{allowed:false,code:'draft_stale'};
}
