import {createHash} from 'node:crypto';
import {readFollowupDraft} from './sdrFollowupDrafts.js';
import {readSalesLoopEvidence} from './sdrSalesLoopObservations.js';

export const preparationActions=['reply','call','wait','quote_lookup','operations','identity_resolution','no_action'];
export const validPreparedAction=(value,action)=>Boolean(value&&value.action===action&&preparationActions.includes(action)&&typeof value.reason==='string'&&value.reason.trim()&&value.reason.length<=2000&&
 (value.subject===null&&value.body===null||action==='reply'&&typeof value.subject==='string'&&value.subject.length<=500&&typeof value.body==='string'&&value.body.trim()&&value.body.length<=20000)&&
 Array.isArray(value.missingFacts)&&value.missingFacts.every(f=>typeof f==='string'&&f.length<=200)&&value.missingFacts.length<=30);

const unknownQuote=()=>({requested:'unknown',prepared:'unknown',sent:'unknown',acknowledged:'unknown'});
const fail=code=>Object.assign(new Error(code),{code});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unresolved=async(pool,{companyId,leadId})=>(await pool.query("SELECT 1 FROM sdr_followup_handoffs WHERE company_id=$1 AND lead_id=$2 AND status IN ('reserved','uncertain') LIMIT 1",[companyId,leadId])).rowCount>0;

export async function prepareProposal({pool,companyId,leadId,viewer,sourceRef,editorRequestVersion,action,conversationReviewed=false,readEvidence=readSalesLoopEvidence,resolveVisibleMailboxes,readDraft=readFollowupDraft,readSource,readUnresolved=unresolved,generate}){
 if(!preparationActions.includes(action)||action==='reply'&&conversationReviewed!==true||!pool||typeof companyId!=='string'||!companyId||typeof leadId!=='string'||!leadId||!Number.isSafeInteger(editorRequestVersion)||editorRequestVersion<0||!sourceRef||typeof readSource!=='function'||typeof generate!=='function')throw fail('invalid_preparation');
 const identity={companyId,leadId,viewer};
 const before=await readDraft(pool,identity);
 if(before.contextChanged)throw fail('context_changed');
 if(await readUnresolved(pool,identity))throw fail('publication_unresolved');
 const initial=await readSource({...identity,sourceRef,current:before});
 const valid=source=>source&&source.companyId===companyId&&source.leadId===leadId&&source.linkage==='direct_unique'&&source.mailboxAuthorization!=='denied'&&source.mailboxAuthorization!=='unknown'&&typeof source.identity==='string'&&source.identity&&typeof source.text==='string'&&source.text.trim()&&source.text.length<=6000&&source.provenance;
 if(!valid(initial))throw fail('source_unavailable');
 const evidence=await readEvidence(pool,{...identity,current:before,resolveVisibleMailboxes});
 if(Buffer.byteLength(JSON.stringify({evidence,sourceText:initial.text,source:initial.provenance}))>60000)throw fail('source_unavailable');
 const evidenceDigest=digest(evidence);
 const envelope={action,conversationReviewed,evidenceDigest,companyId,leadId,viewerId:viewer?.sub,viewerRole:viewer?.role,sourceIdentity:initial.identity,sourceDigest:digest(initial.text),linkage:initial.linkage,mailboxAuthorization:initial.mailboxAuthorization,provenance:initial.provenance,contextToken:before.contextToken,revision:before.draft?.revision||0,editorRequestVersion};
 const proposed=await generate({action,evidence,sourceText:initial.text,source:initial.provenance,project:before.context.lead,missingFacts:['quote requested','quote prepared','quote sent','quote acknowledged','order confirmed'],envelope});
 const after=await readDraft(pool,identity);
 if(await readUnresolved(pool,identity))throw fail('publication_unresolved');
 if(after.contextToken!==envelope.contextToken||(after.draft?.revision||0)!==envelope.revision||after.contextChanged!==before.contextChanged)throw fail('context_changed');
 const latest=await readSource({...identity,sourceRef,current:after});
 // The body reader may await a provider. Revalidate the viewer, CRM context, revision,
 // and publication state after that await, immediately before returning text.
 const latestEvidence=await readEvidence(pool,{...identity,current:after,resolveVisibleMailboxes});
 const finalDraft=await readDraft(pool,identity);
 if(await readUnresolved(pool,identity))throw fail('publication_unresolved');
 if([after,finalDraft].some(current=>current.contextToken!==envelope.contextToken||(current.draft?.revision||0)!==envelope.revision||current.contextChanged!==before.contextChanged))throw fail('context_changed');
 if(digest(latestEvidence)!==evidenceDigest)throw fail('source_changed');
 if(!valid(latest)||latest.identity!==envelope.sourceIdentity||digest(latest.text)!==envelope.sourceDigest||digest(latest.provenance)!==digest(envelope.provenance)||latest.mailboxAuthorization!==envelope.mailboxAuthorization)throw fail('source_changed');
 if(!validPreparedAction(proposed,action))throw fail('invalid_proposal');
 return {action,reason:proposed.reason,subject:proposed.subject,body:proposed.body,missingFacts:proposed.missingFacts,evidence,evidenceDigest,source:{identity:initial.identity,digest:envelope.sourceDigest,provenance:initial.provenance},contextToken:envelope.contextToken,revision:envelope.revision,editorRequestVersion};
}

