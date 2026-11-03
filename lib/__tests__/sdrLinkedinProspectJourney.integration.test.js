import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {queueLinkedinAction,dispatchLinkedinAction,completeLinkedinSequences} from '../sdrLinkedinOperations.js';
import {createLinkedinProspectFreshContext} from '../sdrLinkedinProspectFreshContext.js';
import {saveLinkedinCampaign,approveLinkedinCampaign} from '../sdrLinkedinAdmin.js';
import {stageProspect} from '../sdrLinkedinProspect.js';
import {ingestLinkedinEvent,processLinkedinEvents} from '../sdrLinkedinSync.js';
import {createLinkedinInboundHandler} from '../sdrLinkedinInbound.js';
import {createProspectInboundHandler,drainReplyAlerts,markReplyAlertHandled} from '../sdrLinkedinReplyAlerts.js';
import {startLinkedinRuntime} from '../sdrLinkedinRuntime.js';
import {linkedinHash} from '../sdrLinkedinStore.js';
import {testPool,createProspectSchema,insertAccount,fakeSeat,writes} from './helpers/linkedinProspectFixture.js';

const {schema,pool}=testPool('linkedin_prospect_journey',{skipWithoutDb:true});
const company='13105180',DAY=86_400_000;
const MON=new Date('2026-11-02T15:00:00Z'); // Monday 09:00 Central
const noCustomer=async()=>null;
const facts={company:{value:'Big GC',verified:true},newCompany:{value:'Big GC',verified:true},oldCompany:{value:'Flintco',verified:true},state:{value:'Texas',verified:true}};
beforeAll(async()=>{if(pool)await createProspectSchema(pool,schema)});
afterAll(async()=>{if(!pool)return;await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()});

async function setup(accountId,lane,key,{rampStartedOn='2026-10-01'}={}){
 await insertAccount(pool,accountId,{rampStartedOn});
 const person={firstName:'Pat',lastName:key,profileUrl:`https://www.linkedin.com/in/${key}/`,company:'Big GC',title:'Director of Preconstruction',stateCode:'TX',publicIdentifier:key,providerId:`ACo-${key}`,evidence:{source:'apify',runId:'r'}};
 const candidate=await stageProspect(pool,{companyId:company,accountId,lane,person,facts,actor:'admin',ownerId:'owner',now:MON});
 const saved=await saveLinkedinCampaign({pool,companyId:company,accountId,actor:'admin',config:{lane,budgets:{invite:15,dm:25,inmail:5,withdraw:20}},expiresAt:'2027-01-15T00:00:00Z',candidateIds:[candidate.id],now:MON});
 const campaign=await approveLinkedinCampaign({pool,companyId:company,accountId,actor:'admin',campaignId:saved.id,expectedRevision:saved.revision,now:MON});
 const seat=fakeSeat({accountId,providerId:`ACo-${key}`,publicId:key});
 const fresh=createLinkedinProspectFreshContext({pool,client:seat,customerCheck:noCustomer});
 const step=async(at,options={})=>{const action=await queueLinkedinAction({pool,candidateId:candidate.id,campaignId:campaign.id,now:at,...options});if(!action?.id)return {action,result:null};return {action,result:await dispatchLinkedinAction({pool,client:seat,actionId:action.id,readFreshContext:fresh,mode:'live',now:at,customerCheck:noCustomer,inmailEnabled:options.inmailEnabled===true,withdrawEnabled:options.withdrawEnabled===true})}};
 return {candidate,campaign,seat,fresh,step};
}
const accept=async(accountId,key,at)=>{await ingestLinkedinEvent(pool,{companyId:company,boundAccountId:accountId,payload:{account_id:accountId,event:'new_relation',user_provider_id:`ACo-${key}`,timestamp:at.toISOString()},receivedAt:at});await processLinkedinEvents({pool,companyId:company,accountId})};

