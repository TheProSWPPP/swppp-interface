import {createHash} from 'node:crypto';
import {readMessageBody} from './sdrConversationHistory.js';
import {leadVisibilityScope} from './sdrAccess.js';

const fail=()=>Object.assign(new Error('source_unavailable'),{code:'source_unavailable'});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const bounded=value=>{const text=plain(value);if(!text||text.length>6000)throw fail();return text;};

export async function readExactStagedCrmMatch(pool,{companyId,leadId,viewer,sourceUrl}){
 if(!pool||!companyId||!leadId||!sourceUrl||!viewer?.sub)return {verified:false};
 const scope=leadVisibilityScope(viewer,'visible');
 const rows=(await pool.query(`SELECT source.data->>'source_opportunity_url' AS source_url FROM sdr_lead_state visible
  JOIN sdr_crm_snapshots source ON source.company_id=$1 AND source.entity='lead' AND source.entity_id=visible.pipedrive_lead_id
  WHERE visible.crm_company_id=$1 AND visible.pipedrive_lead_id=$2 AND source.lifecycle='active' AND source.access_status='accessible' AND NOT source.is_test
   AND source.data->>'source_opportunity_url'=$3 AND ${scope.sql('$4')}
   AND NOT EXISTS(SELECT 1 FROM sdr_crm_snapshots other WHERE other.company_id=$1 AND other.entity='lead'
    AND other.entity_id<>source.entity_id AND other.lifecycle='active' AND NOT other.is_test
    AND other.data->>'source_opportunity_url'=$3)`,[companyId,leadId,sourceUrl,...(scope.requires?[scope.value]:[])])).rows;
 return rows.length===1?{verified:true,companyId,leadId,sourceUrl}:{verified:false};
}

export function createStagedInvitationReader({receipt,readExactCrmMatch}){
 if(!receipt||typeof readExactCrmMatch!=='function')throw fail();
 return async({companyId,leadId,viewer,sourceRef})=>{
  const candidates=receipt.candidates?.map(({sourceRef:ignored,...candidate})=>candidate);
  if(!Array.isArray(candidates)||receipt.digest!==digest({revision:receipt.revision,candidates})||sourceRef?.kind!=='staged_invitation'||sourceRef.receiptRevision!==receipt.revision||sourceRef.receiptDigest!==receipt.digest)throw fail();
  const candidate=candidates.find(item=>item.key===sourceRef.key);
  if(!candidate||candidate.conflict||!candidate.sourceUrl||candidate.status==='closed'||candidate.status==='withdrawn'||candidate.status==='submitted'||candidate.match.status!=='exact'||
   candidate.match.companyId!==companyId||candidate.match.leadId!==leadId||candidate.sourceUrl!==sourceRef.sourceUrl||digest(candidate.sourceRows)!==digest(sourceRef.sourceRows))throw fail();
  const actual=await readExactCrmMatch({companyId,leadId,viewer,sourceUrl:candidate.sourceUrl});
  if(actual?.verified!==true||actual.companyId!==companyId||actual.leadId!==leadId||actual.sourceUrl!==candidate.sourceUrl)throw fail();
  return {companyId,leadId,identity:`staged_invitation:${candidate.key}:${receipt.digest}`,linkage:'direct_unique',mailboxAuthorization:'not_applicable',text:bounded(`Tracker invitation. Project: ${candidate.projectTitle}. Bidder: ${candidate.bidder}. Bid date: ${candidate.bidDate||'unknown'}. Proposal deadline: ${candidate.proposalDeadline||'unknown'}. Current bid status: ${candidate.status}.`),provenance:{kind:'staged_invitation',key:candidate.key,sourceUrl:candidate.sourceUrl,sourceRows:candidate.sourceRows,receiptRevision:receipt.revision,receiptDigest:receipt.digest,observedAt:candidate.observedAt}};
 };
}

