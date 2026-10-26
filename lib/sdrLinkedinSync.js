import {timingSafeEqual} from 'node:crypto';
import {linkedinHash,withLinkedinPersonLock} from './sdrLinkedinStore.js';
const fail=code=>Object.assign(new Error(code),{code});
// Unipile v1 status messages that do not signal a problem with the account.
const benignStatuses=new Set(['OK','SYNC_SUCCESS','RECONNECTED','CREATION_SUCCESS']);
export const linkedinStatusHealthy=status=>benignStatuses.has(String(status||'').toUpperCase());
// Messages and relations from people who are not candidates are recorded, retried
// briefly in case a candidate is still being resolved, then closed without account state.
const NON_CANDIDATE_ATTEMPTS=3;
export function verifyLinkedinWebhook({headers,secret}){const supplied=headers?.['unipile-auth']||headers?.['Unipile-Auth'];if(typeof supplied!=='string'||!secret)return false;const a=Buffer.from(supplied),b=Buffer.from(secret);return a.length===b.length&&timingSafeEqual(a,b)}
// Unipile v1 shapes: messaging {event:'message_received',message_id,chat_id,message:'text',sender:{attendee_provider_id},account_info:{user_id}},
// users {event:'new_relation',user_provider_id,...}, account status {AccountStatus:{account_id,message}}.
export function normalizeLinkedinPayload(payload){
 const status=payload.AccountStatus&&typeof payload.AccountStatus==='object'?payload.AccountStatus:null;
 const source=status||payload;
 const account=typeof source.account_id==='string'?source.account_id:source.account_id?.id||source.account?.id;
 const kind=status?'account_status':payload.event||payload.type;
 const message=payload.message&&typeof payload.message==='object'?payload.message:{};
 const messageId=kind==='message_received'?message.id||payload.message_id||null:null;
 const providerId=kind==='new_relation'?payload.user_provider_id||payload.user?.provider_id||payload.provider_id||null:payload.sender?.attendee_provider_id||payload.provider_id||null;
 const text=typeof payload.message==='string'?payload.message:typeof message.text==='string'?message.text:null;
 return {kind,account,messageId,providerId,chatId:message.chat_id||payload.chat_id||null,status:kind==='account_status'?status?.message||payload.status||null:null,self:payload.account_info?.user_id,sender:payload.sender?.attendee_provider_id,text};
}
// A message matching several of our candidates holds each of them, never the account.
async function holdLinkedinCandidates(pool,{companyId,accountId,candidates,reason}){
 for(const row of candidates){
  const hold=async db=>{await db.query(`UPDATE sdr_linkedin_candidates SET state='held',hold_reason=$2,revision=revision+1 WHERE id=$1 AND state NOT IN ('held','replied','opted_out','archived')`,[row.id,reason]);if(row.person_id)await db.query(`UPDATE sdr_linkedin_actions SET state='cancelled' WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND state='pending'`,[companyId,accountId,row.person_id])};
  if(row.person_id)await withLinkedinPersonLock(pool,{companyId,accountId,personId:row.person_id},hold);else await hold(pool);
 }
}
export async function ingestLinkedinEvent(db,{companyId,boundAccountId,payload,receivedAt=new Date()}){
 if(!companyId||!boundAccountId||!payload||typeof payload!=='object'||Array.isArray(payload))throw fail('invalid_event');
 const view=normalizeLinkedinPayload(payload),{kind,account,providerId,chatId}=view;
 if(account!==boundAccountId)throw fail('account_mismatch');
 if(!['message_received','new_relation','account_status'].includes(kind))throw fail('unknown_event');
 const sourceMessageId=view.messageId,self=view.self,sender=view.sender;
 const boundSelf=kind==='message_received'?(await db.query('SELECT sender_provider_id FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2',[companyId,boundAccountId])).rows[0]?.sender_provider_id:null;
 const direction=kind==='message_received'?(boundSelf&&self===boundSelf&&sender?boundSelf===sender?'out':'in':'unknown'):null;
 const safe={event:kind,account_id:account,provider_id:providerId,message_id:sourceMessageId,chat_id:chatId,status:view.status};
 const hash=linkedinHash({account,kind,id:sourceMessageId||payload.id||null,providerId,time:payload.timestamp||null,bodyHash:linkedinHash(payload)});
 let candidate=null;
 if(kind==='message_received'){
  const matches=(await db.query(`SELECT c.* FROM sdr_linkedin_candidates c WHERE c.company_id=$1 AND c.account_id=$2 AND c.state<>'archived' AND (c.provider_id=$3 OR EXISTS(SELECT 1 FROM sdr_linkedin_actions a WHERE a.candidate_id=c.id AND a.provider_chat_id=$4)) LIMIT 10`,[companyId,boundAccountId,providerId,chatId])).rows;
  if(matches.length===1&&matches[0].person_id)candidate=matches[0];
  else if(matches.length)await holdLinkedinCandidates(db,{companyId,accountId:boundAccountId,candidates:matches,reason:matches.length>1?'ambiguous_linkedin_match':'linkedin_message_unverified'});
 }
 const persist=async client=>{
  const {rows}=await client.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,source_event_id,source_message_id,provider_id,chat_id,direction,source_at,observed_at,coverage,payload_hash,safe_payload) VALUES($1,$2,$3,$4,$5,'webhook',$6,$7,$8,$9,$10,$11,$12,'event',$13,$14) ON CONFLICT DO NOTHING RETURNING *`,[companyId,boundAccountId,candidate?.id||null,candidate?.person_id||null,kind,payload.id||null,sourceMessageId,providerId,chatId,direction,payload.timestamp||null,receivedAt,hash,JSON.stringify(safe)]);
  let event=rows[0]||(await client.query(`SELECT * FROM sdr_linkedin_events WHERE company_id=$1 AND account_id=$2 AND (payload_hash=$3 OR ($4::text IS NOT NULL AND source_message_id=$4)) LIMIT 1`,[companyId,boundAccountId,hash,sourceMessageId])).rows[0];
  if(candidate&&event&&!event.person_id)event=(await client.query(`UPDATE sdr_linkedin_events SET candidate_id=$2,person_id=$3 WHERE id=$1 AND person_id IS NULL RETURNING *`,[event.id,candidate.id,candidate.person_id])).rows[0]||event;
  if(candidate&&event?.person_id!==candidate.person_id)throw fail('event_identity_conflict');
  return event;
 };
 // The mapped observation is committed before waiting on the dispatcher's
 // person lock. A final send fence can then see it during asynchronous reads.
 const event=await persist(db);
 if(kind==='account_status'&&!linkedinStatusHealthy(safe.status)&&String(safe.status||'').toUpperCase()!=='CONNECTING')await db.query("UPDATE sdr_linkedin_accounts SET status='restricted',status_observed_at=$3 WHERE company_id=$1 AND account_id=$2",[companyId,boundAccountId,receivedAt]);
 if(candidate&&direction!=='out')await withLinkedinPersonLock(db,{companyId,accountId:boundAccountId,personId:candidate.person_id},async client=>{
  const current=(await client.query('SELECT person_id,provider_id FROM sdr_linkedin_candidates WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];
  if(!current||current.person_id!==candidate.person_id||current.provider_id!==candidate.provider_id){await client.query(`UPDATE sdr_linkedin_candidates SET state='held',hold_reason='linkedin_identity_changed',revision=revision+1 WHERE id=$1 AND state NOT IN ('held','replied','opted_out','archived')`,[candidate.id]);return}
  await client.query(`UPDATE sdr_linkedin_candidates SET state='held',hold_reason=$2,revision=revision+1 WHERE id=$1 AND state NOT IN ('held','replied','opted_out','archived')`,[candidate.id,direction==='in'?'linkedin_inbound':'unknown_direction']);
  await client.query(`UPDATE sdr_linkedin_actions SET state='cancelled' WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND state='pending'`,[companyId,boundAccountId,candidate.person_id]);
 });
 return event;
}
export async function processLinkedinEvents({pool,companyId,accountId,limit=20,onInbound}){
 let processed=0,unresolved=0,ignored=0;
 const events=(await pool.query(`SELECT * FROM sdr_linkedin_events WHERE company_id=$1 AND account_id=$2 AND processed_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY CASE WHEN kind='account_status' THEN 0 WHEN kind='message_received' AND direction IN ('in','unknown') THEN 1 ELSE 2 END,observed_at,id LIMIT $3`,[companyId,accountId,Math.max(1,Math.min(limit,100))])).rows;
 const close=async(event,resolution)=>{await pool.query(`UPDATE sdr_linkedin_events SET processed_at=now(),next_attempt_at=NULL,safe_payload=safe_payload||$2::jsonb WHERE id=$1`,[event.id,JSON.stringify({resolution})])};
 const defer=async event=>{unresolved++;const delay=Math.min(1440,5*Math.pow(2,Math.min(event.attempt_count||0,8)));await pool.query(`UPDATE sdr_linkedin_events SET attempt_count=attempt_count+1,next_attempt_at=now()+($2::int*interval '1 minute') WHERE id=$1`,[event.id,delay])};
 for(const event of events){
  if(event.kind==='account_status'){
   // A healthy status never clears a restriction or a review hold; re-registering the account does.
   const raw=String(event.safe_payload?.status||'').toUpperCase(),status=linkedinStatusHealthy(raw)?'healthy':'restricted';
   if(raw!=='CONNECTING')await pool.query("UPDATE sdr_linkedin_accounts SET status=CASE WHEN $3='healthy' AND status IN ('restricted','needs_review','unverified') THEN status ELSE $3 END,status_observed_at=$4 WHERE company_id=$1 AND account_id=$2",[companyId,accountId,status,event.observed_at]);
   await pool.query('UPDATE sdr_linkedin_events SET processed_at=now() WHERE id=$1',[event.id]);processed++;continue;
  }
  const candidates=(await pool.query(`SELECT DISTINCT c.* FROM sdr_linkedin_candidates c LEFT JOIN sdr_linkedin_actions a ON a.candidate_id=c.id WHERE c.company_id=$1 AND c.account_id=$2 AND c.state<>'archived' AND (c.id=$3 OR c.provider_id=$4 OR ($5::text IS NOT NULL AND a.provider_chat_id=$5)) LIMIT 10`,[companyId,accountId,event.candidate_id,event.provider_id,event.chat_id])).rows;
  const candidate=candidates.length===1?candidates[0]:null;
  if(!candidates.length){if((event.attempt_count||0)+1>=NON_CANDIDATE_ATTEMPTS){await close(event,'not_candidate');ignored++}else await defer(event);continue}
  if(!candidate?.person_id){if(event.kind==='message_received')await holdLinkedinCandidates(pool,{companyId,accountId,candidates,reason:candidates.length>1?'ambiguous_linkedin_match':'linkedin_message_unverified'});await close(event,candidates.length>1?'ambiguous_candidates':'candidate_unresolved');processed++;continue}
  let pendingOwnEcho=false,identityConflict=false;
  await withLinkedinPersonLock(pool,{companyId,accountId,personId:candidate.person_id},async db=>{
   const linked=await db.query(`UPDATE sdr_linkedin_events SET candidate_id=$2,person_id=$3 WHERE id=$1 AND (candidate_id IS NULL OR candidate_id=$2) AND (person_id IS NULL OR person_id=$3) RETURNING id`,[event.id,candidate.id,candidate.person_id]);
   if(linked.rowCount!==1){identityConflict=true;return}
   if(event.kind==='message_received'&&event.direction!=='out'){
    await db.query(`UPDATE sdr_linkedin_candidates SET state='held',hold_reason=$2,revision=revision+1 WHERE id=$1 AND state NOT IN ('held','replied','opted_out','archived')`,[candidate.id,event.direction==='in'?'linkedin_inbound':'unknown_direction']);
    await db.query(`UPDATE sdr_linkedin_actions SET state='cancelled' WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND state='pending'`,[companyId,accountId,candidate.person_id]);
   }else if(event.kind==='message_received'&&event.direction==='out'){
    const own=(await db.query(`SELECT 1 FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND provider_id=$4 AND state='confirmed' LIMIT 1`,[companyId,accountId,candidate.person_id,event.source_message_id])).rows.length>0;
    if(!own){const inFlight=(await db.query(`SELECT 1 FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND state IN ('reserved','network_started','uncertain_provider_result') AND (provider_chat_id=$4 OR $4::text IS NULL) LIMIT 1`,[companyId,accountId,candidate.person_id,event.chat_id])).rows.length>0;if(inFlight)pendingOwnEcho=true;else await db.query(`UPDATE sdr_linkedin_candidates SET state='staff_takeover',revision=revision+1 WHERE id=$1 AND state NOT IN ('replied','opted_out','archived')`,[candidate.id])}
   }else if(event.kind==='new_relation')await db.query(`UPDATE sdr_linkedin_candidates SET state='relation_observed',revision=revision+1 WHERE id=$1 AND state IN ('invite_sent','reviewed','invite_due')`,[candidate.id]);
  });
  if(identityConflict){await holdLinkedinCandidates(pool,{companyId,accountId,candidates:[candidate],reason:'linkedin_identity_changed'});await close(event,'identity_conflict');processed++;continue}
  if(pendingOwnEcho){await defer(event);continue}
  if(event.kind==='message_received'&&event.direction==='in'&&onInbound){try{await onInbound({candidate,event})}catch{await defer(event);continue}}
  await pool.query('UPDATE sdr_linkedin_events SET candidate_id=$2,person_id=$3,processed_at=now(),next_attempt_at=NULL WHERE id=$1',[event.id,candidate.id,candidate.person_id]);processed++;
 }
 return {processed,unresolved,ignored,coverage:unresolved?'partial':'complete'};
}
export async function reconcileLinkedinAccount({pool,client,companyId,accountId,budget=2,maxChecks=5,now=new Date()}){
 if(budget<2)return {coverage:'partial',reason:'budget_exhausted'};
 const db=await pool.connect();
 try{await db.query('BEGIN');const account=(await db.query('SELECT * FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2 FOR UPDATE',[companyId,accountId])).rows[0];
  if(!account||account.mode==='disabled'||account.status!=='healthy'||account.read_budget<2||!account.read_timezone){await db.query('COMMIT');return {coverage:'partial',reason:'account_unavailable'}}
  const next=account.coverage?.nextRecoveryAt;
  if(next&&new Date(next)>now){await db.query('COMMIT');return {coverage:'partial',reason:'read_throttled',acceptedCount:0,heldCount:0}}
  const jitterMinutes=parseInt(linkedinHash(`${companyId}:${accountId}:${now.toISOString().slice(0,10)}`).slice(0,4),16)%121;
  await db.query(`UPDATE sdr_linkedin_accounts SET coverage=coverage||$3::jsonb WHERE company_id=$1 AND account_id=$2`,[companyId,accountId,JSON.stringify({lastRecoveryAttempt:now.toISOString(),nextRecoveryAt:new Date(now.getTime()+(24*60+jitterMinutes)*60_000).toISOString(),pendingComplete:false,relationsComplete:false})]);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}finally{db.release()}
 // Acceptance backstop for a missed new_relation webhook: one targeted profile read per
 // outstanding own invite, oldest first. Listing every relation of a personal profile is
 // unbounded; the profile's is_relationship answers for exactly this person.
 const outstanding=(await pool.query(`SELECT c.* FROM sdr_linkedin_candidates c JOIN sdr_linkedin_actions a ON a.candidate_id=c.id AND a.step='invite' AND a.state IN ('confirmed','uncertain_provider_result')
  WHERE c.company_id=$1 AND c.account_id=$2 AND c.provider_id IS NOT NULL AND c.person_id IS NOT NULL AND c.state NOT IN ('archived','opted_out','completed_no_reply','held','replied','staff_takeover')
  AND NOT EXISTS (SELECT 1 FROM sdr_linkedin_events e WHERE e.company_id=c.company_id AND e.account_id=c.account_id AND e.person_id=c.person_id AND e.kind='new_relation')
  ORDER BY COALESCE(a.confirmed_at,a.network_started_at,a.created_at) LIMIT $3`,[companyId,accountId,Math.max(1,Math.min(maxChecks,20))])).rows;
 let acceptedCount=0,checked=0,partial=false;
 for(const candidate of outstanding){
  let profile;try{profile=await client.getProfile({identifier:candidate.provider_id})}catch{partial=true;break}
  checked++;
  if(String(profile?.provider_id||'')!==candidate.provider_id||typeof profile?.is_relationship!=='boolean'){partial=true;continue}
  if(!profile.is_relationship)continue;
  const hash=linkedinHash({companyId,accountId,kind:'new_relation',providerId:candidate.provider_id});
  const result=await pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,provider_id,observed_at,coverage,payload_hash,safe_payload)
   VALUES($1,$2,$3,$4,'new_relation','poll',$5,$6,'poll',$7,$8) ON CONFLICT DO NOTHING RETURNING id`,[companyId,accountId,candidate.id,candidate.person_id,candidate.provider_id,now,hash,JSON.stringify({provider_id:candidate.provider_id,acceptance_day:'unknown'})]);
  acceptedCount+=result.rowCount;
 }
 if(partial)return {coverage:'partial',reason:'provider_read_failed',checked,acceptedCount,heldCount:0};
 await pool.query(`UPDATE sdr_linkedin_accounts SET coverage=coverage||$3::jsonb WHERE company_id=$1 AND account_id=$2`,[companyId,accountId,JSON.stringify({lastRecoveryRead:now.toISOString(),pendingComplete:true,relationsComplete:true})]);
 return {coverage:'complete',checked,acceptedCount,heldCount:0};
}
