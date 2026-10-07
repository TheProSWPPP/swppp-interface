import {randomUUID} from 'node:crypto';
import {runReplyAction} from './sdrReplyActions.js';
import {openActivityAlert} from './sdrEngagementReceipts.js';
const email=v=>String(v||'').trim().toLowerCase();
const validEmail=v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v||'');
const freshness=(at,now)=>+now<+new Date(at)?'future_open':+now-new Date(at)>96*3600000?'stale_open':null;

async function replyRecorded(db,leadId){
 const r=await db.query(`SELECT 1 FROM sdr_reply_messages WHERE pipedrive_lead_id=$1 AND reply_kind IN ('human','bounce')
 UNION ALL SELECT 1 FROM sdr_sends WHERE pipedrive_lead_id=$1 AND status IN ('replied','bounced','unsubscribed')
 UNION ALL SELECT 1 FROM sdr_engagement_events WHERE pipedrive_lead_id=$1 AND event_type IN ('email_replied','reply_received','email_bounced','email_unsubscribed')
 UNION ALL SELECT 1 FROM sdr_inbox_reply_log WHERE pipedrive_lead_id=$1 AND from_addr NOT LIKE '[auto-reply]%' LIMIT 1`,[leadId]);
 return !!r.rows.length;
}
async function sendContext(db,leadId){
 return (await db.query(`SELECT snd.id::text AS "sendId",mb.email AS mailbox,snd.contact_email_snapshot AS recipient,ls.person_email AS "currentRecipient",ls.lead_title AS "leadTitle",ls.pipedrive_person_id AS "personId",ls.pipedrive_org_id AS "orgId",mb.pipedrive_sender_id AS "ownerId"
 FROM sdr_sends snd JOIN sdr_mailboxes mb ON mb.id=snd.mailbox_id JOIN sdr_lead_state ls ON ls.pipedrive_lead_id=snd.pipedrive_lead_id
 WHERE snd.pipedrive_lead_id=$1 ORDER BY snd.sent_at DESC NULLS LAST,snd.id DESC LIMIT 1`,[leadId])).rows[0];
}
async function routeFor(db,mailbox){return (await db.query('SELECT forward_to FROM sdr_reply_routes WHERE mailbox_email=$1 AND active AND verified_at IS NOT NULL',[mailbox])).rows[0];}

