import {randomUUID} from 'node:crypto';
import pg from 'pg';

// Closed vocabulary: never retain error text, request bodies, recipients or nested
// draft/provider objects. These are HTTP observations, not provider outcomes.
const groups={
 capacity:['daily_cap_reached'],
 history:['existing_customer','already_outreached','contact_cooldown','replied'],
 address:['email_unverified'],
 draft:['draft_stale','draft_version_required','approval_missing','draft_too_old','already_sent','draft_revision_changed','draft_recipient_context_changed'],
 schedule:['scheduled_for_future','mailbox_inactive','sender_context_changed'],
 context:['crm_unverified','crm_context_changed','crm_trigger_changed','outreach_company_unverified','source_context_incomplete'],
 protection:['outreach_held','provider_state_requires_review','sequence_cadence_unverified','award_only_requires_matching_sequence','reviewed_context_changed','project_role_unverified','cadence_unverified','draft_review_context_changed','cohort_context_changed','policy_rollout_unconfigured','policy_cohort_unverified','policy_action_identity_required'],
 provider:['provider_contact_unverified','provider_context_incomplete','provider_operation_requires_review','provider_membership_unverified','external_membership_requires_review','provider_receipt_unverified','provider_receipt_conflict','apollo_skipped'],
 retry_guard:['enrollment_lease_missing','enrollment_in_progress','enrollment_uncertain'],
};
const categories=new Map(Object.entries(groups).flatMap(([category,codes])=>codes.map(code=>[code,category])));
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function createApprovalObserver({companyId,write,maxQueued=100}={}){
 const counters={bootedAt:new Date().toISOString(),finished:0,denied:0,abandoned:0,enqueued:0,persisted:0,duplicate:0,droppedFull:0,droppedInvalid:0,failedOrUncertain:0,lastPersistedAt:null};
 const queue=[];let active=false;
 const capacity=Math.min(100,Math.max(1,Number.isInteger(maxQueued)?maxQueued:100));
 const enabled=companyId==='13105180'&&typeof write==='function';
 function start(){
  if(active||!queue.length)return;active=true;
  try{setImmediate(async()=>{
   try{
    const inserted=await write(Object.freeze({id:randomUUID(),...queue[0]}));
    if(inserted===true){counters.persisted++;counters.lastPersistedAt=new Date().toISOString();}
    else if(inserted===false)counters.duplicate++;
    else counters.failedOrUncertain++;
   }catch{counters.failedOrUncertain++;}
   finally{queue.shift();active=false;start();}
  });}catch{counters.droppedInvalid+=queue.length;queue.length=0;active=false;}
 }
 function middleware(req,res,next){
  if(!enabled)return next();
  let authenticated=false;
  try{authenticated=Boolean(req.sdrUser?.sub);}catch{counters.droppedInvalid++;}
  if(!authenticated)return next();
  try{
   let done=false,ready=false,code='unknown';
   const draftId=typeof req.params?.id==='string'&&uuid.test(req.params.id)?req.params.id:null;
   const origin=req.sdrUser.machine===true?'machine':'interactive';
   const original=res.json;
   res.once('finish',()=>{
    if(done||!ready)return;done=true;counters.finished++;
    try{
     const status=res.statusCode;
     if([401,403,404].includes(status)){counters.denied++;return;}
     if(!draftId||!Number.isInteger(status)||status<200||status>599){counters.droppedInvalid++;return;}
     if(queue.length>=capacity){counters.droppedFull++;return;}
     queue.push(Object.freeze({companyId,draftId,origin,completedAt:new Date().toISOString(),httpStatus:status,responseCode:code,category:categories.get(code)||'unknown',kind:status>=500?'http_error':status>=400?'http_refusal':status<300?'http_success_response':'unclassified',contractVersion:1}));
     counters.enqueued++;start();
    }catch{counters.droppedInvalid++;}
   });
   res.once('close',()=>{if(!done&&ready){done=true;counters.abandoned++;}});
   res.json=function(...args){
    try{const value=Object.getOwnPropertyDescriptor(args[0]??{},'code')?.value;code=typeof value==='string'&&categories.has(value)?value:'unknown';}catch{code='unknown';}
    return Reflect.apply(original,this,args);
   };
   ready=true;
  }catch{counters.droppedInvalid++;}
  return next();
 }
 return {middleware,stats:()=>({...counters,enabled,queued:queue.length,coverage:'process_local_partial'})};
}

export async function insertApprovalObservation(pool,event){
 const r=await pool.query(`INSERT INTO sdr_approval_observations
  (observation_id,company_id,draft_id,origin,completed_at,http_status,response_code,category,observation_kind,contract_version)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(observation_id) DO NOTHING`,
 [event.id,event.companyId,event.draftId,event.origin,event.completedAt,event.httpStatus,event.responseCode,event.category,event.kind,event.contractVersion]);
 return r.rowCount===1;
}

export function createApprovalObservationRecorder({companyId,connectionString,PoolClass=pg.Pool}={}){
 let sink,poolErrors=0;
 const observer=createApprovalObserver({companyId,write:connectionString?async event=>{
  if(!sink){
   const created=new PoolClass({connectionString,ssl:{rejectUnauthorized:false},max:1,
    connectionTimeoutMillis:250,statement_timeout:250,lock_timeout:100,query_timeout:500,
    idleTimeoutMillis:1000,allowExitOnIdle:true});
   created.on('error',()=>{poolErrors++;});sink=created;
  }
  return insertApprovalObservation(sink,event);
 }:undefined});
 return {middleware:observer.middleware,stats:()=>({...observer.stats(),poolErrors})};
}
