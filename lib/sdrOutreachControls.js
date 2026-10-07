import { withLeadLock } from './sdrAccess.js';

const id=v=>v==null?null:String(v);
const error=(code,status=409)=>Object.assign(new Error(code),{code,status,preserveDraft:true});
const kinds=new Set(['draft','service','lead','recipient','channel']);
export function controlApplies(c,context) {
  if(c.status!=='active'||id(c.company_id)!==id(context.companyId))return false;
  if(c.lead_id&&id(c.lead_id)!==id(context.leadId))return false;
  if(c.channel&&context.channel&&c.channel!==context.channel)return false;
  const value={draft:context.draftId,service:context.serviceId,lead:context.leadId,
    recipient:context.recipientEmail?.trim().toLowerCase(),channel:context.channel}[c.scope_kind];
  // Incomplete context cannot establish that a restriction does not apply.
  return value==null||String(value)===c.scope_id;
}
export async function getOutreachControls(db,context) {
  if(!context.companyId||!context.leadId)throw error('outreach_context_incomplete');
  const {rows}=await db.query("SELECT * FROM sdr_outreach_controls WHERE company_id=$1 AND status='active' AND (lead_id IS NULL OR lead_id=$2) ORDER BY created_at,id",[String(context.companyId),String(context.leadId)]);
  return rows.filter(c=>controlApplies(c,context));
}
export function controlSummary(controls) {
  return {controls,applicationActionsBlocked:controls.length>0,
    providerStopStatus:controls.length&&controls.every(c=>c.provider_stop_status==='confirmed')?'confirmed':
      controls.some(c=>c.provider_stop_status==='unresolved')?'unresolved':'unverified'};
}
export async function assertOutreachAllowed(db,context,{action='enroll'}={}) {
  const controls=await getOutreachControls(db,context);
  if(controls.length)throw Object.assign(error('outreach_held'),{action,controls:controls.map(c=>({id:c.id,reason:c.reason,version:c.version}))});
  return {allowed:true};
}
async function transaction(db,leadId,fn) {
  if(typeof db.release==='function')return fn(db);
  if(typeof db.connect==='function')return withLeadLock(db,leadId||'outreach-global-controls',fn);
  return fn(db); // Caller-owned transaction and lock.
}
export async function setOutreachControl(db,{companyId,leadId,scope,channel=null,reason,contextHash,actor}) {
  if(!companyId||!kinds.has(scope?.kind)||!scope?.id||!reason?.trim()||!contextHash||!actor?.accountId)throw error('invalid_outreach_control',400);
  if(['draft','service','lead'].includes(scope.kind)&&!leadId)throw error('control_project_required',400);
  if(scope.kind==='lead'&&id(scope.id)!==id(leadId))throw error('control_scope_mismatch',400);
  const scopeId=scope.kind==='recipient'?String(scope.id).trim().toLowerCase():String(scope.id);
  return transaction(db,leadId,async client=>{
    const {rows}=await client.query(`INSERT INTO sdr_outreach_controls(company_id,lead_id,scope_kind,scope_id,channel,reason,context_hash,actor,owner_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[String(companyId),id(leadId),scope.kind,scopeId,channel,reason.trim(),contextHash,actor,String(actor.accountId)]);
    await client.query(`INSERT INTO sdr_outreach_control_decisions(control_id,version,decision,evidence,context_hash,actor) VALUES($1,1,'hold',$2,$3,$4)`,[rows[0].id,reason.trim(),contextHash,actor]);
    return rows[0];
  });
}
export async function resolveOutreachControl(db,{id:controlId,companyId,expectedVersion,decision,evidence,actor,contextHash,expectedContextHash=contextHash}) {
  if(!actor?.accountId||!evidence?.trim()||!['release','keep_held','keep_contact_with_verified_role','review_replacement'].includes(decision))throw error('invalid_control_decision',400);
  const current=(await db.query('SELECT * FROM sdr_outreach_controls WHERE id=$1 AND company_id=$2',[controlId,String(companyId)])).rows[0];
  if(!current)throw error('control_not_found',404);
  return transaction(db,current.lead_id,async client=>{
    const {rows}=await client.query(`UPDATE sdr_outreach_controls SET status=$4,version=version+1,context_hash=$6,updated_at=NOW()
      WHERE id=$1 AND company_id=$2 AND version=$3 AND context_hash=$5 AND status='active' RETURNING *`,
    [controlId,String(companyId),expectedVersion,decision==='release'?'released':'active',expectedContextHash,contextHash]);
    if(!rows.length)throw error('control_conflict');
    await client.query(`INSERT INTO sdr_outreach_control_decisions(control_id,version,decision,evidence,context_hash,actor) VALUES($1,$2,$3,$4,$5,$6)`,[controlId,rows[0].version,decision,evidence.trim(),contextHash,actor]);
    return {resolved:decision==='release',control:rows[0]};
  });
}