describe.skipIf(!pool)('prospect lane journeys on synthetic Unipile and real Postgres',()=>{
 it('lane A: invite, accept, M1 the same day, M2 at 3 and M3 at 7 business days, then completes',async()=>{
  const {candidate,seat,step}=await setup('journey-a','A','alpha');
  const invite=await step(MON);expect(invite.action.step).toBe('invite');expect(invite.result.state).toBe('confirmed');
  expect((await pool.query("SELECT provider_id FROM sdr_linkedin_actions WHERE candidate_id=$1 AND step='invite'",[candidate.id])).rows[0].provider_id).toBe('inv-alpha');
  seat.state.connected=true;const acceptedAt=new Date(MON.getTime()+60*60_000);await accept('journey-a','alpha',acceptedAt);
  const dm1=await step(new Date(acceptedAt.getTime()+60_000));expect(dm1.action.step).toBe('dm1');expect(dm1.result.state).toBe('confirmed');
  expect(dm1.action.body).toBe("Hey Pat, appreciate the connection. Congrats on the new role at Big GC. Who's handling the SWPPPs over there these days?");
  const m2=await queueLinkedinAction({pool,candidateId:candidate.id,campaignId:dm1.action.campaign_id,now:new Date(acceptedAt.getTime()+120_000)});
  expect(m2.step).toBe('followup1');expect(m2.due_at.toISOString()).toBe('2026-11-05T16:01:00.000Z');
  expect((await step(new Date(m2.due_at.getTime()+1000))).result.state).toBe('confirmed');
  const m3=await queueLinkedinAction({pool,candidateId:candidate.id,campaignId:dm1.action.campaign_id,now:new Date(m2.due_at.getTime()+2000)});
  expect(m3.step).toBe('followup2');expect(m3.due_at.toISOString()).toBe('2026-11-11T16:01:00.000Z');
  expect((await step(new Date(m3.due_at.getTime()+1000))).result.state).toBe('confirmed');
  expect(writes(seat)).toEqual(['invite','sendFirst','sendInChat','sendInChat']);
  expect(await completeLinkedinSequences({pool,companyId:company,accountId:'journey-a',now:new Date(m3.due_at.getTime()+8*DAY)})).toMatchObject({sequenceFinished:1});
  expect((await pool.query('SELECT state,hold_reason FROM sdr_linkedin_candidates WHERE id=$1',[candidate.id])).rows[0]).toEqual({state:'completed_no_reply',hold_reason:'sequence_finished'});
 });
 it('lane B: M1 then M2 at 4 business days, and no M3',async()=>{
  const {candidate,seat,step}=await setup('journey-b','B','bravo');
  expect((await step(MON)).result.state).toBe('confirmed');
  seat.state.connected=true;await accept('journey-b','bravo',new Date(MON.getTime()+60*60_000));
  const dm1=await step(new Date(MON.getTime()+61*60_000));expect(dm1.action.body).toBe("Hey Pat, saw you made the move to Big GC. Congrats man. We miss doing your SWPPPs from the Flintco days. Who's handling stormwater over there?");
  const m2=await queueLinkedinAction({pool,candidateId:candidate.id,campaignId:dm1.action.campaign_id,now:new Date(MON.getTime()+62*60_000)});
  expect(m2.step).toBe('followup1');expect(m2.due_at.toISOString()).toBe('2026-11-06T16:01:00.000Z');
  expect((await step(new Date(m2.due_at.getTime()+1000))).result.state).toBe('confirmed');
  expect(await queueLinkedinAction({pool,candidateId:candidate.id,campaignId:dm1.action.campaign_id,now:new Date(m2.due_at.getTime()+DAY)})).toEqual({state:'held',reason:'sequence_complete'});
  expect(await completeLinkedinSequences({pool,companyId:company,accountId:'journey-b',now:new Date(m2.due_at.getTime()+8*DAY)})).toMatchObject({sequenceFinished:1});
  expect((await pool.query("SELECT count(*)::int AS n FROM sdr_linkedin_actions WHERE candidate_id=$1 AND step='followup2'",[candidate.id])).rows[0].n).toBe(0);
 });
 it('lane A not accepted: InMail on day 14, withdraw on day 21, each only when its switch is on',async()=>{
  const {candidate,seat,step}=await setup('journey-inmail','A','charlie');
  expect((await step(MON)).result.state).toBe('confirmed');
  const off=await queueLinkedinAction({pool,candidateId:candidate.id,campaignId:(await pool.query('SELECT campaign_id FROM sdr_linkedin_candidates WHERE id=$1',[candidate.id])).rows[0].campaign_id,now:new Date(MON.getTime()+14*DAY),inmailEnabled:false,withdrawEnabled:false});
  expect(off).toEqual({state:'held',reason:'pending_invite'});
  expect((await step(new Date(MON.getTime()+14*DAY-60_000),{inmailEnabled:true})).action).toEqual({state:'held',reason:'pending_invite'});
  const inmail=await step(new Date(MON.getTime()+14*DAY),{inmailEnabled:true});
  expect(inmail.action.step).toBe('inmail');expect(inmail.result.state).toBe('confirmed');
  expect(JSON.parse(inmail.action.body)).toEqual({subject:'SWPPPs at Big GC',body:"Hey Pat, congrats on the new role. I'm Derek, I run ProSWPPP. We write the SWPPPs for GCs in Texas. If you're putting your sub list together, I'd love to be on it. Worth a 10 minute call?"});
  expect((await pool.query("SELECT inmail_balance FROM sdr_linkedin_accounts WHERE account_id='journey-inmail'")).rows[0].inmail_balance).toBe(10);
  const withdraw=await step(new Date(MON.getTime()+21*DAY),{withdrawEnabled:true});
  expect(withdraw.action.step).toBe('withdraw');expect(withdraw.result.state).toBe('confirmed');
  expect(writes(seat)).toEqual(['invite','sendInmail','withdrawInvite']);
  expect(await completeLinkedinSequences({pool,companyId:company,accountId:'journey-inmail',now:new Date(MON.getTime()+22*DAY),withdrawEnabled:true})).toMatchObject({inviteExpired:1});
  expect((await pool.query('SELECT state,hold_reason FROM sdr_linkedin_candidates WHERE id=$1',[candidate.id])).rows[0]).toEqual({state:'completed_no_reply',hold_reason:'invite_withdrawn'});
 });
 it('holds an InMail when the credits are gone',async()=>{
  const {candidate,seat,step}=await setup('journey-credits','A','delta');
  expect((await step(MON)).result.state).toBe('confirmed');
  seat.state.inmailBalance=0;
  const held=await step(new Date(MON.getTime()+14*DAY),{inmailEnabled:true});
  expect(held.result.state).toBe('inmail_credits_exhausted');expect(writes(seat)).toEqual(['invite']);
  expect((await pool.query("SELECT state FROM sdr_linkedin_actions WHERE candidate_id=$1 AND step='inmail'",[candidate.id])).rows[0].state).toBe('pending');
 });
 it('a reply stops the sequence and emails Derek once, with reminders at 1 and 3 business days until handled',async()=>{
  const {candidate,seat,step}=await setup('journey-reply','A','echo');
  await pool.query("UPDATE sdr_linkedin_candidates SET resolved_email='echo@bigc.example' WHERE id=$1",[candidate.id]);
  const refreshed=(await pool.query('SELECT revision FROM sdr_linkedin_candidates WHERE id=$1',[candidate.id])).rows[0];void refreshed;
  expect((await step(MON)).result.state).toBe('confirmed');
  seat.state.connected=true;await accept('journey-reply','echo',new Date(MON.getTime()+60*60_000));
  const dm1=await step(new Date(MON.getTime()+61*60_000));expect(dm1.result.state).toBe('confirmed');
  const pending=await queueLinkedinAction({pool,candidateId:candidate.id,campaignId:dm1.action.campaign_id,now:new Date(MON.getTime()+62*60_000)});expect(pending.state).toBe('pending');
  const replyAt=new Date(MON.getTime()+2*60*60_000);
  seat.getChat=async()=>({id:'chat-echo',account_id:'journey-reply',attendees_ids:['ACo-echo'],provider_id:'2-THREAD'});
  seat.listMessages=async()=>({complete:true,items:[{id:'dm-echo',is_sender:true,text:'M1'},{id:'reply-1',is_sender:false,text:'Sure, give me a call next week.'}]});
  await ingestLinkedinEvent(pool,{companyId:company,boundAccountId:'journey-reply',payload:{account_id:'journey-reply',event:'message_received',message_id:'reply-1',chat_id:'chat-echo',message:'Sure, give me a call next week.',sender:{attendee_provider_id:'ACo-echo'},account_info:{user_id:'ACo-sender'}},receivedAt:replyAt});
  expect((await pool.query('SELECT state FROM sdr_linkedin_actions WHERE id=$1',[pending.id])).rows[0].state).toBe('cancelled');
  const onInbound=createLinkedinInboundHandler({pool,client:seat,mode:'live',prospectHandler:createProspectInboundHandler({pool,client:seat,mode:'live',suggest:async()=>'Hey Pat, thanks. What number is best?'})});
  await processLinkedinEvents({pool,companyId:company,accountId:'journey-reply',onInbound});
  const alert=(await pool.query('SELECT * FROM sdr_linkedin_reply_alerts WHERE candidate_id=$1',[candidate.id])).rows[0];
  expect(alert).toMatchObject({state:'pending',reply_text:'Sure, give me a call next week.',suggested_answer:'Hey Pat, thanks. What number is best?',thread_url:'https://www.linkedin.com/messaging/thread/2-THREAD/',lane:'A'});
  // Gmail: the first send reaches Gmail but the receipt is lost; the retry finds it by Message-ID.
  const sent=[];let lose=true;
  const gmail={sendMail:async(token,mail)=>{sent.push(mail);if(lose){lose=false;throw new Error('socket hang up')}return {id:`gm-${sent.length}`}},listThreadPage:async(token,{query})=>({threads:sent.some(m=>query.includes(m.messageId))?[{id:'thread-found'}]:[]})};
  const drain=at=>drainReplyAlerts(pool,{gmail,getToken:async()=>'token',now:at,companyId:company,accountId:'journey-reply',enabled:true,from:'alerts@proswppp.co',to:'derek@proswppp.co'});
  expect(await drain(replyAt)).toMatchObject({failed:1});
  expect(await drain(new Date(replyAt.getTime()+60_000))).toMatchObject({reconciled:1,sent:0});
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({from:'alerts@proswppp.co',to:'derek@proswppp.co',subject:'LinkedIn reply: Pat echo (Big GC)',messageId:`<sdr-li-reply-${alert.id}@proswppp.co>`});
  expect(sent[0].bodyText).toContain('Sure, give me a call next week.');expect(sent[0].bodyText).toContain('Hey Pat, thanks. What number is best?');expect(sent[0].bodyText).toContain('https://www.linkedin.com/messaging/thread/2-THREAD/');expect(sent[0].bodyText).not.toMatch(/[—–]/);
  expect(await drain(new Date('2026-11-03T15:00:00Z'))).toMatchObject({reminders:0});
  expect(await drain(new Date('2026-11-03T18:00:00Z'))).toMatchObject({reminders:1});
  expect(sent.at(-1).subject).toBe('Reminder: LinkedIn reply: Pat echo (Big GC)');
  expect(await drain(new Date('2026-11-05T18:00:00Z'))).toMatchObject({reminders:1});
  expect(await drain(new Date('2026-11-09T18:00:00Z'))).toMatchObject({reminders:0});
  expect(sent).toHaveLength(3);
  expect(writes(seat)).toEqual(['invite','sendFirst']);
 });
 it('sends no reminder after Mark handled or after Derek answers in LinkedIn',async()=>{
  for(const how of ['handled','staff']){
   const {candidate,seat,step}=await setup(`journey-${how}`,'A',`fox${how}`);
   expect((await step(MON)).result.state).toBe('confirmed');
   seat.state.connected=true;await accept(`journey-${how}`,`fox${how}`,new Date(MON.getTime()+60*60_000));
   expect((await step(new Date(MON.getTime()+61*60_000))).result.state).toBe('confirmed');
   const replyAt=new Date(MON.getTime()+2*60*60_000);
   await ingestLinkedinEvent(pool,{companyId:company,boundAccountId:`journey-${how}`,payload:{account_id:`journey-${how}`,event:'message_received',message_id:`reply-${how}`,chat_id:`chat-fox${how}`,sender:{attendee_provider_id:`ACo-fox${how}`},account_info:{user_id:'ACo-sender'}},receivedAt:replyAt});
   await processLinkedinEvents({pool,companyId:company,accountId:`journey-${how}`,onInbound:createLinkedinInboundHandler({pool,client:seat,mode:'observe',prospectHandler:createProspectInboundHandler({pool,client:seat,mode:'observe'})})});
   const sent=[];const gmail={sendMail:async(t,mail)=>{sent.push(mail);return {id:'gm'}},listThreadPage:async()=>({threads:[]})};
   const drain=at=>drainReplyAlerts(pool,{gmail,getToken:async()=>'token',now:at,companyId:company,accountId:`journey-${how}`,enabled:true,from:'alerts@proswppp.co',to:'derek@proswppp.co'});
   expect(await drain(replyAt)).toMatchObject({sent:1});
   const alert=(await pool.query('SELECT id FROM sdr_linkedin_reply_alerts WHERE candidate_id=$1',[candidate.id])).rows[0];
   if(how==='handled')await markReplyAlertHandled(pool,{companyId:company,accountId:`journey-${how}`,alertId:alert.id,actor:'derek',viewer:{role:'admin',sub:'admin'}});
   else{await ingestLinkedinEvent(pool,{companyId:company,boundAccountId:`journey-${how}`,payload:{account_id:`journey-${how}`,event:'message_received',message_id:`staff-${how}`,chat_id:`chat-fox${how}`,sender:{attendee_provider_id:'ACo-sender'},account_info:{user_id:'ACo-sender'}},receivedAt:new Date(replyAt.getTime()+60_000)});}
   expect(await drain(new Date('2026-11-03T18:00:00Z'))).toMatchObject({reminders:0});
   expect(await drain(new Date('2026-11-05T18:00:00Z'))).toMatchObject({reminders:0});
   expect(sent,how).toHaveLength(1);
   expect((await pool.query('SELECT state FROM sdr_linkedin_reply_alerts WHERE id=$1',[alert.id])).rows[0].state,how).toBe('answered');
  }
 });
 it('refuses to email when the routing is unset or points at the prospect',async()=>{
  const {candidate}=await setup('journey-route','A','golf');
  await pool.query("UPDATE sdr_linkedin_candidates SET resolved_email='golf@bigc.example' WHERE id=$1",[candidate.id]);
  await pool.query("INSERT INTO sdr_linkedin_reply_alerts(company_id,account_id,candidate_id,source_message_id,reply_text,lane) VALUES($1,'journey-route',$2,'m-route','hi','A')",[company,candidate.id]);
  const gmail={sendMail:async()=>{throw new Error('must not send')},listThreadPage:async()=>({threads:[]})};
  expect(await drainReplyAlerts(pool,{gmail,getToken:async()=>'t',now:MON,companyId:company,accountId:'journey-route',enabled:true,from:'alerts@proswppp.co',to:'golf@bigc.example'})).toMatchObject({failed:1,sent:0});
  expect((await pool.query("SELECT state,failure_reason FROM sdr_linkedin_reply_alerts WHERE source_message_id='m-route'")).rows[0]).toEqual({state:'failed',failure_reason:'routing_unverified'});
  expect(await drainReplyAlerts(pool,{gmail,getToken:async()=>'t',now:MON,companyId:company,accountId:'journey-route',enabled:false})).toMatchObject({skipped:'disabled'});
 });
});

