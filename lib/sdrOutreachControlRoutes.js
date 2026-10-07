import {getOutreachControls,controlSummary,setOutreachControl,resolveOutreachControl} from './sdrOutreachControls.js';
import {readDecisionContext,hashDecisionContext,hashContextDependencies,recordChangeIntent,recordChangeReceipt} from './sdrChangeJournal.js';
import {withLeadLock} from './sdrAccess.js';
import {randomUUID} from 'node:crypto';

export function registerSdrOutreachControlRoutes(app,{pool,companyId,canViewLead,readContext=readDecisionContext}) {
 const route=fn=>async(req,res)=>{
  if(!req.sdrUser?.sub||req.sdrUser.machine)return res.status(401).json({error:'Interactive session required'});
  try {
   if(!await canViewLead(req,req.params.leadId))return res.status(404).json({error:'Lead unavailable'});
   return await fn(req,res);
  }catch(e){return res.status(e.status||503).json({error:e.status?e.code:'Controls unavailable'});}
 };
 const context=req=>readContext(pool,req.params.leadId,{companyId});
 const actor=req=>({source:'sdr_ui',accountId:String(req.sdrUser.sub),execution:'interactive',ownership:'external_or_unknown'});
 app.get('/api/sdr/leads/:leadId/controls',route(async(req,res)=>{
  const c=await context(req);
  // Return every project restriction even when the current draft differs.
  const rows=(await pool.query("SELECT * FROM sdr_outreach_controls WHERE company_id=$1 AND lead_id=$2 AND status='active' ORDER BY created_at,id",[String(companyId),req.params.leadId])).rows;
  const applicable=await getOutreachControls(pool,{...c,companyId,leadId:req.params.leadId});
  const provider=(await pool.query(`SELECT s.status,s.apollo_sequence_id,s.apollo_contact_id,s.sent_at,d.contact_email_snapshot AS recipient_email
   FROM sdr_sends s LEFT JOIN sdr_drafts d ON d.id=s.draft_id WHERE s.pipedrive_lead_id=$1 ORDER BY s.sent_at DESC NULLS LAST LIMIT 1`,[req.params.leadId])).rows[0];
  const proposals=(await pool.query(`SELECT id,entity,entity_id,proposed_fields,reason,last_seen_at FROM sdr_crm_proposals
   WHERE company_id=$1 AND status='review' AND ((entity='lead' AND entity_id=$2) OR (entity='person' AND entity_id=$3))
   ORDER BY last_seen_at DESC LIMIT 20`,[String(companyId),req.params.leadId,c.personId])).rows;
  // Keep old project restrictions visible alongside applicable account-wide holds.
  // An unknown identity blocks conservatively, but does not authorize disclosure of other recipients' restrictions.
  const recipient=String(c.recipientEmail||'').trim().toLowerCase();
  const visibleApplicable=applicable.filter(control=>control.scope_kind!=='recipient'||
   Boolean(recipient&&recipient===String(control.scope_id).trim().toLowerCase()));
  const controls=[...new Map([...rows,...visibleApplicable].map(control=>[control.id,control])).values()]
   .map(control=>({...control,canResolveOnProject:control.lead_id===req.params.leadId}));
  return res.json({...controlSummary(applicable),controls,context:c,proposals,
   provider:provider?{recipientEmail:provider.recipient_email,localStatus:provider.status,sequenceId:provider.apollo_sequence_id,membershipState:'unverified',verifiedAt:null,source:'historical_enrollment'}:null});
 }));
 app.post('/api/sdr/leads/:leadId/controls',route(async(req,res)=>{
  const c=await context(req),body=req.body||{},scope=body.scope;
  // Broad recipient/channel restrictions require cross-owner review outside this project route.
  if(scope?.kind!=='lead'||String(scope.id)!==req.params.leadId)return res.status(400).json({error:'Project hold required'});
  if(!body.contextHash||body.contextHash!==c.contextHash)return res.status(409).json({error:'control_context_changed',context:c});
  return res.status(201).json(await setOutreachControl(pool,{companyId,leadId:req.params.leadId,scope,channel:'email',reason:body.reason,contextHash:c.contextHash,actor:actor(req)}));
 }));
 app.post('/api/sdr/leads/:leadId/controls/:controlId/resolve',route(async(req,res)=>{
  const body=req.body||{};
  const result=await withLeadLock(pool,req.params.leadId,async client=>{
   // The viewed context must still match after waiting for concurrent lead work.
   const c=await readContext(client,req.params.leadId,{companyId});
   const existing=(await client.query('SELECT * FROM sdr_outreach_controls WHERE id=$1 AND company_id=$2 AND lead_id=$3',[req.params.controlId,String(companyId),req.params.leadId])).rows[0];
   if(!existing)throw Object.assign(new Error('Control unavailable'),{code:'Control unavailable',status:404});
   if(req.sdrUser.role!=='admin'&&existing.owner_id!==String(req.sdrUser.sub))throw Object.assign(new Error('Control owner or admin required'),{code:'Control owner or admin required',status:403});
   if(!body.contextHash||body.contextHash!==c.contextHash)throw Object.assign(new Error('context changed'),{code:'control_context_changed',status:409});
   return resolveOutreachControl(client,{id:existing.id,companyId,expectedVersion:body.expectedVersion,decision:body.decision,evidence:body.evidence,expectedContextHash:existing.context_hash,contextHash:c.contextHash,actor:actor(req)});
  });
  return res.json(result);
 }));
 app.post('/api/sdr/leads/:leadId/outreach-review',route(async(req,res)=>{
  const body=req.body||{};
  if(!['standard','award_only'].includes(body.cadence)||!body.projectRole?.trim()||!body.evidence?.trim())return res.status(400).json({error:'Role, cadence and supporting evidence required'});
  const saved=await withLeadLock(pool,req.params.leadId,async client=>{
   const c=await readContext(client,req.params.leadId,{companyId});
   if(!body.contextHash||c.contextHash!==body.contextHash)throw Object.assign(new Error('context changed'),{code:'control_context_changed',status:409});
   if(!c.personId||!c.organizationId||!c.recipientEmail||!c.trigger)throw Object.assign(new Error('source incomplete'),{code:'source_context_incomplete',status:409});
   const actionId=randomUUID(),a=actor(req),review={projectRole:body.projectRole.trim(),cadence:body.cadence,evidence:body.evidence.trim(),roleExceptionId:actionId,
    overrideDecisionId:c.hasTriggerOverride?actionId:null,identityHash:hashContextDependencies(c),actor:a,reviewedAt:new Date().toISOString()};
   await recordChangeIntent(client,{actionId,companyId,entity:'outreach_review',entityId:req.params.leadId,expectedFields:{contextHash:c.contextHash},proposedFields:review,actor:a,reason:review.evidence,contextHash:c.contextHash});
   const updated=await client.query('UPDATE sdr_lead_state SET safety_context=$2::jsonb WHERE pipedrive_lead_id=$1 AND (crm_company_id IS NULL OR crm_company_id=$3) RETURNING pipedrive_lead_id',[req.params.leadId,review,String(companyId)]);
   if(!updated.rowCount)throw Object.assign(new Error('source incomplete'),{code:'source_context_incomplete',status:409});
   // Bind the current unsent artifact to this exact review; its revision advances and
   // previous approvals are invalidated. Subject/body and staff recipient choices stay intact.
   const reviewedHash=hashDecisionContext({...c,projectRole:review.projectRole,cadence:review.cadence,roleExceptionId:actionId,overrideDecisionId:review.overrideDecisionId});
   const mailbox=c.mailboxId?(await client.query('SELECT email,apollo_mailbox_id FROM sdr_mailboxes WHERE id=$1 AND active=TRUE',[c.mailboxId])).rows[0]:null;
   if(c.draftId)await client.query(`UPDATE sdr_drafts SET metadata=COALESCE(metadata,'{}'::jsonb)||$2::jsonb,
    status='pending',content_origin='interactive',approved_at=NULL,approved_by=NULL,updated_at=NOW()
    WHERE id=$1 AND status IN ('pending','approved','edited') AND sent_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM sdr_sends s WHERE s.draft_id=sdr_drafts.id)`,[c.draftId,{reviewed_outreach_context_hash:reviewedHash,project_role:review.projectRole,role_exception_id:actionId,cadence:review.cadence,override_decision_id:review.overrideDecisionId,project_stage:c.stage,sender_email:mailbox?.email||null,sender_provider_id:mailbox?.apollo_mailbox_id||null}]);
   await recordChangeReceipt(client,{actionId,status:'confirmed',observedFields:review});
   return review;
  });
  return res.json({review:saved,sendingAuthorized:false});
 }));
}
