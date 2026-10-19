import {linkedinHash} from './sdrLinkedinStore.js';
const fail=code=>Object.assign(new Error(code),{code});
const visible=(row,viewer)=>viewer&&!viewer.machine&&['admin','sdr'].includes(viewer.role)&&viewer.sub&&(viewer.role==='admin'||row.current_owner_id===viewer.sub||row.author_id===viewer.sub);
export async function readLinkedinDraft(db,{candidateId,viewer,companyId,accountId}){if(!viewer||viewer.machine)return null;const params=[candidateId];let sql='SELECT d.*,c.owner_id AS current_owner_id FROM sdr_linkedin_drafts d JOIN sdr_linkedin_candidates c ON c.id=d.candidate_id AND c.company_id=d.company_id AND c.account_id=d.account_id WHERE d.candidate_id=$1';if(companyId){params.push(companyId);sql+=` AND d.company_id=$${params.length}`}if(accountId){params.push(accountId);sql+=` AND d.account_id=$${params.length}`}const row=(await db.query(`${sql} ORDER BY d.created_at DESC LIMIT 1`,params)).rows[0];return row&&visible(row,viewer)?row:null}
export async function saveLinkedinDraft(db,{draftId,expectedRevision,contextHash,body,viewer,companyId,accountId}){if(typeof body!=='string'||!body.trim()||body.length>10000)throw fail('invalid_draft');const client=db.connect?await db.connect():db;try{await client.query('BEGIN');const row=(await client.query(`SELECT d.*,c.owner_id AS current_owner_id FROM sdr_linkedin_drafts d JOIN sdr_linkedin_candidates c ON c.id=d.candidate_id AND c.company_id=d.company_id AND c.account_id=d.account_id WHERE d.id=$1 FOR UPDATE OF d,c`,[draftId])).rows[0];if(!row||companyId&&row.company_id!==companyId||accountId&&row.account_id!==accountId||!visible(row,viewer))throw fail('draft_unavailable');if(['network_started','uncertain_provider_result'].includes(row.handoff_receipt?.outcome))throw fail('publication_in_progress');if(row.revision!==expectedRevision)throw fail('revision_conflict');if(row.context_hash!==contextHash)throw fail('context_changed');const updated=(await client.query(`UPDATE sdr_linkedin_drafts SET body=$2,author_id=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,[draftId,body.trim(),viewer.sub])).rows[0];await client.query('COMMIT');return updated}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{if(client!==db)client.release()}}
export function previewLinkedinHandoff({draft,conversationUrl,reviewed=false}={}){if(!draft||!reviewed||!/^https:\/\/www\.linkedin\.com\/messaging\//.test(conversationUrl||''))return {available:false,reason:'conversation_link_unverified'};return {available:true,draftId:draft.id,revision:draft.revision,contextHash:draft.context_hash,previewToken:linkedinHash({id:draft.id,revision:draft.revision,contextHash:draft.context_hash,conversationUrl}),conversationUrl,body:draft.body}}
const unresolved=intent=>({outcome:'unresolved',operationKey:intent?.operationKey||null,publishedRevision:intent?.publishedRevision||null});
async function handoffTransaction(pool,scope,work){
 const {draftId,companyId,accountId,viewer}=scope;
 if(!companyId||!accountId)throw fail('handoff_scope_required');
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const draft=(await db.query(`SELECT d.*,c.owner_id AS current_owner_id FROM sdr_linkedin_drafts d JOIN sdr_linkedin_candidates c ON c.id=d.candidate_id AND c.company_id=d.company_id AND c.account_id=d.account_id WHERE d.id=$1 AND d.company_id=$2 AND d.account_id=$3 FOR UPDATE OF d,c`,[draftId,companyId,accountId])).rows[0];
  if(!draft||!visible(draft,viewer))throw fail('draft_unavailable');
  const result=await work(db,draft);await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}finally{db.release()}
}
export async function publishLinkedinHandoff({enabled=false,pool,client,draftId,companyId,accountId,viewer,expectedRevision,contextHash,previewToken,conversationUrl,reviewed=false}={}){
 if(!enabled)throw fail('publication_disabled');
 if(!pool||typeof client?.publish!=='function')throw fail('publication_unavailable');
 const claimed=await handoffTransaction(pool,{draftId,companyId,accountId,viewer},async(db,draft)=>{
  if(draft.revision!==expectedRevision||draft.context_hash!==contextHash)throw fail('context_changed');
  const preview=previewLinkedinHandoff({draft,conversationUrl,reviewed});
  if(!preview.available||preview.previewToken!==previewToken)throw fail('preview_required');
  if(draft.handoff_receipt)return {prior:draft.handoff_receipt,changedPreview:draft.handoff_receipt.previewToken!==previewToken};
  const intent={outcome:'network_started',operationKey:linkedinHash({draftId,companyId,accountId,previewToken}),publishedRevision:draft.revision,contextHash:draft.context_hash,previewToken,conversationUrl,startedAt:new Date().toISOString(),actor:viewer.sub};
  await db.query('UPDATE sdr_linkedin_drafts SET handoff_receipt=$2 WHERE id=$1',[draftId,JSON.stringify(intent)]);
  return {draft,intent};
 });
 if(claimed.prior)return claimed.prior.outcome==='confirmed'?(claimed.changedPreview?{...claimed.prior,outcome:'already_published'}:claimed.prior):unresolved(claimed.prior);
 // The durable claim is committed before the single external boundary. An
 // interrupted/unknown result is never cleared or retried by another caller.
 const {draft,intent}=claimed;let result;
 try{result=await client.publish({draft,conversationUrl,viewer,operationKey:intent.operationKey})}catch{result={outcome:'unknown'}}
 const providerId=result?.providerId||result?.id;
 const confirmed=result?.outcome==='confirmed'&&typeof providerId==='string'&&providerId.length>0;
 const receipt={...intent,outcome:confirmed?'confirmed':'uncertain_provider_result',...(confirmed?{providerId}:{}),finishedAt:new Date().toISOString()};
 await pool.query(`UPDATE sdr_linkedin_drafts SET handoff_receipt=$2 WHERE id=$1 AND handoff_receipt->>'operationKey'=$3 AND handoff_receipt->>'outcome'='network_started'`,[draftId,JSON.stringify(receipt),intent.operationKey]);
 return confirmed?receipt:unresolved(receipt);
}
export async function reconcileLinkedinHandoff({pool,client,draftId,companyId,accountId,viewer}={}){
 const scope={draftId,companyId,accountId,viewer};
 const draft=await handoffTransaction(pool,scope,async(_db,row)=>row);
 const intent=draft.handoff_receipt;
 if(intent?.outcome==='confirmed')return intent;
 if(!intent?.operationKey||typeof client?.readReceipt!=='function')return unresolved(intent);
 let result;try{result=await client.readReceipt({draft,intent})}catch{return unresolved(intent)}
 // A matching text or guessed note is not evidence. The publication adapter
 // must prove the exact durable operation marker from the provider record.
 if(result?.outcome!=='confirmed'||result.matchedBy!=='operation_key'||result.operationKey!==intent.operationKey||typeof result.providerId!=='string'||!result.providerId)return unresolved(intent);
 return handoffTransaction(pool,scope,async(db,current)=>{
  if(current.handoff_receipt?.outcome==='confirmed')return current.handoff_receipt;
  if(current.handoff_receipt?.operationKey!==intent.operationKey)return unresolved(current.handoff_receipt);
  const receipt={...intent,outcome:'confirmed',providerId:result.providerId,reconciledAt:new Date().toISOString()};
  await db.query('UPDATE sdr_linkedin_drafts SET handoff_receipt=$2 WHERE id=$1',[draftId,JSON.stringify(receipt)]);return receipt;
 });
}