export function projectSalesOpportunity({companyId,context,source=null,publication=null,outcomes=[],activities=[]}){
 // No stable handoff task reference is stored by this projection.
 // Current activities remain project evidence, without inferred handoff attribution.
 const exact=value=>Boolean(companyId&&value.companyId===companyId&&value.leadId===context.lead.id);
 const outgoing=outcomes.find(value=>exact(value)&&value.kind==='outgoing_reply'&&value.source==='connected_gmail'&&value.linkage==='direct_unique'&&value.providerMessageId)||null;
 const quote=unknownQuote();
 for(const stage of Object.keys(quote)){
  const evidence=outcomes.find(value=>exact(value)&&value.kind==='quote'&&value.stage===stage&&value.sourceId&&value.verified===true);
  if(evidence)quote[stage]={status:'observed',sourceId:evidence.sourceId};
 }
 const orderEvidence=outcomes.find(value=>exact(value)&&value.kind==='order'&&value.sourceId&&value.verified===true);
 const published=exact(publication||{})&&publication.status==='confirmed'&&publication.noteId&&publication.readbackVerified===true;
 const publicationStatus=published?'confirmed':exact(publication||{})&&publication.status==='uncertain'?'uncertain':exact(publication||{})&&publication.status==='previewed'?'previewed':'private';
 return {leadId:context.lead.id,projectTitle:context.lead.title,contact:{id:context.lead.personId,name:context.lead.contactName,email:context.lead.contactEmail},owner:{id:context.lead.ownerId,name:context.lead.ownerName||null},source,sourceFreshness:context.lead.observedAt||null,
  nextAction:null,activities,openTasks:context.tasks||[],
  coverage:context.coverage?.partial===false?'complete':'partial',quote,order:orderEvidence?{status:'observed',sourceId:orderEvidence.sourceId}:{status:'unknown'},
  incoming:outcomes.filter(value=>exact(value)&&value.kind==='incoming_reply'&&value.sourceId&&value.linkage==='direct_unique'),
  outgoing:outgoing?{status:'observed',source:outgoing.source,authorship:'unknown',providerMessageId:outgoing.providerMessageId,observedAt:outgoing.observedAt||null}: {status:'unknown'},
  handoff:{publication:publicationStatus,noteId:published?publication.noteId:null,checkedAt:published?publication.checkedAt||null:null,delivery:'unknown',awareness:'unknown',action:'unknown'}};
}
