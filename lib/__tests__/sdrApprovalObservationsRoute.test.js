import express from 'express';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {createApprovalObserver} from '../sdrApprovalObservations.js';
import {checkViewedDraft,draftContextHash,checkDraftSchedule,draftConflict,recordDraftApproval,checkApprovedDraft,serializeDraft} from '../sdrDraftRevision.js';

const source=readFileSync(new URL('../../server.js',import.meta.url),'utf8');
const start='app.post("/api/sdr/drafts/:id/approve-and-send", async (req, res) => {';
const end='\napp.get("/api/projects", async (req, res) => {';
const block=source.slice(source.indexOf(start),source.indexOf(end));
const frozenHash='beb7ef0c12291d6362a2920892a6c23b8bf10f096f26045e144ed44fb40c9db8';
const id='00000000-0000-0000-0000-000000000001',actor='00000000-0000-0000-0000-000000000002',at='2026-10-09T00:00:00.000Z';
const copy=v=>JSON.parse(JSON.stringify(v));
class FixtureDate extends Date{constructor(...args){super(...(args.length?args:[at]));}static now(){return Date.parse(at);}}
const scenarios=[
 {name:'machine success',machine:true,status:200,milestones:['provider.enroll','crm.updateLead','outreach.publish']},
 {name:'interactive success',status:200,milestones:['approval.insert','provider.enroll','crm.updateLead','outreach.publish']},
 {name:'interactive capacity refusal after durable approval',capacity:true,status:429,code:'daily_cap_reached',milestones:['approval.insert','capacity.sentToday'],draftStatus:'approved'},
 {name:'stale revision',stale:true,status:409,code:'draft_stale',milestones:['draft.prefetch']},
 {name:'future schedule',schedule:true,status:409,code:'scheduled_for_future',milestones:['draft.prefetch']},
 {name:'machine missing exact approval',machine:true,missingApproval:true,status:409,code:'approval_missing',milestones:['approval.read']},
 {name:'address rejection and CRM note',address:true,status:422,code:'email_unverified',milestones:['verify.cacheWrite','draft.reject','crm.addNote'],draftStatus:'rejected'},
 {name:'missing database config',noDb:true,status:503,milestones:[]},
 {name:'missing Apollo config',noApollo:true,status:503,milestones:[]},
 {name:'missing draft',missingDraft:true,status:404,milestones:['draft.prefetch']},
 {name:'missing sequence',noSequence:true,status:400,milestones:['approval.insert']},
 {name:'missing sender',noMailbox:true,status:400,milestones:['approval.insert']},
 {name:'missing provider sender ID',missingSender:true,status:500,milestones:['mailbox.read']},
 {name:'inactive sender',inactiveSender:true,status:409,code:'mailbox_inactive',milestones:['mailbox.read']},
 {name:'existing customer',customer:true,status:409,code:'existing_customer',milestones:['customer.read']},
 {name:'recent historical outreach',history:true,status:409,code:'already_outreached',milestones:['history.read']},
 {name:'history override denied to staff',history:true,override:true,staff:true,status:403,milestones:['history.read']},
 {name:'stale age gate',old:true,status:409,code:'draft_too_old',milestones:['freshness.read']},
 {name:'sender context safety guard',safetyFailure:'pre_match',guardCode:'sender_context_changed',status:409,code:'sender_context_changed',milestones:['safety.pre_match']},
 {name:'policy locked preflight guard',safetyFailure:'locked_preflight',guardCode:'outreach_held',status:409,code:'outreach_held',milestones:['provider.lock','safety.locked_preflight']},
 {name:'CRM unavailable immediately before enroll',crmDenied:true,status:503,code:'crm_unverified',milestones:['provider.fields','crm.verify']},
 {name:'revision conflict after provider lock',lockConflict:true,status:409,code:'draft_stale',milestones:['provider.match','provider.lock']},
 {name:'human reply guard',replied:true,status:409,code:'replied',milestones:['reply.read']},
 {name:'retry guard disabled ignores recorded block',retry:false,retryBlock:true,status:200,milestones:['provider.enroll']},
 {name:'retry guard enabled accepts lease',retry:true,status:200,milestones:['retry.read','retry.assess','provider.enroll']},
 {name:'retry guard enabled refuses ownership',retry:true,retryBlock:true,status:409,code:'enrollment_uncertain',milestones:['retry.read','retry.assess']},
 {name:'provider skip response',providerSkip:true,status:409,code:'apollo_skipped',milestones:['provider.enroll','draft.fail'],draftStatus:'failed'},
 {name:'provider uncertain throw',providerThrow:true,status:500,milestones:['provider.enroll','draft.fail'],draftStatus:'failed'},
 {name:'provider 429 retry disabled',provider429:true,retry:false,status:429,milestones:['provider.enroll','draft.fail'],draftStatus:'failed'},
 {name:'provider 429 retry enabled',provider429:true,retry:true,status:429,milestones:['provider.enroll'],draftStatus:'approved'},
 {name:'post-provider bookkeeping failure with fallback',finalizeFail:true,status:200,milestones:['provider.enroll','tx.rollback','draft.fallback','send.fallback','outreach.publish'],draftStatus:'sent'},
 {name:'post-provider bookkeeping and fallback failure',finalizeFail:true,fallbackFail:true,status:200,milestones:['provider.enroll','tx.rollback','draft.fallback','send.fallback','crm.updateLead'],draftStatus:'approved'},
 {name:'CRM follow-through failures after enrollment',crmFailure:true,status:200,milestones:['provider.enroll','crm.updateLead','outreach.publish'],draftStatus:'sent'},
];

