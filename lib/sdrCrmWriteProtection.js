import {createHash} from 'node:crypto';
let configuration=null;
export function configureCrmWriteProtection(value) {configuration=value;}
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
export async function protectCrmWrite({entity,entityId,fields,source='application'}) {
 let proposalId=null;
 if(configuration?.pool&&configuration.companyId) {
  const fingerprint=createHash('sha256').update(JSON.stringify(stable(fields))).digest('hex');
  const {rows}=await configuration.pool.query(`INSERT INTO sdr_crm_proposals(company_id,entity,entity_id,proposed_fields,fingerprint,reason,source)
   VALUES($1,$2,$3,$4,$5,'Existing CRM fields require reviewed correction',$6)
   ON CONFLICT(company_id,entity,entity_id,fingerprint) DO UPDATE SET last_seen_at=NOW(),attempts=sdr_crm_proposals.attempts+1 RETURNING id`,
  [String(configuration.companyId),entity,String(entityId),fields,fingerprint,source]);
  proposalId=rows[0]?.id||null;
 }
 // No provider conditional update has been verified. A read/PATCH/read cycle cannot
 // prevent another person's intervening edit, even for fields we previously wrote.
 throw Object.assign(new Error(proposalId?'CRM change saved for review; existing fields preserved':'CRM change blocked; review storage or company scope is unavailable'),{code:'crm_change_requires_review',status:409,preserveDraft:true,proposalId});
}
