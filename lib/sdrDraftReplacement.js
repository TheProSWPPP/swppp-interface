import {randomUUID} from 'node:crypto';
import {acquireLeadLock} from './sdrAccess.js';
import {draftContextHash,serializeDraft} from './sdrDraftRevision.js';
import {assertOutreachAllowed} from './sdrOutreachControls.js';
import {readDecisionContext,recordChangeIntent,recordChangeReceipt} from './sdrChangeJournal.js';

const conflict=(code,status=409)=>Object.assign(new Error(code),{code,status,preserveDraft:true});
const same=(a,b)=>String(a??'').trim().toLowerCase()===String(b??'').trim().toLowerCase();
function interactiveOwner(user,draft) {
  if(!user?.sub)throw conflict('authentication_required',401);
  if(user.machine===true||!['admin','sdr'].includes(user.role))throw conflict('interactive_operator_required',403);
  if(draft&&user.role!=='admin'&&String(draft.assigned_user_id)!==String(user.sub))throw conflict('draft_owner_required',403);
}
async function inspect(db,{id,user,companyId,expected=null,lock=false}) {
  interactiveOwner(user);
  const draft=(await db.query(`SELECT * FROM sdr_drafts WHERE id::text=$1${lock?' FOR UPDATE':''}`,[String(id)])).rows[0];
  if(!draft)throw conflict('draft_not_found',404);
  interactiveOwner(user,draft);
  if(!['failed','rejected','cancelled'].includes(draft.status)||draft.sent_at)throw conflict('draft_not_replaceable');
  if(expected&&(expected.expectedDraftId!==draft.id||String(expected.expectedRevision)!==String(draft.revision)||expected.expectedContextHash!==draftContextHash(draft)))throw conflict('draft_stale');
  const local=(await db.query(`SELECT * FROM sdr_lead_state WHERE pipedrive_lead_id=$1${lock?' FOR UPDATE':''}`,[draft.pipedrive_lead_id])).rows[0];
  if(!companyId||!local||local.crm_company_id&&String(local.crm_company_id)!==String(companyId)||['archived','missing','inaccessible'].includes(local.crm_status))throw conflict('crm_unavailable');
  const context=await readDecisionContext(db,draft.pipedrive_lead_id,{companyId,draftId:draft.id});
  // A review draft needs observed identity, not prior permission to send. Role review
  // and approval must still happen on the new draft before enrollment is possible.
  if(!context.personId||!context.organizationId||!context.recipientEmail||!context.stage||!context.trigger)throw conflict('replacement_context_incomplete');
  const sources=(await db.query(`SELECT count(*)::int AS n FROM sdr_crm_snapshots WHERE company_id=$1 AND access_status='accessible' AND lifecycle='active' AND NOT is_test AND source_updated_at IS NOT NULL
    AND ((entity='lead' AND entity_id=$2) OR (entity='person' AND entity_id=$3) OR (entity='organization' AND entity_id=$4))`,[String(companyId),context.leadId,context.personId,context.organizationId])).rows[0];
  const denied=(await db.query("SELECT 1 FROM sdr_crm_scope_coverage WHERE company_id=$1 AND error_category='permission' AND scope IN ('leads_active','leads_archived','persons','organizations') LIMIT 1",[String(companyId)])).rows.length;
  if(sources.n!==3||denied)throw conflict('crm_unavailable');
  if(expected&&expected.currentContextHash!==context.contextHash)throw conflict('draft_context_changed');
  // Check the old artifact's restrictions as well as the proposed current recipient.
  // A replacement never releases a hold just by receiving a new UUID.
  for(const email of new Set([draft.contact_email_snapshot,context.recipientEmail]))await assertOutreachAllowed(db,{...context,draftId:draft.id,recipientEmail:email,serviceId:draft.metadata?.service_id,channel:'email'},{action:'replace_review_draft'});
  const competing=await db.query(`SELECT 1 FROM sdr_drafts WHERE pipedrive_lead_id=$1 AND (status IN ('pending','approved','edited','sent') OR sent_at IS NOT NULL)
    UNION ALL SELECT 1 FROM sdr_sends WHERE pipedrive_lead_id=$1
    UNION ALL SELECT 1 FROM sdr_provider_operations WHERE lead_id=$1 LIMIT 1`,[draft.pipedrive_lead_id]);
  if(competing.rows.length||local.sequence_started)throw conflict('existing_outreach_requires_review');
  return {draft,context};
}