// Only call for newly observed opens. Historic high_intent markers are never replayed.
export async function enqueueOpenAlert(pool,event){
 const now=event.now||new Date();
 if(!event.eventId||!event.leadId||!Number.isInteger(Number(event.opens))||Number(event.opens)<3)return {skipped:'below_threshold'};
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const source=(await client.query("SELECT * FROM sdr_engagement_events WHERE apollo_event_id=$1 AND pipedrive_lead_id=$2 AND event_type IN ('email_opened','email_open') LIMIT 1",[event.eventId,event.leadId])).rows[0];
  let outcome;
  if(!source||!Number.isFinite(+new Date(source.occurred_at)))outcome={review:'source_unverified'};
  else if(freshness(source.occurred_at,now))outcome={skipped:freshness(source.occurred_at,now)};
  else if((await client.query("SELECT 1 FROM sdr_engagement_events WHERE pipedrive_lead_id=$1 AND event_type='high_intent' LIMIT 1",[event.leadId])).rows.length)outcome={skipped:'historical_marker'};
  else if(await replyRecorded(client,event.leadId))outcome={skipped:'reply_recorded'};
  const current=outcome?null:await sendContext(client,event.leadId);
  if(!outcome&&(!current||!validEmail(current.mailbox)||!validEmail(current.recipient)||email(current.recipient)!==email(current.currentRecipient)
    ||(event.contactEmail&&email(event.contactEmail)!==email(current.recipient))
    ||(event.mailboxEmail&&email(event.mailboxEmail)!==email(current.mailbox))
    ||(source.mailbox_email&&email(source.mailbox_email)!==email(current.mailbox))))outcome={review:'context_unverified'};
  if(!outcome&&/ivan\.manfredi2001|prodtest|@example\./i.test(current.recipient))outcome={skipped:'test_contact'};
  if(outcome){await client.query('COMMIT');return outcome;}
  const route=await routeFor(client,email(current.mailbox));
  const forwardTo=route&&validEmail(route.forward_to)&&email(route.forward_to)!==email(current.recipient)?route.forward_to:null;
  const payload={leadId:event.leadId,sendId:current.sendId,personId:current.personId,orgId:current.orgId,ownerId:current.ownerId,mailbox:email(current.mailbox),contactEmail:email(current.recipient),leadTitle:current.leadTitle,opens:Number(event.opens),occurredAt:source.occurred_at,forwardTo};
  const alertId=randomUUID();
  const ins=await client.query(`INSERT INTO sdr_open_alerts(id,pipedrive_lead_id,source_event_id,occurred_at,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(pipedrive_lead_id) DO NOTHING RETURNING id`,[alertId,event.leadId,event.eventId,source.occurred_at,payload]);
  if(ins.rowCount)for(const kind of ['note','email']){
   const review=kind==='email'&&!forwardTo;
   await client.query(`INSERT INTO sdr_open_alert_actions(id,alert_id,kind,payload,status,requires_review,safe_error) VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),alertId,kind,payload,review?'failed':'pending',review,review?'routing_unverified':null]);
  }
  await client.query('COMMIT');return {enqueued:ins.rowCount?2:0};
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}

const scalarId=value=>String(value?.id??value?.value??value??'');
export async function checkOpenAlertContext(pool,action,{pipedrive,now=new Date()}={}){
 const p=action.payload;
 try{
  const stale=freshness(p.occurredAt,now);
  if(stale)return {status:'skip',reason:stale==='future_open'?'stale_open':stale};
  if(await replyRecorded(pool,p.leadId))return {status:'skip',reason:'reply_recorded'};
  const local=await sendContext(pool,p.leadId);
  if(!p.personId||!p.orgId||!p.ownerId||!local||local.sendId!==p.sendId||email(local.mailbox)!==p.mailbox||email(local.recipient)!==p.contactEmail||email(local.currentRecipient)!==p.contactEmail||scalarId(local.personId)!==scalarId(p.personId)||scalarId(local.orgId)!==scalarId(p.orgId)||scalarId(local.ownerId)!==scalarId(p.ownerId))return {status:'review',reason:'context_changed'};
  const lead=await pipedrive.getLead(p.leadId);
  if(!lead||scalarId(lead.id)!==p.leadId)return {status:'review',reason:'lead_unverified'};
  if(lead.is_archived===true||lead.deleted===true)return {status:'skip',reason:'handled'};
  if(scalarId(lead.person_id)!==scalarId(p.personId)||scalarId(lead.organization_id)!==scalarId(p.orgId)||scalarId(lead.owner_id)!==scalarId(p.ownerId))return {status:'review',reason:'identity_changed'};
  const person=await pipedrive.getPerson(p.personId);
  if(!person||scalarId(person.id)!==scalarId(p.personId)||person.active_flag===false||person.deleted===true||!Array.isArray(person.email)||!person.email.some(e=>email(e.value)===p.contactEmail))return {status:'review',reason:'recipient_changed'};
  return {status:'ready'};
 }catch{return {status:'review',reason:'context_unverified'};}
}

// checkContext must read current live CRM state. A positive result authorizes only
// an internal notification and an append-only note, never prospect outreach.
export async function drainOpenAlerts(pool,{clients={},checkContext,now=new Date(),limit=25,featureEnabled=process.env.SDR_OPEN_ALERTS_ENABLED==='true'}={}){
 if(!featureEnabled)return {skipped:'disabled'};
 await pool.query("UPDATE sdr_open_alert_actions SET status='failed',requires_review=true,safe_error='completion_uncertain',retry_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=$1 WHERE status='running' AND lease_until <= $1",[now]);
 const kinds=Object.keys(clients).filter(k=>typeof clients[k]==='function'||typeof clients[k]?.execute==='function');
 const reconcile=kinds.filter(k=>typeof clients[k]?.reconcile==='function');
 const counts={completed:0,failed:0,skipped:0};
 for(let i=0;i<Math.min(100,Math.max(0,limit));i++){
  const token=randomUUID();
  const row=(await pool.query(`WITH due AS (SELECT id FROM sdr_open_alert_actions WHERE kind=ANY($1::text[]) AND
   ((status IN ('pending','failed') AND NOT requires_review AND (retry_at IS NULL OR retry_at <= $2)) OR
   (status='failed' AND requires_review AND safe_error='completion_uncertain' AND kind=ANY($4::text[]) AND updated_at < $2))
   ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
   UPDATE sdr_open_alert_actions a SET status='running',lease_token=$3,lease_until=$2+INTERVAL '15 minutes',updated_at=$2 FROM due WHERE a.id=due.id RETURNING a.*`,[kinds,now,token,reconcile])).rows[0];
  if(!row)break;
  const action={...row,retryAt:row.retry_at,requiresReview:row.requires_review,safeError:row.safe_error,externalId:row.external_id,receiptAt:row.receipt_at};
  const handler=clients[row.kind];
  let result;
  // Reconcile a possible write before applying current suppression, so delivered
  // work is never mislabeled as skipped. Unknown completion stays in review.
  if(action.requiresReview){
   result=await runReplyAction(action,{now,execute:async()=>{throw Object.assign(new Error('reconciliation_only'),{uncertain:true});},reconcile:async a=>{
    const found=await handler.reconcile(a);return found?.state==='completed'?found:{state:'unknown'};
   }});
  }else{
   let skip,review;
   try{
    skip=freshness(action.payload.occurredAt,now);
    if(!skip&&await replyRecorded(pool,action.payload.leadId))skip='reply_recorded';
    if(!skip){
     const current=await sendContext(pool,action.payload.leadId);
     if(!current||current.sendId!==action.payload.sendId||email(current.mailbox)!==action.payload.mailbox||email(current.recipient)!==action.payload.contactEmail||email(current.currentRecipient)!==action.payload.contactEmail)review='context_changed';
     if(!review&&row.kind==='email'){
      const route=await routeFor(pool,action.payload.mailbox);
      if(!route||route.forward_to!==action.payload.forwardTo||!validEmail(route.forward_to)||email(route.forward_to)===action.payload.contactEmail)review='routing_changed';
     }
     if(!review){const live=checkContext?await checkContext(action):null;if(live?.status==='skip')skip=['handled','reply_recorded','stale_open'].includes(live.reason)?live.reason:'handled';else if(live?.status!=='ready')review='context_unverified';}
    }
   }catch{review='context_unverified';}
   if(skip)result={...action,status:'skipped',safeError:skip,requiresReview:false,retryAt:null};
   else if(review)result={...action,status:'failed',safeError:review,requiresReview:true,retryAt:null};
   else result=await runReplyAction(action,{now,execute:typeof handler==='function'?handler:handler.execute});
  }
  await pool.query(`UPDATE sdr_open_alert_actions SET status=$2,attempts=$3,retry_at=$4,requires_review=$5,safe_error=$6,external_id=$7,receipt_at=$8,lease_token=NULL,lease_until=NULL,updated_at=$9 WHERE id=$1 AND lease_token=$10`,[row.id,result.status==='running'?'failed':result.status,result.attempts,result.retryAt,result.requiresReview,result.safeError,result.externalId,result.receiptAt,now,token]);
  counts[result.status==='completed'?'completed':result.status==='skipped'?'skipped':'failed']++;
 }
 return counts;
}

export function createOpenAlertClients({gmail,getToken,pipedrive,baseUrl='https://swppp-interface-production.up.railway.app',pipedriveBaseUrl='https://proswpppllc.pipedrive.com'}){
 const messageId=a=>`<sdr-open-${a.id}@proswppp.co>`;
 const marker=a=>`[SDR open alert ${a.id}]`;
 const address=value=>email(String(value||'').match(/<([^<>]+)>/)?.[1]||value);
 const content=a=>openActivityAlert({leadTitle:a.payload.leadTitle,recipient:a.payload.contactEmail,opens:a.payload.opens,link:`${baseUrl}/#/sdr?lead=${encodeURIComponent(a.payload.leadId)}`,pdLink:`${pipedriveBaseUrl}/leads/inbox/${encodeURIComponent(a.payload.leadId)}`});
 return {
  email:{execute:async a=>{
   if(!validEmail(a.payload.forwardTo)||email(a.payload.forwardTo)===email(a.payload.contactEmail))throw Object.assign(new Error('routing_unverified'),{permanent:true});
   const token=await getToken(a.payload.mailbox);
   const text=content(a);
   return gmail.sendMail(token,{from:a.payload.mailbox,to:a.payload.forwardTo,...text,bodyText:`${text.bodyText}\n${marker(a)}`,bodyHtml:`${text.bodyHtml}<p>${marker(a)}</p>`,messageId:messageId(a)});
  },reconcile:async a=>{
   const token=await getToken(a.payload.mailbox);
   const visited=new Set();
   for(const query of [`in:sent rfc822msgid:${messageId(a)}`,`in:sent "${marker(a)}"`]){
    const page=await gmail.listThreadPage(token,{query,maxResults:25});
    for(const candidate of page.threads||[]){
     if(visited.has(candidate.id))continue;visited.add(candidate.id);
     const thread=await gmail.getThread(token,candidate.id);
     for(const m of thread.messages||[])if(m.lastOutbound&&address(m.from)===a.payload.mailbox&&address(m.to)===email(a.payload.forwardTo)
       &&String(m.body||'').includes(`${content(a).bodyText}\n${marker(a)}`))return {state:'completed',receipt:{id:m.id}};
    }
   }
   return {state:'unknown'}; // Gmail search absence does not prove non-delivery.
  }},
  note:{execute:async a=>{
   const result=await pipedrive.addNote({leadId:a.payload.leadId,content:`${content(a).bodyText}\n[SDR open alert ${a.id}]`});
   return {id:result?.id||result?.data?.id};
  }},
 };
}
