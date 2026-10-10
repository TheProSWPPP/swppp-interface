import {createHash} from 'node:crypto';
import {readFollowupDraft} from './sdrFollowupDrafts.js';

const unknownQuote=()=>({requested:'unknown',prepared:'unknown',sent:'unknown',acknowledged:'unknown'});
const fail=code=>Object.assign(new Error(code),{code});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unresolved=async(pool,{companyId,leadId})=>(await pool.query("SELECT 1 FROM sdr_followup_handoffs WHERE company_id=$1 AND lead_id=$2 AND status IN ('reserved','uncertain') LIMIT 1",[companyId,leadId])).rowCount>0;

export async function prepareProposal({pool,companyId,leadId,viewer,sourceRef,editorRequestVersion,readDraft=readFollowupDraft,readSource,readUnresolved=unresolved,generate}){
 if(!pool||typeof companyId!=='string'||!companyId||typeof leadId!=='string'||!leadId||!Number.isSafeInteger(editorRequestVersion)||editorRequestVersion<0||!sourceRef||typeof readSource!=='function'||typeof generate!=='function')throw fail('invalid_preparation');
 const identity={companyId,leadId,viewer};
 const before=await readDraft(pool,identity);
 if(before.contextChanged)throw fail('context_changed');
 if(await readUnresolved(pool,identity))throw fail('publication_unresolved');
 const initial=await readSource({...identity,sourceRef,current:before});
 const valid=source=>source&&source.companyId===companyId&&source.leadId===leadId&&source.linkage==='direct_unique'&&source.mailboxAuthorization!=='denied'&&source.mailboxAuthorization!=='unknown'&&typeof source.identity==='string'&&source.identity&&typeof source.text==='string'&&source.text.trim()&&source.text.length<=6000&&source.provenance;
 if(!valid(initial))throw fail('source_unavailable');
 const envelope={companyId,leadId,viewerId:viewer?.sub,viewerRole:viewer?.role,sourceIdentity:initial.identity,sourceDigest:digest(initial.text),linkage:initial.linkage,mailboxAuthorization:initial.mailboxAuthorization,provenance:initial.provenance,contextToken:before.contextToken,revision:before.draft?.revision||0,editorRequestVersion};
 const proposed=await generate({sourceText:initial.text,source:initial.provenance,project:before.context.lead,missingFacts:['quote requested','quote prepared','quote sent','quote acknowledged','order confirmed'],envelope});
 const after=await readDraft(pool,identity);
 if(await readUnresolved(pool,identity))throw fail('publication_unresolved');
 if(after.contextToken!==envelope.contextToken||(after.draft?.revision||0)!==envelope.revision||after.contextChanged!==before.contextChanged)throw fail('context_changed');
 const latest=await readSource({...identity,sourceRef,current:after});
 // The body reader may await a provider. Revalidate the viewer, CRM context, revision,
 // and publication state after that await, immediately before returning text.
 const finalDraft=await readDraft(pool,identity);
 if(await readUnresolved(pool,identity))throw fail('publication_unresolved');
 if([after,finalDraft].some(current=>current.contextToken!==envelope.contextToken||(current.draft?.revision||0)!==envelope.revision||current.contextChanged!==before.contextChanged))throw fail('context_changed');
 if(!valid(latest)||latest.identity!==envelope.sourceIdentity||digest(latest.text)!==envelope.sourceDigest||digest(latest.provenance)!==digest(envelope.provenance)||latest.mailboxAuthorization!==envelope.mailboxAuthorization)throw fail('source_changed');
 if(!proposed||typeof proposed.subject!=='string'||proposed.subject.length>500||typeof proposed.body!=='string'||!proposed.body.trim()||proposed.body.length>20000||!Array.isArray(proposed.missingFacts)||proposed.missingFacts.some(f=>typeof f!=='string'||f.length>200))throw fail('invalid_proposal');
 return {subject:proposed.subject,body:proposed.body,missingFacts:proposed.missingFacts,source:{identity:initial.identity,digest:envelope.sourceDigest,provenance:initial.provenance},contextToken:envelope.contextToken,revision:envelope.revision,editorRequestVersion};
}

export function projectSalesOpportunity({companyId,context,source=null,publication=null,outcomes=[]}){
 const task=context.tasks?.[0]||null;
 const exact=value=>Boolean(companyId&&value.companyId===companyId&&value.leadId===context.lead.id);
 const outgoing=outcomes.find(value=>exact(value)&&value.kind==='outgoing_reply'&&value.source==='connected_gmail'&&value.linkage==='direct_unique'&&value.providerMessageId)||null;
 const action=outcomes.find(value=>exact(value)&&value.kind==='original_task_action'&&value.taskId===task?.id&&value.sourceId&&value.verified===true)||null;
 const quote=unknownQuote();
 for(const stage of Object.keys(quote)){
  const evidence=outcomes.find(value=>exact(value)&&value.kind==='quote'&&value.stage===stage&&value.sourceId&&value.verified===true);
  if(evidence)quote[stage]={status:'observed',sourceId:evidence.sourceId};
 }
 const orderEvidence=outcomes.find(value=>exact(value)&&value.kind==='order'&&value.sourceId&&value.verified===true);
 const published=exact(publication||{})&&publication.status==='confirmed'&&publication.noteId&&publication.readbackVerified===true;
 const publicationStatus=published?'confirmed':exact(publication||{})&&publication.status==='uncertain'?'uncertain':exact(publication||{})&&publication.status==='previewed'?'previewed':'private';
 return {leadId:context.lead.id,projectTitle:context.lead.title,contact:{id:context.lead.personId,name:context.lead.contactName,email:context.lead.contactEmail},owner:{id:context.lead.ownerId},source,sourceFreshness:context.lead.observedAt||null,
  nextAction:task?{taskId:task.id,ownerId:task.ownerId,dueDate:task.dueDate,subject:task.subject}:null,
  coverage:context.coverage?.partial===false?'complete':'partial',quote,order:orderEvidence?{status:'observed',sourceId:orderEvidence.sourceId}:{status:'unknown'},
  incoming:outcomes.filter(value=>exact(value)&&value.kind==='incoming_reply'&&value.sourceId&&value.linkage==='direct_unique'),
  outgoing:outgoing?{status:'observed',source:outgoing.source,authorship:'unknown',providerMessageId:outgoing.providerMessageId,observedAt:outgoing.observedAt||null}: {status:'unknown'},
  handoff:{publication:publicationStatus,noteId:published?publication.noteId:null,checkedAt:published?publication.checkedAt||null:null,delivery:'unknown',awareness:'unknown',action:action?{status:'observed',sourceId:action.sourceId,taskId:action.taskId}:'unknown'}};
}