describe.skipIf(!pool)('ramp and restriction through the runtime',()=>{
 const seatFor=(accountId,{inviteResult}={})=>{const calls=[];return {calls,
  getAccount:async()=>({id:accountId,type:'LINKEDIN',sources:[{status:'OK'}]}),getSelf:async()=>({provider_id:'ACo-sender'}),
  getProfile:async({identifier})=>({provider_id:identifier,public_identifier:identifier.replace('ACo-',''),is_relationship:false}),
  findChats:async()=>({complete:true,items:[]}),listMessages:async()=>({complete:true,items:[]}),
  invite:async({providerId})=>{calls.push(providerId);return inviteResult||{outcome:'confirmed',providerId:`inv-${providerId}`}}}};
 let actionSeq=0;
 async function cohort(accountId,count,{rampStartedOn}){
  await insertAccount(pool,accountId,{rampStartedOn});
  const ids=[];
  for(let i=0;i<count;i++){const key=`${accountId}-${i}`;const c=await stageProspect(pool,{companyId:company,accountId,lane:'B',person:{firstName:'Pat',lastName:key,profileUrl:`https://www.linkedin.com/in/${key}/`,company:'Big GC',title:'Chief Estimator',stateCode:'TX',publicIdentifier:key,providerId:`ACo-${key}`,evidence:{source:'apify'}},facts,actor:'admin',ownerId:'owner',now:MON});ids.push(c.id)}
  const saved=await saveLinkedinCampaign({pool,companyId:company,accountId,actor:'admin',config:{lane:'B',budgets:{invite:15,dm:25,inmail:5,withdraw:20}},expiresAt:'2027-01-15T00:00:00Z',candidateIds:ids,now:MON});
  const campaign=await approveLinkedinCampaign({pool,companyId:company,accountId,actor:'admin',campaignId:saved.id,expectedRevision:saved.revision,now:MON});
  // Fixed action ids keep the jittered spacing reproducible.
  for(const id of ids){const c=(await pool.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1',[id])).rows[0];
   await pool.query(`INSERT INTO sdr_linkedin_actions(id,company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash) VALUES($1,$2,$3,$4,$5,$6,$7,'invite',$8,$9,$10)`,[`00000000-0000-4000-8000-${String(++actionSeq).padStart(12,'0')}`,company,accountId,id,c.person_id,campaign.id,campaign.revision,`invite-${id}`,MON,linkedinHash({candidateId:id,campaignId:campaign.id,revision:campaign.revision,ownerId:'owner',profileUrl:c.profile_url,body:null})]);}
  return campaign;
 }
 it('sends exactly 5 invites on day 1 of the ramp out of 6 due, spread across the window',async()=>{
  await cohort('ramp',6,{rampStartedOn:'2026-11-02'});
  const seat=seatFor('ramp');let time=new Date('2026-11-02T14:00:00Z');
  const runtime=startLinkedinRuntime({pool,client:seat,companyId:company,accountId:'ramp',mode:'live',readFreshContext:createLinkedinProspectFreshContext({pool,client:seat,customerCheck:noCustomer}),customerCheck:noCustomer,now:()=>time,scheduler:{setInterval:()=>1,clearInterval(){}}});
  await runtime.ready;
  const stamps=[];
  for(;time<new Date('2026-11-02T23:00:00Z');time=new Date(time.getTime()+5*60_000)){const before=seat.calls.length;await runtime.tick();if(seat.calls.length>before)stamps.push(time.getTime())}
  runtime.stop();
  expect(seat.calls).toHaveLength(5);
  expect(stamps).toHaveLength(5);
  for(let i=1;i<stamps.length;i++)expect(stamps[i]-stamps[i-1]).toBeGreaterThanOrEqual(0.7*108*60_000-5*60_000);
  expect((await pool.query("SELECT count(*)::int AS n FROM sdr_linkedin_actions WHERE account_id='ramp' AND state='pending' AND hold_reason IN ('budget_exhausted','invite_spacing')")).rows[0].n).toBe(1);
 });
 it('stamps the ramp start on the first live tick and audits it',async()=>{
  await cohort('ramp-start',1,{rampStartedOn:null});
  const seat=seatFor('ramp-start');const time=new Date('2026-11-04T15:00:00Z');
  const runtime=startLinkedinRuntime({pool,client:seat,companyId:company,accountId:'ramp-start',mode:'live',readFreshContext:createLinkedinProspectFreshContext({pool,client:seat,customerCheck:noCustomer}),customerCheck:noCustomer,now:()=>time,scheduler:{setInterval:()=>1,clearInterval(){}}});
  await runtime.ready;await runtime.tick();runtime.stop();
  const row=(await pool.query("SELECT to_char(ramp_started_on,'YYYY-MM-DD') AS d FROM sdr_linkedin_accounts WHERE account_id='ramp-start'")).rows[0];
  expect(row.d).toBe('2026-11-04');expect(seat.calls).toHaveLength(1);
  expect((await pool.query("SELECT action FROM sdr_linkedin_admin_audit WHERE account_id='ramp-start'")).rows.map(r=>r.action)).toContain('account.ramp_start');
 });
 it('restricts the account on a 401 invite and makes no further POST that tick',async()=>{
  await cohort('restricted',3,{rampStartedOn:'2026-10-01'});
  const seat=seatFor('restricted',{inviteResult:{outcome:'rejected',status:401,code:'errors/disconnected_account'}});const time=new Date('2026-11-04T15:00:00Z');
  const runtime=startLinkedinRuntime({pool,client:seat,companyId:company,accountId:'restricted',mode:'live',readFreshContext:createLinkedinProspectFreshContext({pool,client:seat,customerCheck:noCustomer}),customerCheck:noCustomer,now:()=>time,scheduler:{setInterval:()=>1,clearInterval(){}}});
  await runtime.ready;await runtime.tick();runtime.stop();
  expect(seat.calls).toHaveLength(1);
  expect((await pool.query("SELECT status FROM sdr_linkedin_accounts WHERE account_id='restricted'")).rows[0].status).toBe('restricted');
  expect((await pool.query("SELECT state FROM sdr_linkedin_actions WHERE account_id='restricted' AND provider_receipt IS NOT NULL")).rows.map(r=>r.state)).toEqual(['rejected']);
 });
});
