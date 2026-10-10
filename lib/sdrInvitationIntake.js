import {createHash} from 'node:crypto';
import {parseCsv,detectSource,detectPlatform} from './leadCsvNormalize.js';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean=value=>String(value??'').trim();
const dateOnly=value=>/^\d{4}-\d{2}-\d{2}$/.test(clean(value))&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`))?clean(value):null;
const unknownQuote=()=>({requested:'unknown',prepared:'unknown',sent:'unknown',acknowledged:'unknown'});
const sourceKey=row=>row.sourceUrl?`url:${row.sourceUrl}`:`row:${row.batchId}:${row.sourceRowId}`;
const compareEvidence=(a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt)||a.batchId.localeCompare(b.batchId)||a.sourceRowId.localeCompare(b.sourceRowId)||String(a.contentDigest||'').localeCompare(String(b.contentDigest||''));
function reduceStatus(candidate){
 candidate.statusEvidence=(candidate.statusEvidence||[]).sort(compareEvidence);
 const evidence=candidate.statusEvidence,distinct=new Set(evidence.map(item=>item.status));
 candidate.staleStatusEvidence=evidence.some(item=>Date.parse(item.observedAt)<Date.parse(candidate.observedAt));
 if(distinct.size===0){candidate.status='unknown';candidate.statusSource=null;candidate.statusObservedAt=null;return;}
 if(distinct.size>1){
  candidate.status='unknown';candidate.statusSource=null;candidate.statusObservedAt=null;candidate.conflict=true;
  if(candidate.match.status==='exact')candidate.match={status:'unresolved',reason:'status_conflict'};
  return;
 }
 const latest=evidence.at(-1);
 candidate.status=latest.status;candidate.statusSource=latest.statusSource;candidate.statusObservedAt=latest.observedAt;
}

function trackerRows(csvText,batchId){
 const parsed=parseCsv(csvText),headers=parsed[0]||[];
 if(detectSource(headers)!=='bid-aggregator')throw new Error('tracker_export_required');
 return parsed.slice(1).map((cells,index)=>{
  const row=Object.fromEntries(headers.map((header,i)=>[header,cells[i]??'']));
  return {sourceRowId:String(index+2),batchId,projectTitle:row['Project Title'],bidder:row.Company,contactName:row['Contact Name'],contactEmail:row['Primary Email'],sourceUrl:row['Quick Link'],bidDate:row['Bid Date'],rawSource:row};
 });
}

export function stageInvitationBatch({csvText,rows,batchId,observedAt,priorReceipt=null,crmCandidates=[],authorizedMessages=[]}={}){
 if(!clean(batchId)||!Number.isFinite(Date.parse(observedAt)))throw new Error('invalid_batch');
 if((csvText===undefined)===(rows===undefined))throw new Error('one_source_required');
 const sourceRows=csvText===undefined?rows:trackerRows(csvText,batchId);
 if(!Array.isArray(sourceRows)||!Array.isArray(crmCandidates)||!Array.isArray(authorizedMessages))throw new Error('invalid_source');
 if(priorReceipt){
  const priorCandidates=priorReceipt.candidates?.map(({sourceRef,...candidate})=>candidate);
  if(priorReceipt.version!==1||!Number.isSafeInteger(priorReceipt.revision)||priorReceipt.revision<1||!Array.isArray(priorCandidates)||priorReceipt.digest!==digest({revision:priorReceipt.revision,candidates:priorCandidates}))throw new Error('invalid_receipt');
 }
 const candidates=structuredClone(priorReceipt?.candidates||[]).map(({sourceRef,...candidate})=>candidate);
 const byKey=new Map(candidates.map((candidate,index)=>[candidate.key,index]));
 for(const raw of sourceRows){
  const sourceUrl=clean(raw.sourceUrl)||null;
  if(sourceUrl&&detectPlatform(sourceUrl)!=='BuildingConnected')throw new Error('buildingconnected_source_required');
  const row={batchId,sourceRowId:clean(raw.sourceRowId),projectTitle:clean(raw.projectTitle),bidder:clean(raw.bidder),contactName:clean(raw.contactName)||null,contactEmail:clean(raw.contactEmail)||null,sourceUrl,bidDate:dateOnly(raw.bidDate),proposalDeadline:dateOnly(raw.proposalDeadline),bidDeadline:dateOnly(raw.bidDeadline),status:['closed','withdrawn','submitted'].includes(raw.status)&&raw.statusSource?raw.status:'unknown',statusSource:raw.statusSource||null,observedAt,rawSource:raw.rawSource||null};
  if(!row.sourceRowId||!row.projectTitle)throw new Error('invalid_source_row');
  const key=sourceKey(row),rowRef={batchId,sourceRowId:row.sourceRowId,digest:digest(row)};
  const priorIndex=byKey.get(key);
  if(priorIndex!==undefined){
   const candidate=candidates[priorIndex];
   if(candidate.projectTitle!==row.projectTitle||candidate.bidder!==row.bidder||candidate.bidDate!==row.bidDate||candidate.proposalDeadline!==row.proposalDeadline||candidate.bidDeadline!==row.bidDeadline){candidate.match={status:'unresolved',reason:'source_conflict'};candidate.conflict=true;}
   if(!candidate.sourceRows.some(r=>r.batchId===batchId&&r.sourceRowId===row.sourceRowId&&r.digest===rowRef.digest))candidate.sourceRows.push(rowRef);
   if(row.status!=='unknown'&&!candidate.statusEvidence?.some(e=>e.batchId===batchId&&e.sourceRowId===row.sourceRowId&&e.contentDigest===rowRef.digest)){
    candidate.statusEvidence=[...(candidate.statusEvidence||[]),{batchId,sourceRowId:row.sourceRowId,contentDigest:rowRef.digest,status:row.status,statusSource:row.statusSource,observedAt}];
   }
   if(Date.parse(observedAt)>Date.parse(candidate.observedAt))candidate.observedAt=observedAt;
   reduceStatus(candidate);
   continue;
  }
  const matches=sourceUrl?crmCandidates.filter(crm=>crm.sourceUrl===sourceUrl&&crm.companyId&&crm.leadId&&crm.lifecycle==='active'&&crm.accessStatus==='accessible'):[];
  const match=matches.length===1?{status:'exact',leadId:String(matches[0].leadId),companyId:String(matches[0].companyId),sourceUrl}:{status:'unresolved',reason:sourceUrl?matches.length>1?'ambiguous_crm':'no_exact_crm_source':'missing_source_url'};
  const messages=authorizedMessages.filter(message=>message.batchId===batchId&&message.sourceRowId===row.sourceRowId&&message.sourceUrl===sourceUrl&&message.authorized===true&&message.uniqueLink===true&&['gmail','pipedrive'].includes(message.provider)&&clean(message.mailbox)&&clean(message.providerMessageId)&&clean(message.threadId));
  const message=messages.length===1?messages[0]:null;
  const invitationMessage=message?{provider:message.provider,mailbox:clean(message.mailbox).toLowerCase(),providerMessageId:clean(message.providerMessageId),threadId:clean(message.threadId),bodyStatus:'unread',authorizationAtStage:'snapshot_only'}:null;
  const action=matches.length===1?matches[0].nextAction:null;
  const nextExistingAction=action?.taskId&&action?.ownerId?{taskId:String(action.taskId),ownerId:String(action.ownerId),dueDate:dateOnly(action.dueDate),observedAt}:null;
  const candidate={key,source:'BuildingConnected',sourceUrl,projectTitle:row.projectTitle,bidder:row.bidder,contactName:row.contactName,contactEmail:row.contactEmail,bidDate:row.bidDate,proposalDeadline:row.proposalDeadline,bidDeadline:row.bidDeadline,constructionStart:null,status:'unknown',statusSource:null,statusObservedAt:null,statusEvidence:row.status==='unknown'?[]:[{batchId,sourceRowId:row.sourceRowId,contentDigest:rowRef.digest,status:row.status,statusSource:row.statusSource,observedAt}],observedAt,sourceRows:[rowRef],rawSource:row.rawSource,match,nextExistingAction,quote:unknownQuote(),order:{status:'unknown'},invitationMessage,conflict:false};
  reduceStatus(candidate);
  byKey.set(key,candidates.length);candidates.push(candidate);
 }
 const revision=(priorReceipt?.revision||0)+1;
 const receiptDigest=digest({revision,candidates});
 for(const candidate of candidates)candidate.sourceRef={kind:'staged_invitation',key:candidate.key,sourceUrl:candidate.sourceUrl,sourceRows:candidate.sourceRows,receiptRevision:revision,receiptDigest,match:candidate.match};
 return {candidates,receipt:{version:1,revision,digest:receiptDigest,candidates,activation:{status:'inactive',exportLocation:null,operator:null,cadence:null}}};
}
