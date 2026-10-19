import {timingSafeEqual} from 'node:crypto';
import {linkedinHash,withLinkedinPersonLock} from './sdrLinkedinStore.js';
const fail=code=>Object.assign(new Error(code),{code});
export function verifyLinkedinWebhook({headers,secret}){const supplied=headers?.['unipile-auth']||headers?.['Unipile-Auth'];if(typeof supplied!=='string'||!secret)return false;const a=Buffer.from(supplied),b=Buffer.from(secret);return a.length===b.length&&timingSafeEqual(a,b)}
export async function ingestLinkedinEvent(db,{companyId,boundAccountId,payload,receivedAt=new Date()}){
 if(!companyId||!boundAccountId||!payload||typeof payload!=='object'||Array.isArray(payload))throw fail('invalid_event');
 const account=typeof payload.account_id==='string'?payload.account_id:payload.account_id?.id||payload.account?.id;
 if(account!==boundAccountId)throw fail('account_mismatch');
 const kind=payload.event||payload.type;if(!['message_received','new_relation','account_status'].includes(kind))throw fail('unknown_event');
 const message=payload.message||payload,sourceMessageId=kind==='message_received'?message.id||payload.message_id:null;
 const self=payload.account_info?.user_id,sender=payload.sender?.attendee_provider_id;
 const boundSelf=kind==='message_received'?(await db.query('SELECT sender_provider_id FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2',[companyId,boundAccountId])).rows[0]?.sender_provider_id:null;
 const direction=kind==='message_received'?(boundSelf&&self===boundSelf&&sender?boundSelf===sender?'out':'in':'unknown'):null;
 const providerId=payload.user?.provider_id||payload.provider_id||payload.sender?.attendee_provider_id||null;
 const chatId=message.chat_id||payload.chat_id||null;
 const safe={event:kind,account_id:account,provider_id:providerId,message_id:sourceMessageId,chat_id:chatId,status:kind==='account_status'?payload.status||null:null};
 const hash=linkedinHash({account,kind,id:sourceMessageId||payload.id||null,providerId,time:payload.timestamp||null,bodyHash:linkedinHash(payload)});
 let candidate=null;
 if(kind==='message_received'){
  const matches=(await db.query(`SELECT c.* FROM sdr_linkedin_candidates c WHERE c.company_id=$1 AND c.account_id=$2 AND c.state<>'archived' AND (c.provider_id=$3 OR EXISTS(SELECT 1 FROM sdr_linkedin_actions a WHERE a.candidate_id=c.id AND a.provider_chat_id=$4)) LIMIT 2`,[companyId,boundAccountId,providerId,chatId])).rows;
  if(matches.length===1&&matches[0].person_id)candidate=matches[0];
  else await db.query("UPDATE sdr_linkedin_accounts SET status='needs_review',status_observed_at=$3 WHERE company_id=$1 AND account_id=$2 AND status NOT IN ('restricted','disconnected')",[companyId,boundAccountId,receivedAt]);
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
 if(kind==='account_status'&&safe.status!=='OK')await db.query("UPDATE sdr_linkedin_accounts SET status='restricted',status_observed_at=$3 WHERE company_id=$1 AND account_id=$2",[companyId,boundAccountId,receivedAt]);
 if(candidate&&direction!=='out')await withLinkedinPersonLock(db,{companyId,accountId:boundAccountId,personId:candidate.person_id},async client=>{
  const current=(await client.query('SELECT person_id,provider_id FROM sdr_linkedin_candidates WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];
  if(!current||current.person_id!==candidate.person_id||current.provider_id!==candidate.provider_id){await client.query("UPDATE sdr_linkedin_accounts SET status='needs_review',status_observed_at=$3 WHERE company_id=$1 AND account_id=$2 AND status NOT IN ('restricted','disconnected')",[companyId,boundAccountId,receivedAt]);return}
  await client.query(`UPDATE sdr_linkedin_candidates SET state='held',hold_reason=$2,revision=revision+1 WHERE id=$1 AND state NOT IN ('held','replied','opted_out','archived')`,[candidate.id,direction==='in'?'linkedin_inbound':'unknown_direction']);
  await client.query(`UPDATE sdr_linkedin_actions SET state='cancelled' WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND state='pending'`,[companyId,boundAccountId,candidate.person_id]);
 });
 return event;
}
export async function processLinkedinEvents({pool,companyId,accountId,limit=20,onInbound}){
 let processed=0,unresolved=0;
 const events=(await pool.query(`SELECT * FROM sdr_linkedin_events WHERE company_id=$1 AND account_id=$2 AND processed_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY CASE WHEN kind='account_status' THEN 0 WHEN kind='message_received' AND direction IN ('in','unknown') THEN 1 ELSE 2 END,observed_at,id LIMIT $3`,[companyId,accountId,Math.max(1,Math.min(limit,100))])).rows;
 const defer=async event=>{unresolved++;const delay=Math.min(1440,5*Math.pow(2,Math.min(event.attempt_count||0,8)));await pool.query(`UPDATE sdr_linkedin_events SET attempt_count=attempt_count+1,next_attempt_at=now()+($2::int*interval '1 minute') WHERE id=$1`,[event.id,delay])};
 for(const event of events){
  if(event.kind==='account_status'){
   const status=event.safe_payload?.status==='OK'?'healthy':'restricted';
   await pool.query("UPDATE sdr_linkedin_accounts SET status=CASE WHEN $3='healthy' AND status IN ('restricted','needs_review') THEN status ELSE $3 END,status_observed_at=$4 WHERE company_id=$1 AND account_id=$2",[companyId,accountId,status,event.observed_at]);
   await pool.query('UPDATE sdr_linkedin_events SET processed_at=now() WHERE id=$1',[event.id]);processed++;continue;
  }
  const candidates=(await pool.query(`SELECT DISTINCT c.* FROM sdr_linkedin_candidates c LEFT JOIN sdr_linkedin_actions a ON a.candidate_id=c.id WHERE c.company_id=$1 AND c.account_id=$2 AND c.state<>'archived' AND (c.id=$3 OR c.provider_id=$4 OR ($5::text IS NOT NULL AND a.provider_chat_id=$5)) LIMIT 2`,[companyId,accountId,event.candidate_id,event.provider_id,event.chat_id])).rows;
  const candidate=candidates.length===1?candidates[0]:null;
  if(!candidate?.person_id){if(event.kind==='message_received')await pool.query("UPDATE sdr_linkedin_accounts SET status='needs_review',status_observed_at=$3 WHERE company_id=$1 AND account_id=$2 AND status NOT IN ('restricted','disconnected')",[companyId,accountId,event.observed_at]);await defer(event);continue}
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
  if(identityConflict){await pool.query("UPDATE sdr_linkedin_accounts SET status='needs_review' WHERE company_id=$1 AND account_id=$2 AND status NOT IN ('restricted','disconnected')",[companyId,accountId]);await defer(event);continue}
  if(pendingOwnEcho){await defer(event);continue}
  if(event.kind==='message_received'&&event.direction==='in'&&onInbound){try{await onInbound({candidate,event})}catch{await defer(event);continue}}
  await pool.query('UPDATE sdr_linkedin_events SET candidate_id=$2,person_id=$3,processed_at=now(),next_attempt_at=NULL WHERE id=$1',[event.id,candidate.id,candidate.person_id]);processed++;
 }
 return {processed,unresolved,coverage:unresolved?'partial':'complete'};
}
export async function reconcileLinkedinAccount({pool,client,companyId,accountId,budget=2,now=new Date()}){
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
 // One page per list is the entire shared recovery budget. A partial or failed
 // result spends the slot; the next timer tick cannot retry a broad scan.
 const reads=await Promise.allSettled([client.listSentInvites({maxPages:1}),client.listRelations({maxPages:1})]);
 if(reads.some(read=>read.status!=='fulfilled'))return {coverage:'partial',reason:'provider_read_failed'};
 const [pending,relations]=reads.map(read=>read.value);
 if(!pending?.complete||!relations?.complete)return {coverage:'partial',reason:'pagination_incomplete'};
 const id=item=>String(item?.provider_id??item?.id??'');
 const pendingIds=new Set(pending.items.map(id)),relationIds=new Set(relations.items.map(id));
 const candidates=(await pool.query(`SELECT * FROM sdr_linkedin_candidates WHERE company_id=$1 AND account_id=$2 AND provider_id IS NOT NULL AND state NOT IN ('archived','opted_out')`,[companyId,accountId])).rows;
 let acceptedCount=0,heldCount=0;
 for(const candidate of candidates){
  const ownInvite=(await pool.query(`SELECT id FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND step='invite' AND state='confirmed'`,[companyId,accountId,candidate.person_id])).rows[0];
  if(relationIds.has(candidate.provider_id)&&ownInvite){
   const hash=linkedinHash({companyId,accountId,kind:'new_relation',providerId:candidate.provider_id});
   const result=await pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,provider_id,observed_at,coverage,payload_hash,safe_payload)
    VALUES($1,$2,$3,$4,'new_relation','poll',$5,$6,'poll',$7,$8) ON CONFLICT DO NOTHING RETURNING id`,[companyId,accountId,candidate.id,candidate.person_id,candidate.provider_id,now,hash,JSON.stringify({provider_id:candidate.provider_id,acceptance_day:'unknown'})]);
   acceptedCount+=result.rowCount;
  }else if(relationIds.has(candidate.provider_id)||pendingIds.has(candidate.provider_id)&&!ownInvite){
   await pool.query(`UPDATE sdr_linkedin_candidates SET state='held',hold_reason=$2,revision=revision+1 WHERE id=$1 AND state NOT IN ('held','replied','staff_takeover','opted_out','archived')`,[candidate.id,relationIds.has(candidate.provider_id)?'existing_relation_review':'external_pending_invite']);heldCount++;
  }
 }
 await pool.query(`UPDATE sdr_linkedin_accounts SET coverage=coverage||$3::jsonb WHERE company_id=$1 AND account_id=$2`,[companyId,accountId,JSON.stringify({lastRecoveryRead:now.toISOString(),pendingComplete:true,relationsComplete:true})]);
 return {coverage:'complete',pendingCount:pending.items.length,acceptedCount,heldCount};
}
