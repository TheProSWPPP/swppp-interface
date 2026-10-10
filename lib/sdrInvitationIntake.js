import {createHash} from 'node:crypto';
import {parseCsv,detectSource,detectPlatform} from './leadCsvNormalize.js';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean=value=>String(value??'').trim();
const dateOnly=value=>/^\d{4}-\d{2}-\d{2}$/.test(clean(value))&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`))?clean(value):null;
const unknownQuote=()=>({requested:'unknown',prepared:'unknown',sent:'unknown',acknowledged:'unknown'});
const sourceKey=row=>row.sourceUrl?`url:${row.sourceUrl}`:`row:${row.batchId}:${row.sourceRowId}`;

function trackerRows(csvText,batchId){
 const parsed=parseCsv(csvText),headers=parsed[0]||[];
 if(detectSource(headers)!=='bid-aggregator')throw new Error('tracker_export_required');
 return parsed.slice(1).map((cells,index)=>{
  const row=Object.fromEntries(headers.map((header,i)=>[header,cells[i]??'']));
  return {sourceRowId:String(index+2),batchId,projectTitle:row['Project Title'],bidder:row.Company,contactName:row['Contact Name'],contactEmail:row['Primary Email'],sourceUrl:row['Quick Link'],bidDate:row['Bid Date'],rawSource:row};
 });
}

export function stageInvitationBatch({csvText,rows,batchId,observedAt,priorReceipt=null,crmCandidates=[]}={}){
 if(!clean(batchId)||!Number.isFinite(Date.parse(observedAt)))throw new Error('invalid_batch');
 if((csvText===undefined)===(rows===undefined))throw new Error('one_source_required');
 const sourceRows=csvText===undefined?rows:trackerRows(csvText,batchId);
 if(!Array.isArray(sourceRows)||!Array.isArray(crmCandidates))throw new Error('invalid_source');
 const candidates=structuredClone(priorReceipt?.candidates||[]).map(({sourceRef,...candidate})=>candidate);
 const byKey=new Map(candidates.map((candidate,index)=>[candidate.key,index]));
 for(const raw of sourceRows){
  const sourceUrl=clean(raw.sourceUrl)||null;
  if(sourceUrl&&detectPlatform(sourceUrl)!=='BuildingConnected')throw new Error('buildingconnected_source_required');
  const row={batchId,sourceRowId:clean(raw.sourceRowId),projectTitle:clean(raw.projectTitle),bidder:clean(raw.bidder),contactName:clean(raw.contactName)||null,contactEmail:clean(raw.contactEmail)||null,sourceUrl,bidDate:dateOnly(raw.bidDate),proposalDeadline:dateOnly(raw.proposalDeadline),status:['closed','withdrawn','submitted'].includes(raw.status)&&raw.statusSource?raw.status:'unknown',statusSource:raw.statusSource||null,observedAt,rawSource:raw.rawSource||null};
  if(!row.sourceRowId||!row.projectTitle)throw new Error('invalid_source_row');
  const key=sourceKey(row),rowRef={batchId,sourceRowId:row.sourceRowId,digest:digest(row)};
  const priorIndex=byKey.get(key);
  if(priorIndex!==undefined){
   const candidate=candidates[priorIndex];
   if(candidate.projectTitle!==row.projectTitle||candidate.bidder!==row.bidder||candidate.bidDate!==row.bidDate){candidate.match={status:'unresolved',reason:'source_conflict'};candidate.conflict=true;}
   if(!candidate.sourceRows.some(r=>r.batchId===batchId&&r.sourceRowId===row.sourceRowId))candidate.sourceRows.push(rowRef);
   candidate.observedAt=observedAt;
   if(row.status!=='unknown'){candidate.status=row.status;candidate.statusSource=row.statusSource;}
   continue;
  }
  const matches=sourceUrl?crmCandidates.filter(crm=>crm.sourceUrl===sourceUrl&&crm.companyId&&crm.leadId&&crm.lifecycle==='active'&&crm.accessStatus==='accessible'):[];
  const match=matches.length===1?{status:'exact',leadId:String(matches[0].leadId),companyId:String(matches[0].companyId),sourceUrl}:{status:'unresolved',reason:sourceUrl?matches.length>1?'ambiguous_crm':'no_exact_crm_source':'missing_source_url'};
  const candidate={key,source:'BuildingConnected',sourceUrl,projectTitle:row.projectTitle,bidder:row.bidder,contactName:row.contactName,contactEmail:row.contactEmail,bidDate:row.bidDate,proposalDeadline:row.proposalDeadline,constructionStart:null,status:row.status,statusSource:row.statusSource,observedAt,sourceRows:[rowRef],rawSource:row.rawSource,match,quote:unknownQuote(),order:{status:'unknown'},invitationMessage:null,conflict:false};
  byKey.set(key,candidates.length);candidates.push(candidate);
 }
 const revision=(priorReceipt?.revision||0)+1;
 const receiptDigest=digest({revision,candidates});
 for(const candidate of candidates)candidate.sourceRef={kind:'staged_invitation',key:candidate.key,sourceUrl:candidate.sourceUrl,sourceRows:candidate.sourceRows,receiptRevision:revision,receiptDigest,match:candidate.match};
 return {candidates,receipt:{version:1,revision,digest:receiptDigest,candidates,activation:{status:'inactive',exportLocation:null,operator:null,cadence:null}}};
}