export async function createReplacementReviewDraft({pool,companyId,user,id,expected,buildDraftFromLead}) {
  if(typeof expected?.reason!=='string'||!expected.reason.trim())throw conflict('replacement_reason_required',400);
  const before=await inspect(pool,{id,user,companyId,expected});
  const payload=await buildDraftFromLead({pipedriveLeadId:before.draft.pipedrive_lead_id,triggerType:before.context.trigger,pool,assignedUserId:before.draft.assigned_user_id,apolloSequenceId:before.draft.apollo_sequence_id,assignedMailboxId:before.draft.assigned_mailbox_id});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('outreach-global-controls',0))");
    await acquireLeadLock(client,before.draft.pipedrive_lead_id);
    const {draft,context}=await inspect(client,{id,user,companyId,expected,lock:true});
    for(const [field,value]of Object.entries({pipedrive_lead_id:context.leadId,contact_id_snapshot:context.personId,contact_email_snapshot:context.recipientEmail,org_id_snapshot:context.organizationId,trigger_type:context.trigger,assigned_user_id:draft.assigned_user_id,assigned_mailbox_id:draft.assigned_mailbox_id,apollo_sequence_id:draft.apollo_sequence_id}))if(!same(payload[field],value))throw conflict('generated_context_changed');
    if(!same(payload.metadata?.project_stage,context.stage)||!payload.subject||!payload.body)throw conflict('generated_context_changed');
    if(payload.metadata?.service_id && draft.metadata?.service_id && !same(payload.metadata.service_id,draft.metadata.service_id))throw conflict('generated_context_changed');
    const replacementId=randomUUID(),actionId=randomUUID();
    const metadata={...payload.metadata,service_id:draft.metadata?.service_id??payload.metadata?.service_id,replacement_of:draft.id,replacement_action_id:actionId,cadence:draft.metadata?.cadence==='award_only'?'award_only':context.cadence};
    for(const field of ['reviewed_outreach_context_hash','role_exception_id','override_decision_id'])delete metadata[field];
    await assertOutreachAllowed(client,{...context,draftId:replacementId,serviceId:metadata.service_id,channel:'email'},{action:'replace_review_draft'});
    await recordChangeIntent(client,{actionId,companyId,entity:'draft',entityId:draft.id,expectedFields:{draftId:draft.id,revision:String(draft.revision),contextHash:expected.expectedContextHash,currentContextHash:context.contextHash},proposedFields:{draftId:replacementId,status:'pending',purpose:'replacement_review'},actor:{accountId:user.sub,source:'sdr_ui',execution:'interactive'},reason:expected.reason.trim(),contextHash:context.contextHash});
    const created=(await client.query(`INSERT INTO sdr_drafts(id,pipedrive_lead_id,pipedrive_contact_id,pipedrive_org_id,contact_id_snapshot,contact_email_snapshot,org_id_snapshot,trigger_type,apollo_sequence_id,assigned_mailbox_id,assigned_user_id,subject,body,metadata,status,content_origin,scheduled_for)
      VALUES($1,$2,$3,$4,$3,$5,$4,$6,$7,$8,$9,$10,$11,$12,'pending','interactive',$13) RETURNING *`,[replacementId,context.leadId,context.personId,context.organizationId,context.recipientEmail,context.trigger,draft.apollo_sequence_id,draft.assigned_mailbox_id,draft.assigned_user_id,payload.subject,payload.body,metadata,draft.scheduled_for])).rows[0];
    await recordChangeReceipt(client,{actionId,status:'confirmed',observedFields:{draftId:created.id,status:created.status,revision:String(created.revision),contextHash:draftContextHash(created)}});
    await client.query('COMMIT');return serializeDraft(created);
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;} finally {client.release();}
}

export function registerSdrDraftReplacementRoutes(app,{pool,companyId,buildDraftFromLead}) {
  const fail=(res,error)=>res.status(error.status||500).json({error:error.status?error.message:'Replacement review could not be created',code:error.code,preserveDraft:true});
  app.get('/api/sdr/drafts/:id/replacement-context',async(req,res)=>{
    try {const {draft,context}=await inspect(pool,{id:req.params.id,user:req.sdrUser,companyId});res.json({draft:serializeDraft(draft),context});}catch(error){fail(res,error);}
  });
  app.post('/api/sdr/drafts/:id/replacement',async(req,res)=>{
    try {interactiveOwner(req.sdrUser);const draft=await createReplacementReviewDraft({pool,companyId,user:req.sdrUser,id:req.params.id,expected:req.body,buildDraftFromLead});res.status(201).json({draft});}catch(error){fail(res,error);}
  });
}
