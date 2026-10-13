import {createHash} from 'node:crypto';

const actionLabels={reply:'Review a reply',call:'Call through the existing owner',wait:'Wait for the existing next step',quote_lookup:'Check the quote record',operations:'Check the operations requirement',identity_resolution:'Resolve the contact identity',no_action:'No new action proposed'};
const checks={
 confirm_quote_delivery:{actions:['reply','quote_lookup'],evidenceClasses:['crm_note','message_body','tracker_record'],label:'Confirm quote delivery with the existing owner'},
 locate_quote_file:{actions:['quote_lookup'],evidenceClasses:['crm_note','message_body','tracker_record'],label:'Locate the exact quote file'},
 confirm_requested_detail:{actions:['reply'],evidenceClasses:['crm_note','message_body','tracker_record'],label:'Confirm the requested detail before sending'},
 confirm_current_need:{actions:['call','reply','no_action'],evidenceClasses:['crm_note','message_body','tracker_record','open_task'],label:'Confirm the current project need'},
 confirm_contact_identity:{actions:['identity_resolution','call','reply'],evidenceClasses:['crm_note','message_body','message_metadata','tracker_record','open_task'],label:'Confirm the current contact identity'},
 confirm_callback_timing:{actions:['call','wait'],evidenceClasses:['open_task'],label:'Confirm callback timing against the existing task'},
 confirm_next_milestone:{actions:['wait'],evidenceClasses:['crm_note','message_body','tracker_record','open_task'],label:'Confirm the next project milestone'},
 confirm_document_status:{actions:['operations'],evidenceClasses:['crm_note','message_body','tracker_record','open_task'],label:'Confirm the requested document status'},
 confirm_order_requirements:{actions:['operations'],evidenceClasses:['crm_note','message_body','tracker_record'],label:'Confirm the order requirements with OPS'},
};
const timestamp=value=>{if(!value)return null;const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString():null;};
const text=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

// Only the authorized source readers construct references. A reference identifies
// a recording, not its truth: notes have no event time or delivery-receipt claim.
export function buildPreparationReferences({source,evidence,companyId,leadId}){
 const references=[];
 const add=value=>{
  const content={...value,sourceUpdatedAt:timestamp(value.sourceUpdatedAt),observedAt:timestamp(value.observedAt),eventTime:timestamp(value.eventTime)};
  const id=createHash('sha256').update(JSON.stringify({companyId,leadId,...content})).digest('hex');
  if(!references.some(ref=>ref.id===id))references.push(Object.freeze({id,...content,allowedClaimTypes:Object.freeze(content.allowedClaimTypes)}));
 };
 const message=source.provenance.kind==='provider_message';
 add({identity:source.identity,evidenceClass:message?'message_body':source.provenance.kind==='staged_invitation'?'tracker_record':'crm_note',
  excerpt:source.text,sourceUpdatedAt:source.provenance.sourceUpdatedAt,observedAt:source.provenance.observedAt,eventTime:message?source.provenance.eventTime:null,
  allowedClaimTypes:[message?'message_body_recorded':'source_recorded']});
 for(const record of evidence.records||[]){
  if(!record?.id||!['note','activity'].includes(record.entity)||!text(record.text))continue;
  add({identity:`crm_${record.entity}:${record.id}`,evidenceClass:record.entity==='note'?'crm_note':'recorded_activity',excerpt:text(record.text),sourceUpdatedAt:record.sourceUpdatedAt,observedAt:record.observedAt,eventTime:null,allowedClaimTypes:[record.entity==='note'?'source_recorded':'task_recorded']});
 }
 for(const activity of evidence.activities||[]){
  if(!activity.id)continue;
  add({identity:`crm_activity:${activity.id}`,evidenceClass:activity.status==='open'?'open_task':'recorded_activity',excerpt:text(`${activity.subject||''} ${activity.note||''}`),taskId:String(activity.id),status:activity.status||'unknown',ownerId:activity.ownerId||null,ownerName:activity.ownerName||null,dueDate:activity.dueDate||null,
   sourceUpdatedAt:activity.sourceUpdatedAt,observedAt:activity.observedAt,eventTime:null,allowedClaimTypes:['task_recorded']});
 }
 for(const item of evidence.messages||[]){
  if(!item.id||!item.provider||!item.account||!item.threadId)continue;
  add({identity:`${item.provider}:${item.account}:${item.id}:${item.threadId}`,evidenceClass:'message_metadata',excerpt:`Recorded ${item.direction==='in'?'incoming':item.direction==='out'?'outgoing':'unknown-direction'} message`,
   sourceUpdatedAt:null,observedAt:item.observedAt,eventTime:item.occurredAt,allowedClaimTypes:['message_recorded']});
 }
 return Object.freeze(references);
}

