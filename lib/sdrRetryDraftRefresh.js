import {buildDraftFromLead} from './sdrDraftGenerator.js';
import {checkApprovedDraft,draftContextHash,mutateViewedDraft,checkDraftSchedule} from './sdrDraftRevision.js';

// Only new, explicitly machine-authored pending copy can be regenerated. Receipts
// freeze reviewed content even when capacity refused before status became approved.
export async function refreshRetryDraft(pool,draftId,{build=buildDraftFromLead}={}) {
 const draft=(await pool.query('SELECT * FROM sdr_drafts WHERE id=$1',[draftId])).rows[0];
 if(!draft||!['pending','approved'].includes(draft.status)||draft.sent_at)return {allowed:false,code:'draft_stale'};
 const schedule=checkDraftSchedule(draft);if(!schedule.allowed)return schedule;
 const approval=await checkApprovedDraft(pool,draft);
 if(approval.allowed)return {allowed:true}; // final-send policy still validates live context
 if(draft.status==='approved')return approval;
 if(draft.content_origin!=='machine')return {allowed:false,code:'draft_origin_unknown'};
 const current=await build({pipedriveLeadId:draft.pipedrive_lead_id,pool,assignedUserId:draft.assigned_user_id,apolloSequenceId:draft.apollo_sequence_id});
 const same=(a,b)=>String(a??'').toLowerCase()===String(b??'').toLowerCase();
 for(const key of ['contact_id_snapshot','contact_email_snapshot','org_id_snapshot'])if(!same(current[key],draft[key]))return {allowed:false,code:'contact_changed'};
 if(!same(current.metadata?.service_id,draft.metadata?.service_id))return {allowed:false,code:'draft_stale'};
 if(!same(current.trigger_type,draft.trigger_type)||!same(current.metadata?.project_stage,draft.metadata?.project_stage)||!same(current.assigned_mailbox_id,draft.assigned_mailbox_id)||!same(current.apollo_sequence_id,draft.apollo_sequence_id)||!same(current.metadata?.cadence,draft.metadata?.cadence))return {allowed:false,code:'draft_stale'};
 try {
  await mutateViewedDraft(pool,{draft,expectedRevision:draft.revision,expectedContextHash:draftContextHash(draft),fields:{subject:current.subject,body:current.body,metadata:current.metadata,status:'pending'}});
  return {allowed:true};
 }catch(error){if(error.status===409)return {allowed:false,code:error.code};throw error;}
}