function harness(scenario){
 const state={draft:{id,pipedrive_lead_id:'lead',revision:5,status:'pending',content_origin:'interactive',subject:'Approved subject',body:'Approved body',contact_id_snapshot:'person',contact_email_snapshot:'buyer@example.test',org_id_snapshot:'org',pipedrive_contact_id:'person',pipedrive_org_id:'org',assigned_mailbox_id:'mailbox',assigned_user_id:actor,apollo_sequence_id:'sequence',trigger_type:'AGC',metadata:{},enrollment_version:at},approvals:[],sends:[],provider:[],crm:[],warmup:false};
 if(scenario.schedule)state.draft.scheduled_for='2099-01-01T00:00:00Z';if(scenario.noSequence)state.draft.apollo_sequence_id=null;if(scenario.noMailbox)state.draft.assigned_mailbox_id=null;
 if(scenario.machine&&!scenario.missingApproval)state.approvals.push({context_hash:draftContextHash(state.draft),subject:state.draft.subject,body:state.draft.body});
 const trace=[],unexpected=[];let transaction=null,inProviderLock=false;
 const record=(name,args=[])=>trace.push({name,args:copy(args)});
 const error=(message,status,code,preserveDraft)=>Object.assign(new Error(message),{status,code,preserveDraft});
 const query=async(where,sql,params=[])=>{
  const q=sql.replace(/\s+/g,' ').trim();let result,name;
  if(q.startsWith('SELECT *,updated_at::text AS enrollment_version FROM sdr_drafts WHERE id = $1')){name='draft.prefetch';result=scenario.missingDraft?[]:[state.draft];}
  else if(q==='SELECT * FROM sdr_drafts WHERE id=$1 FOR UPDATE'){name='draft.approvalLockRead';result=[state.draft];}
  else if(q==='SELECT *,updated_at::text AS enrollment_version FROM sdr_drafts WHERE id=$1 FOR UPDATE'){name='draft.providerLockRead';if(!inProviderLock)throw Error('missing provider lock');result=[scenario.lockConflict?{...state.draft,revision:6}:state.draft];}
  else if(q.startsWith("UPDATE sdr_drafts SET status='approved'")){name='draft.approve';Object.assign(state.draft,{status:'approved',approved_at:at,approved_by:params[1]});result=[state.draft];}
  else if(q.startsWith('INSERT INTO sdr_draft_approvals')){name='approval.insert';state.approvals.push({context_hash:params[2],subject:params[3],body:params[4]});result=[];}
  else if(q.startsWith('SELECT * FROM sdr_draft_approvals')){name='approval.read';result=state.approvals.slice(-1);}
  else if(q.startsWith('SELECT sent_at, source FROM sdr_outreach_log')){name='history.read';result=scenario.history?[{sent_at:at,source:'pipedrive'}]:[];}
  else if(q.startsWith('SELECT id, email, apollo_mailbox_id')){name='mailbox.read';result=[{id:'mailbox',email:'rep@example.test',apollo_mailbox_id:scenario.missingSender?null:'provider-mailbox',active:!scenario.inactiveSender,warmup_started_at:null,daily_send_limit:40}];}
  else if(q.startsWith('SELECT project_stage FROM sdr_lead_state')){name='stage.read';result=[{project_stage:'AGC'}];}
  else if(q.startsWith('SELECT 1 FROM sdr_reply_messages')){name='reply.read';result=scenario.replied?[{}]:[];}
  else if(q.startsWith('SELECT status,category,lease_token,lease_expires_at FROM sdr_enrollment_attempts')){name='retry.read';result=[{status:scenario.retryBlock?'uncertain':'leased',lease_token:'lease'}];}
  else if(q==='BEGIN'){name='tx.begin';transaction=copy(state);result=[];}
  else if(q==='COMMIT'){name='tx.commit';transaction=null;result=[];}
  else if(q==='ROLLBACK'){name='tx.rollback';if(transaction)Object.assign(state,transaction);transaction=null;result=[];}
  else if(q.startsWith("UPDATE sdr_drafts SET status = 'sent'")){name=where==='pool'?'draft.fallback':'draft.sent';record(name,[q,params]);if(where==='pool'&&scenario.fallbackFail)throw Error('fallback unavailable');Object.assign(state.draft,{status:'sent',sent_at:at,approved_at:at,approved_by:params[1]});if(params[2])state.draft.error_message=params[2];return {rows:copy([state.draft])};}
  else if(q.startsWith('INSERT INTO sdr_sends')){name=where==='pool'?'send.fallback':'send.insert';record(name,[q,params]);if(where==='client'&&scenario.finalizeFail)throw Error('finalization unavailable');if(where==='pool'&&scenario.fallbackFail)throw Error('fallback unavailable');const send={id:'send',draft_id:params[0],status:'enrolled'};state.sends.push(send);return {rows:copy([send])};}
  else if(q.startsWith('UPDATE sdr_mailboxes SET warmup_started_at')){name='mailbox.warmup';state.warmup=true;result=[];}
  else if(q.startsWith("UPDATE sdr_drafts SET status = 'failed'")){name='draft.fail';if(!state.sends.length&&!state.draft.sent_at){state.draft.status='failed';state.draft.error_message=params[1];}result=[];}
  else {unexpected.push(q);throw Error('Unexpected operational SQL: '+q);}
  record(name,[q,params]);return {rows:copy(result)};
 };
 const pool={query:(...args)=>query('pool',...args)},client={query:(...args)=>query('client',...args)};
 const call=(name,fn=()=>undefined)=>(...args)=>{record(name,args);return fn(...args);};
 const deps={
  pool,process:{env:{DATABASE_URL:scenario.noDb?'':'fixture',APOLLO_API_KEY:scenario.noApollo?'':'fixture',PIPEDRIVE_API_TOKEN:'fixture',SDR_CRM_COMPANY_ID:'13105180',SDR_REPLY_ACTIONS_ENABLED:'true'}},Date:FixtureDate,crypto:{randomUUID:()=> '00000000-0000-0000-0000-000000000099'},
  console:{log:()=>{},warn:()=>{},error:(...args)=>{for(const e of args)if(e instanceof ReferenceError)unexpected.push(e.message);}},
  ownerScope:user=>({requires:user.role==='sdr',column:'assigned_user_id',value:user.sub}),checkViewedDraft,checkDraftSchedule,draftContextHash,draftConflict,recordDraftApproval,checkApprovedDraft,serializeDraft,
  withLeadLock:async(_pool,lead,work)=>{record('lead.lock',[lead]);try{return await work(client);}finally{record('lead.unlock',[lead]);}},
  withProviderContactLock:async(_pool,contact,leads,work)=>{record('provider.lock',[contact,leads]);inProviderLock=true;try{return await work(client);}finally{inProviderLock=false;record('provider.unlock',[contact,leads]);}},
  staleDraftBlock:call('freshness.read',()=>scenario.old?{ageDays:40,maxAgeDays:14}:null),isCustomerLead:call('customer.read',()=>scenario.customer?{matchedOn:'organization',reason:'customer'}:null),contactCooldownDays:call('cooldown.read',()=>30),
  emailVerify:{verifyEnabled:()=>Boolean(scenario.address),canonicalVerdict:()=> 'hard_fail',verifyEmail:call('verify.provider',()=>({ok:false,status:'invalid',sub_status:null,suggestion:null}))},
  STALE_MS:86400000,readVerifyCache:async(_p,lead)=>{record('verify.cacheRead',[lead]);return null;},writeVerifyCache:async(_p,...args)=>{record('verify.cacheWrite',args);},
  mutateViewedDraft:async(_p,{fields,...args})=>{record('draft.reject',[args,fields]);Object.assign(state.draft,fields);return copy(state.draft);},
  mailboxBounceHealth:async(_p,args)=>{record('capacity.health',[args]);return new Map([['mailbox',{sent:0,bounced:0}]]);},dailyCap:call('capacity.cap',()=>40),mailboxSentToday:call('capacity.sentToday',()=>scenario.capacity?40:0),rampDay:()=>1,bounceStepPenalty:()=>0,
  assertSendSafety:async(_p,draft,options)=>{record('safety.'+options.phase,[draft,options]);if(scenario.safetyFailure===options.phase)throw draftConflict(scenario.guardCode);return {companyId:'13105180',leadId:'lead'};},
  readContactSendDaysAgo:async(_p,args)=>{record('contact.history',[args]);return null;},reserveEnrollment:async({pool:_p,apollo:_a,...args})=>{record('provider.reserve',[args]);return {reservationId:'reservation'};},recordEnrollmentReceipt:async({pool:_p,...args})=>record('provider.receipt',[args]),
  enrollmentRetryEnabled:()=>Boolean(scenario.retry),enrollmentSendBlock:call('retry.assess',()=>scenario.retryBlock?'enrollment_uncertain':null),crmLifecycleEnabled:()=>true,verifyCrmLead:async lead=>{record('crm.verify',[lead]);return scenario.crmDenied?{allowed:false,retryable:true,reason:'crm_unverified'}:{allowed:true};},
  APOLLO_CF_DRAFT_SUBJECT:'subject',APOLLO_CF_DRAFT_BODY:'body',APOLLO_CF_TRACK:'track',APOLLO_CF_ENV:'env',APOLLO_CF_SWPPP:'swppp',pdSequenceStartedKey:'sequence_started',
  apolloClient:{matchContactByEmail:call('provider.match',()=>({id:'contact'})),updateContactCustomFields:call('provider.fields',(...args)=>{state.provider.push(['fields',...args]);}),addContactsToSequence:call('provider.enroll',(...args)=>{state.provider.push(['enroll',...args]);if(scenario.providerThrow)throw Error('provider result unknown');if(scenario.provider429)throw error('provider capacity',429);if(scenario.providerSkip)return {contacts:[],skipped_contact_ids:{contact:'existing membership'}};return {contacts:[{id:'contact',contact_campaign_statuses:[{emailer_campaign_id:'sequence',emailer_campaign_contact_id:'membership',added_at:at}]}]};})},
  pipedriveClient:{getPerson:call('crm.person',()=>({name:'Buyer',last_outgoing_mail_time:null})),addNote:async args=>{record('crm.addNote',[args]);state.crm.push(['note',args]);},updateLead:async(...args)=>{record('crm.updateLead',args);if(scenario.crmFailure)throw error('CRM requires review',409,'crm_change_requires_review');state.crm.push(['lead',...args]);}},
  publishOutreachEvent:async(_p,args)=>{record('outreach.publish',[args]);if(scenario.crmFailure)throw Error('CRM follow-through unavailable');state.crm.push(['event',args]);},
 };
 const body={expectedRevision:scenario.stale?4:5,expectedContextHash:draftContextHash(state.draft),enrollment_lease:'lease',...(scenario.override?{override:true}:{})};
 return {deps,state,trace,unexpected,body,user:{sub:actor,role:scenario.staff?'sdr':'admin',machine:Boolean(scenario.machine)}};
}