export const preparationCheckOptions=action=>Object.entries(checks).filter(([,check])=>check.actions.includes(action)).map(([code,check])=>({code,label:check.label,evidenceClasses:check.evidenceClasses}));
export function validSupportProposal(value,action,references){
 if(!exactKeys(value,['schemaVersion','action','support','nextTaskReferenceId','checkCodes','subject','body'])||value.schemaVersion!==1||value.action!==action||!Object.hasOwn(actionLabels,action)||!Array.isArray(references)||!Array.isArray(value.support)||value.support.length<1||value.support.length>3)return false;
 if(!value.support.every(selection=>exactKeys(selection,['referenceId','claimType'])&&typeof selection.referenceId==='string'&&references.find(ref=>ref.id===selection.referenceId)?.allowedClaimTypes.includes(selection.claimType))||new Set(value.support.map(s=>s.referenceId)).size!==value.support.length)return false;
 if(value.nextTaskReferenceId!==null&&(action==='no_action'||typeof value.nextTaskReferenceId!=='string'||references.find(ref=>ref.id===value.nextTaskReferenceId)?.evidenceClass!=='open_task'))return false;
 const selected=new Set([...value.support.map(selection=>selection.referenceId),value.nextTaskReferenceId].filter(Boolean));
 if(!Array.isArray(value.checkCodes)||value.checkCodes.length>5||new Set(value.checkCodes.map(check=>check?.code)).size!==value.checkCodes.length||!value.checkCodes.every(check=>exactKeys(check,['code','referenceId'])&&typeof check.code==='string'&&Object.hasOwn(checks,check.code)&&checks[check.code].actions.includes(action)&&selected.has(check.referenceId)&&checks[check.code].evidenceClasses.includes(references.find(ref=>ref.id===check.referenceId)?.evidenceClass)))return false;
 return value.subject===null&&value.body===null||action==='reply'&&typeof value.subject==='string'&&value.subject.length<=500&&typeof value.body==='string'&&value.body.trim()&&value.body.length<=20000;
}
export function renderPreparationSupport(value,references,current){
 const support=value.support.map(selection=>({...selection,reference:references.find(ref=>ref.id===selection.referenceId)}));
 const quoted=ref=>JSON.stringify(ref.excerpt.slice(0,300))+(ref.excerpt.length>300?' (excerpt shortened)':'');
 const lines=[`${actionLabels[value.action]}. Current lead owner: ${text(current.context.lead.ownerName||current.context.lead.ownerId||'unknown').slice(0,100)}.`];
 for(const {reference:ref} of support){
  if(ref.evidenceClass==='crm_note')lines.push(`Staff note ${ref.identity}; ${ref.sourceUpdatedAt?`Note updated ${ref.sourceUpdatedAt}`:'note update unknown'}: ${quoted(ref)}. Event time and quote delivery are unverified.`);
  else if(ref.evidenceClass==='message_body')lines.push(`Message body ${ref.identity}: ${quoted(ref)}. A recorded message does not verify quote delivery or human authorship.`);
  else if(ref.evidenceClass==='message_metadata')lines.push(`Message metadata ${ref.identity}${ref.eventTime?`; recorded message time ${ref.eventTime}`:''}. Body, meaning, human authorship and delivery are unverified.`);
  else if(ref.evidenceClass==='tracker_record')lines.push(`Tracker recording ${ref.identity}: ${quoted(ref)}. Current bid status and submission need staff verification.`);
  else lines.push(`CRM task recording ${ref.identity}: ${quoted(ref)}. ${ref.status==='recorded_complete'?'Marked complete in CRM; performed work is unverified.':'This recording does not prove performed work.'}`);
 }
 const task=references.find(ref=>ref.id===value.nextTaskReferenceId);
 if(task)lines.push(`Existing open task ${task.taskId}: ${JSON.stringify(task.excerpt.slice(0,180))}; owner ${text(task.ownerName||task.ownerId||'unknown').slice(0,100)}; due ${task.dueDate||'unknown'}. Keep the existing assignment and date.`);
 return {reason:lines.join('\n'),missingFacts:value.checkCodes.map(check=>checks[check.code].label),support,nextTaskReference:task||null};
}
