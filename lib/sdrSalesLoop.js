import {createHash} from 'node:crypto';
import {readFollowupDraft} from './sdrFollowupDrafts.js';

const unknownQuote=()=>({requested:'unknown',prepared:'unknown',sent:'unknown',acknowledged:'unknown'});
const fail=code=>Object.assign(new Error(code),{code});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function prepareProposal({pool,companyId,leadId,viewer,sourceRef,editorRequestVersion,readDraft=readFollowupDraft,readSource,generate}){
 if(!pool||typeof companyId!=='string'||!companyId||typeof leadId!=='string'||!leadId||!Number.isSafeInteger(editorRequestVersion)||editorRequestVersion<0||!sourceRef||typeof readSource!=='function'||typeof generate!=='function')throw fail('invalid_preparation');
 const identity={companyId,leadId,viewer};
 const before=await readDraft(pool,identity);
 const initial=await readSource({...identity,sourceRef,current:before});
 const valid=source=>source&&source.companyId===companyId&&source.leadId===leadId&&source.linkage==='direct_unique'&&source.mailboxAuthorization!=='denied'&&source.mailboxAuthorization!=='unknown'&&typeof source.identity==='string'&&source.identity&&typeof source.text==='string'&&source.text.trim()&&source.text.length<=6000&&source.provenance;
 if(!valid(initial))throw fail('source_unavailable');
 const envelope={companyId,leadId,viewerId:viewer?.sub,viewerRole:viewer?.role,sourceIdentity:initial.identity,sourceDigest:digest(initial.text),linkage:initial.linkage,mailboxAuthorization:initial.mailboxAuthorization,provenance:initial.provenance,contextToken:before.contextToken,revision:before.draft?.revision||0,editorRequestVersion};
 const proposed=await generate({sourceText:initial.text,source:initial.provenance,project:before.context.lead,missingFacts:['quote requested','quote prepared','quote sent','quote acknowledged','order confirmed'],envelope});
 const after=await readDraft(pool,identity);
 const latest=await readSource({...identity,sourceRef,current:after});
 if(after.contextToken!==envelope.contextToken||(after.draft?.revision||0)!==envelope.revision||after.contextChanged!==before.contextChanged)throw fail('context_changed');
 if(!valid(latest)||latest.identity!==envelope.sourceIdentity||digest(latest.text)!==envelope.sourceDigest||digest(latest.provenance)!==digest(envelope.provenance)||latest.mailboxAuthorization!==envelope.mailboxAuthorization)throw fail('source_changed');
 if(!proposed||typeof proposed.subject!=='string'||proposed.subject.length>500||typeof proposed.body!=='string'||!proposed.body.trim()||proposed.body.length>20000||!Array.isArray(proposed.missingFacts)||proposed.missingFacts.some(f=>typeof f!=='string'||f.length>200))throw fail('invalid_proposal');
 return {subject:proposed.subject,body:proposed.body,missingFacts:proposed.missingFacts,source:{identity:initial.identity,digest:envelope.sourceDigest,provenance:initial.provenance},contextToken:envelope.contextToken,revision:envelope.revision,editorRequestVersion};
}

export function projectSalesOpportunity({context,source=null,publication=null,outcomes=[]}){
 const task=context.tasks?.[0]||null;
 const outgoing=outcomes.find(value=>value.kind==='outgoing_reply'&&value.source==='connected_gmail'&&value.providerMessageId)||null;
 const action=outcomes.find(value=>value.kind==='original_task_action'&&value.taskId===task?.id&&value.sourceId)||null;
 const quote=unknownQuote();
 for(const stage of Object.keys(quote)){
  const exact=outcomes.find(value=>value.kind==='quote'&&value.stage===stage&&value.sourceId&&value.leadId===context.lead.id&&value.verified===true);
  if(exact)quote[stage]={status:'observed',sourceId:exact.sourceId};
 }
 const orderEvidence=outcomes.find(value=>value.kind==='order'&&value.sourceId&&value.leadId===context.lead.id&&value.verified===true);
 return {leadId:context.lead.id,projectTitle:context.lead.title,contact:{id:context.lead.personId,name:context.lead.contactName,email:context.lead.contactEmail},owner:{id:context.lead.ownerId},source,sourceFreshness:context.lead.observedAt||null,
  nextAction:task?{taskId:task.id,ownerId:task.ownerId,dueDate:task.dueDate,subject:task.subject}:null,
  coverage:context.coverage?.partial?'partial':'complete',quote,order:orderEvidence?{status:'observed',sourceId:orderEvidence.sourceId}:{status:'unknown'},
  incoming:outcomes.filter(value=>value.kind==='incoming_reply'&&value.sourceId&&value.leadId===context.lead.id),
  outgoing:outgoing?{status:'observed',source:outgoing.source,authorship:'unknown',providerMessageId:outgoing.providerMessageId}: {status:'unknown'},
  handoff:{publication:publication?.status||'private',noteId:publication?.noteId||null,delivery:'unknown',awareness:'unknown',action:action?{status:'observed',sourceId:action.sourceId,taskId:action.taskId}:'unknown'}};
}
