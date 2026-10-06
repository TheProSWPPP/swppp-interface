import {randomUUID} from 'node:crypto';
import {withLeadLock} from './sdrAccess.js';
import {assertOutreachAllowed} from './sdrOutreachControls.js';

const conflict=(code)=>Object.assign(new Error('Draft creation requires review of the current contact and prior outreach decisions.'),{status:409,code,preserveDraft:true});
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const selection=row=>row?JSON.stringify(stable(Object.fromEntries(['crm_company_id','crm_status','pipedrive_person_id','pipedrive_org_id','person_email','project_stage','trigger_type','trigger_override','safety_context'].map(key=>[key,row[key]??null])))):null;
export function draftCreationOrigin({user,callbackAuthenticated=false}={}) {
 if(callbackAuthenticated===true||user?.sub&&user.machine===true)return 'machine';
 if(user?.sub&&['sdr','admin'].includes(user.role)&&(user.machine===false||user.machine===undefined))return 'interactive';
 return 'unknown';
}
async function readSelection(db,leadId,{lock=false}={}) {return (await db.query(`SELECT * FROM sdr_lead_state WHERE pipedrive_lead_id=$1${lock?' FOR UPDATE':''}`,[String(leadId)])).rows[0]||null;}
function assertScope(row,companyId) {
 if(!companyId)throw conflict('company_scope_unverified');
 if(row?.crm_company_id&&String(row.crm_company_id)!==String(companyId))throw conflict('draft_company_mismatch');
 if(['archived','missing','inaccessible'].includes(row?.crm_status))throw conflict('crm_unavailable');
}
async function assertNoPriorDecision(db,leadId) {
 const existing=await db.query(`SELECT 1 FROM sdr_drafts WHERE pipedrive_lead_id=$1
   UNION ALL SELECT 1 FROM sdr_sends WHERE pipedrive_lead_id=$1 LIMIT 1`,[String(leadId)]);
 if(existing.rows.length)throw conflict('existing_draft_decision_requires_review');
}
export async function prepareDraftCreation(db,{leadId,companyId,recipientEmail=null}) {
 const row=await readSelection(db,leadId);assertScope(row,companyId);
 const ticket={draftId:randomUUID(),leadId:String(leadId),companyId:String(companyId),selection:selection(row)};
 await assertOutreachAllowed(db,{companyId:ticket.companyId,leadId:ticket.leadId,draftId:ticket.draftId,recipientEmail:row?.person_email||recipientEmail,channel:'email',serviceId:null},{action:'generate_draft'});
 await assertNoPriorDecision(db,leadId);
 return ticket;
}

// Generation and other remote checks happen between prepare and commit, with no
// transaction open. Every creation caller serializes here with edit/reject/send.
export async function commitDraftCreation(pool,{ticket,payload,origin='unknown',insert}) {
 return withLeadLock(pool,ticket.leadId,async client=>{
  const row=await readSelection(client,ticket.leadId,{lock:true});assertScope(row,ticket.companyId);
  if(selection(row)!==ticket.selection)throw conflict('draft_context_changed');
  if(String(payload.pipedrive_lead_id)!==ticket.leadId)throw conflict('draft_context_changed');
  for(const [local,snapshot]of [['pipedrive_person_id','contact_id_snapshot'],['pipedrive_org_id','org_id_snapshot'],['person_email','contact_email_snapshot']]) {
   if(row?.[local]!=null&&String(row[local]).trim().toLowerCase()!==String(payload[snapshot]??'').trim().toLowerCase())throw conflict('draft_recipient_context_changed');
  }
  await assertOutreachAllowed(client,{companyId:ticket.companyId,leadId:ticket.leadId,draftId:ticket.draftId,recipientEmail:payload.contact_email_snapshot,channel:'email',serviceId:payload.metadata?.service_id},{action:'generate_draft'});
  await assertNoPriorDecision(client,ticket.leadId);
  return insert(client,{id:ticket.draftId,origin:['machine','interactive'].includes(origin)?origin:'unknown'});
 });
}