export async function readAuthorizedSalesSource(pool,{companyId,leadId,viewer,sourceRef,current,resolveVisibleMailboxes,getGmailToken,gmail,pipedrive}){
 if(!pool||!companyId||!leadId||!viewer?.sub||!sourceRef?.id)throw fail();
 if(['crm_note','reviewed_crm_excerpt'].includes(sourceRef.kind)){
  const result=await pool.query(`SELECT s.data,s.source_updated_at FROM sdr_crm_snapshots s
   JOIN sdr_crm_links link ON link.company_id=s.company_id AND link.entity=s.entity AND link.entity_id=s.entity_id
   WHERE s.company_id=$1 AND s.entity='note' AND s.entity_id=$2 AND s.lifecycle='active' AND s.access_status='accessible' AND NOT s.is_test
    AND link.link_type='lead' AND link.linked_id=$3
    AND NOT EXISTS(SELECT 1 FROM sdr_crm_links other WHERE other.company_id=s.company_id AND other.entity=s.entity AND other.entity_id=s.entity_id
      AND (other.link_type='deal' OR other.link_type='lead' AND other.linked_id<>$3))`,[companyId,sourceRef.id,leadId]);
  if(result.rows.length!==1)throw fail();
  const stored=bounded(result.rows[0].data?.content);
  let text=stored,kind='crm_note';
  if(sourceRef.kind==='reviewed_crm_excerpt'){
   if(sourceRef.reviewed!==true||typeof sourceRef.text!=='string'||sourceRef.text.length>2000||!stored.includes(plain(sourceRef.text)))throw fail();
   text=bounded(sourceRef.text);kind='reviewed_crm_excerpt';
  }
  return {companyId,leadId,identity:`crm_note:${sourceRef.id}`,linkage:'direct_unique',mailboxAuthorization:'not_applicable',text,provenance:{kind,id:sourceRef.id,sourceUpdatedAt:result.rows[0].source_updated_at,reviewedBy:kind==='reviewed_crm_excerpt'?viewer.sub:null}};
 }
 if(!['gmail_message','pipedrive_message'].includes(sourceRef.kind))throw fail();
 const provider=sourceRef.kind==='gmail_message'?'gmail':'pipedrive',account=String(sourceRef.account||'').trim().toLowerCase();
 if(sourceRef.provider!==provider||!account||!sourceRef.threadId)throw fail();
 const sourceSql=`SELECT provider_thread_id,person_id,pipedrive_lead_id,pipedrive_deal_id,link_evidence,source_evidence
  FROM sdr_conversation_messages WHERE provider=$1 AND account_key=$2 AND provider_message_id=$3`;
 const sourceArgs=[provider,account,sourceRef.id];
 const rows=(await pool.query(sourceSql,sourceArgs)).rows;
 const row=rows[0];
 if(rows.length!==1||!row||row.provider_thread_id!==sourceRef.threadId||row.pipedrive_lead_id!==leadId||row.person_id!==current.context.lead.personId||row.pipedrive_deal_id||
  !['pipedrive:lead_id','pipedrive:explicit-thread-or-message-id'].includes(row.link_evidence)||!Array.isArray(row.source_evidence)||
  !row.source_evidence.some(e=>String(e?.leadId)===leadId)||row.source_evidence.some(e=>e?.leadId&&String(e.leadId)!==leadId||e?.dealId))throw fail();
 const visible=provider==='gmail'?(await resolveVisibleMailboxes(viewer)).map(value=>String(value.email||value).toLowerCase()):[];
 if(provider==='gmail'&&!visible.includes(account)||provider==='pipedrive'&&viewer.role!=='admin')throw fail();
 const body=await readMessageBody(pool,{provider,account,id:sourceRef.id,visibleAccounts:visible,includePipedrive:viewer.role==='admin',getGmailToken,gmail,pipedrive});
 const latest=(await pool.query(sourceSql,sourceArgs)).rows;
 if(latest.length!==1||JSON.stringify(latest[0])!==JSON.stringify(row)||provider==='gmail'&&!(await resolveVisibleMailboxes(viewer)).map(value=>String(value.email||value).toLowerCase()).includes(account))throw fail();
 return {companyId,leadId,identity:`${provider}:${account}:${sourceRef.id}:${sourceRef.threadId}`,linkage:'direct_unique',mailboxAuthorization:provider==='gmail'?'visible':'admin',text:bounded(body.body),provenance:{kind:'provider_message',provider,account,messageId:sourceRef.id,threadId:sourceRef.threadId}};
}