const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function run(scenario,sinkMode){
 const h=harness(scenario),telemetry=[],lifecycle=[],committedSink=[];let release,writeCount=0,requestBody;
 const write=event=>{writeCount++;telemetry.push(event);lifecycle.push('sink');if(sinkMode==='uncertain')committedSink.push(event.id);if(sinkMode==='sync_throw')throw Error('sink helper failed');if(['missing_table','connect_reject','statement_timeout','lock_timeout','uncertain'].includes(sinkMode))return Promise.reject(Error(sinkMode));if(sinkMode==='delayed'||sinkMode==='queue_full')return new Promise(resolve=>{release=()=>resolve(true);});return sinkMode==='duplicate'?false:true;};
 const observer=sinkMode?createApprovalObserver({companyId:'13105180',write,maxQueued:sinkMode==='queue_full'?1:100}):null;
 if(sinkMode==='queue_full'){const res=new EventEmitter();res.statusCode=200;res.json=()=>{};observer.middleware({params:{id},sdrUser:h.user},res,()=>{});res.emit('finish');await turn();}
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.sdrUser=copy(h.user);res.once('finish',()=>{lifecycle.push('finish');requestBody=copy(req.body);});next();});
 if(observer)app.post('/api/sdr/drafts/:id/approve-and-send',sinkMode==='setup_throw'?(req,res,next)=>{const original=res.once;res.once=()=>{res.once=original;throw Error('synthetic listener setup failure');};return observer.middleware(req,res,next);}:observer.middleware);
 new Function('app',...Object.keys(h.deps),block)(app,...Object.values(h.deps));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/sdr/drafts/${id}/approve-and-send`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(h.body)});
  const body=await response.text();await turn();const beforeRelease=observer?.stats();
  if(release)release();await turn();await turn();
  return {status:response.status,body,headers:{contentType:response.headers.get('content-type'),contentLength:response.headers.get('content-length'),etag:response.headers.get('etag')},trace:h.trace,state:h.state,unexpected:h.unexpected,telemetry,lifecycle,beforeRelease,stats:observer?.stats(),writeCount,committedSink,requestBody};
 }finally{release?.();await new Promise(resolve=>server.close(resolve));}
}
function outcome(r){return {status:r.status,body:r.body,headers:r.headers,trace:r.trace,state:r.state,unexpected:r.unexpected,requestBody:r.requestBody};}
function checkScenario(r,s){expect(r.unexpected).toEqual([]);expect(r.status).toBe(s.status);if(s.code)expect(JSON.parse(r.body).code).toBe(s.code);else expect(JSON.parse(r.body).code).toBeUndefined();const names=r.trace.map(t=>t.name);for(const milestone of s.milestones)expect(names,`${s.name} did not reach ${milestone}`).toContain(milestone);if(s.status!==200&&!s.milestones.includes('provider.enroll'))expect(names).not.toContain('provider.enroll');if(s.capacity){expect(names.indexOf('approval.insert')).toBeLessThan(names.indexOf('capacity.sentToday'));expect(r.state.approvals).toHaveLength(1);}if(s.finalizeFail){expect(JSON.parse(r.body).warning).toContain('Apollo enrolled OK but local bookkeeping failed');expect(names.indexOf('provider.enroll')).toBeLessThan(names.indexOf('tx.rollback'));}if(s.crmFailure)expect(JSON.parse(r.body).pipedrive_sync).toBe('proposal_pending');if(s.draftStatus)expect(r.state.draft.status).toBe(s.draftStatus);if(s.retry===false)expect(names).not.toContain('retry.read');if(s.status===200&&!s.fallbackFail){expect(r.state.sends).toHaveLength(1);expect(r.state.draft.status).toBe('sent');}}

describe('frozen real approval handler response observation equivalence',()=>{
 it('executes the exact independently reviewed original registration',()=>{expect(source.split(start)).toHaveLength(2);expect(source.split(end)).toHaveLength(2);expect(Buffer.byteLength(block)).toBe(30576);expect(createHash('sha256').update(block).digest('hex')).toBe(frozenHash);});
 it.each(scenarios)('$name preserves HTTP response, operation ordering and state',async scenario=>{const baseline=await run(scenario),recorded=await run(scenario,'success');checkScenario(baseline,scenario);checkScenario(recorded,scenario);expect(outcome(recorded)).toEqual(outcome(baseline));if([401,403,404].includes(recorded.status)){expect(recorded.telemetry).toEqual([]);expect(recorded.stats.denied).toBe(1);}else{expect(recorded.telemetry).toHaveLength(1);expect(recorded.telemetry[0]).toMatchObject({draftId:id,httpStatus:scenario.status,origin:scenario.machine?'machine':'interactive'});expect(recorded.lifecycle.indexOf('sink')).toBeGreaterThan(recorded.lifecycle.indexOf('finish'));}});
 const deep=scenarios.filter(s=>['interactive success','machine success','interactive capacity refusal after durable approval','post-provider bookkeeping failure with fallback'].includes(s.name));
 for(const scenario of deep)it.each(['sync_throw','missing_table','connect_reject','statement_timeout','lock_timeout','delayed','uncertain','duplicate','queue_full','setup_throw'])(`${scenario.name} remains equivalent with %s sink`,async mode=>{const baseline=await run(scenario),recorded=await run(scenario,mode);checkScenario(recorded,scenario);expect(outcome(recorded)).toEqual(outcome(baseline));if(mode==='setup_throw'){expect(recorded.stats.droppedInvalid).toBe(1);expect(recorded.writeCount).toBe(0);}else if(mode==='queue_full'){expect(recorded.beforeRelease.droppedFull).toBe(1);expect(recorded.writeCount).toBe(1);}else if(mode==='delayed'){expect(recorded.beforeRelease.persisted).toBe(0);expect(recorded.beforeRelease.queued).toBe(1);expect(recorded.stats.persisted).toBe(1);}else if(mode==='duplicate')expect(recorded.stats.persisted).toBe(0);else expect(recorded.stats.failedOrUncertain).toBe(1);if(mode==='uncertain'){expect(recorded.committedSink).toHaveLength(1);expect(recorded.writeCount).toBe(1);}});
});
