// Regression tests for the second QA pass on PR #124 (findings N1 to N6).
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';
import {prospectSkipReason,stageProspect,stageMovedContact} from '../sdrLinkedinProspect.js';
import {queueLinkedinAction,dispatchLinkedinAction} from '../sdrLinkedinOperations.js';
import {saveLinkedinCampaign,approveLinkedinCampaign} from '../sdrLinkedinAdmin.js';
import {createLinkedinProspectFreshContext} from '../sdrLinkedinProspectFreshContext.js';
import {startLinkedinRuntime} from '../sdrLinkedinRuntime.js';
import {testPool,createProspectSchema,prospectConfig,insertAccount,insertCampaign,insertProspect,insertAction,fakeSeat,writes,MIGRATIONS} from './helpers/linkedinProspectFixture.js';

const {schema,pool}=testPool('linkedin_qa_fixes2',{skipWithoutDb:true});
const company='13105180',DAY=86_400_000,noCustomer=async()=>null;
const MON=new Date('2026-11-02T15:00:00Z');
beforeAll(async()=>{if(pool)await createProspectSchema(pool,schema)});
afterAll(async()=>{if(!pool)return;await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.query(`DROP SCHEMA IF EXISTS ${schema}_upgrade CASCADE`);await pool.end()});
const person=(key,extra={})=>({firstName:'Pat',lastName:key,profileUrl:`https://www.linkedin.com/in/${key}/`,company:'Big GC',title:'Director of Preconstruction',stateCode:'TX',publicIdentifier:key,providerId:`ACo-${key}`,evidence:{source:'apify',runId:'r'},...extra});
const actionsOf=async candidateId=>(await pool.query('SELECT step,state,hold_reason FROM sdr_linkedin_actions WHERE candidate_id=$1 ORDER BY created_at',[candidateId])).rows;

describe.skipIf(!pool)('N1. accent folding and whole-word surnames in the lead skip',()=>{
 const skip=p=>prospectSkipReason(pool,{companyId:company,person:{profileUrl:`https://www.linkedin.com/in/${p.key}/`,email:null,company:'Big GC',...p},lane:'A',now:MON,customerCheck:noCustomer});
 it('matches Muñoz written without the accent, and the other way round',async()=>{
  await pool.query("INSERT INTO sdr_lead_state(pipedrive_lead_id,person_name,trigger_type,crm_status) VALUES('acc1','Ana Muñoz','AGC','active'),('acc2','Jose Pena','LBA','active')");
  expect(await skip({key:'m1',firstName:'Ana',lastName:'Munoz'})).toBe('agc_lba_or_bid_invite');
  expect(await skip({key:'m2',firstName:'José',lastName:'Peña'})).toBe('agc_lba_or_bid_invite');
 });
 it('finds "Lee" behind 300 Kathleens and Ashleys, and does not match them',async()=>{
  await pool.query(`INSERT INTO sdr_lead_state(pipedrive_lead_id,person_name,trigger_type,crm_status) SELECT 'k'||n,'Kathleen Ashley'||n,'AGC','active' FROM generate_series(1,300) n`);
  await pool.query("INSERT INTO sdr_lead_state(pipedrive_lead_id,person_name,trigger_type,crm_status) VALUES('lee','Chris Lee, PE','AGC','active')");
  expect(await skip({key:'lee1',firstName:'Christopher',lastName:'Lee'})).toBe('agc_lba_or_bid_invite');
  expect(await skip({key:'lee2',firstName:'Ashley',lastName:'Lee'})).toBeNull();
 });
});

describe.skipIf(!pool)('N2. a missing InMail fact skips only the InMail',()=>{
 it('stages a lane B contact outside the served states, never sends the InMail, and withdraws at day 21',async()=>{
  await insertAccount(pool,'no-state',{rampStartedOn:'2026-10-01',inmailBalance:5});
  const staged=await stageMovedContact({pool,client:{getProfile:async()=>({provider_id:'ACo-dfw',public_identifier:'dfw',is_relationship:false})},companyId:company,accountId:'no-state',actor:'admin',ownerId:'owner',row:{id:null,full_name:'Pat Dfw',company:'Flintco',email:null},person:person('dfw',{stateCode:null}),states:['OK'],now:MON});
  expect(staged.staged).toBeTruthy();
  const saved=await saveLinkedinCampaign({pool,companyId:company,accountId:'no-state',actor:'admin',config:{lane:'B',budgets:{invite:15,dm:25,inmail:5,withdraw:20}},expiresAt:'2027-01-15T00:00:00Z',candidateIds:[staged.staged.candidateId],now:MON});
  const campaign=await approveLinkedinCampaign({pool,companyId:company,accountId:'no-state',actor:'admin',campaignId:saved.id,expectedRevision:saved.revision,now:MON});
  const id=staged.staged.candidateId,seat=fakeSeat({accountId:'no-state',providerId:'ACo-dfw',publicId:'dfw'});
  const fresh=createLinkedinProspectFreshContext({pool,client:seat,customerCheck:noCustomer});
  const invite=await queueLinkedinAction({pool,candidateId:id,campaignId:campaign.id,now:MON});
  expect((await dispatchLinkedinAction({pool,client:seat,actionId:invite.id,readFreshContext:fresh,mode:'live',now:MON,customerCheck:noCustomer})).state).toBe('confirmed');
  expect(await queueLinkedinAction({pool,candidateId:id,campaignId:campaign.id,now:new Date(MON.getTime()+15*DAY),inmailEnabled:true,withdrawEnabled:false})).toEqual({state:'held',reason:'pending_invite'});
  const withdraw=await queueLinkedinAction({pool,candidateId:id,campaignId:campaign.id,now:new Date(MON.getTime()+21*DAY),inmailEnabled:true,withdrawEnabled:true});
  expect(withdraw.step).toBe('withdraw');
  expect((await actionsOf(id)).map(a=>a.step)).toEqual(['invite','withdraw']);
 });
});

describe.skipIf(!pool)('N3. paused steps and review holds do not block the runtime',()=>{
 it('still sends an invite when a dozen InMails are paused for lack of credits',async()=>{
  await insertAccount(pool,'paused',{rampStartedOn:'2026-10-01',inmailBalance:0});
  const at=new Date('2026-11-04T15:00:00Z');
  const keys=Array.from({length:12},(_,i)=>`im-${i}`);
  const campaign=await insertCampaign(pool,'paused',prospectConfig({lane:'A',sourceIds:[...keys,'fresh']}));
  for(const key of keys){const c=await insertProspect(pool,'paused',key,{campaignId:campaign,state:'invite_sent'});await pool.query('UPDATE sdr_linkedin_candidates SET priority=1 WHERE id=$1',[c.id]);
   await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash,state,reserved_at,confirmed_at,provider_id) VALUES($1,'paused',$2,$3,$4,1,'invite',$5,$6,'h','confirmed',$6,$6,$7)`,[company,c.id,c.person_id,campaign,`inv-${key}`,new Date(at-15*DAY),`inv-${key}`]);
   await insertAction(pool,'paused',c,campaign,{step:'inmail',body:JSON.stringify({subject:'S',body:'B'})})}
  const freshPerson=await insertProspect(pool,'paused','fresh',{campaignId:campaign});await pool.query('UPDATE sdr_linkedin_candidates SET priority=9999 WHERE id=$1',[freshPerson.id]);
  const calls=[];
  const client={getAccount:async()=>({id:'paused',type:'LINKEDIN',sources:[{status:'OK'}]}),getSelf:async()=>({provider_id:'ACo-sender'}),
   getProfile:async({identifier})=>({provider_id:identifier,public_identifier:String(identifier).replace('ACo-',''),is_relationship:false}),
   findChats:async()=>({complete:true,items:[]}),listMessages:async()=>({complete:true,items:[]}),getInmailBalance:async()=>{calls.push('balance');return {sales_navigator:0}},
   invite:async({providerId})=>{calls.push(`invite:${providerId}`);return {outcome:'confirmed',providerId:`inv-${providerId}`}},sendInmail:async()=>{calls.push('inmail');return {outcome:'confirmed'}}};
  const runtime=startLinkedinRuntime({pool,client,companyId:company,accountId:'paused',mode:'live',inmailEnabled:true,withdrawEnabled:false,readFreshContext:createLinkedinProspectFreshContext({pool,client,customerCheck:noCustomer}),customerCheck:noCustomer,now:()=>at,scheduler:{setInterval:()=>1,clearInterval(){}}});
  await runtime.ready;await runtime.tick();runtime.stop();
  expect(calls).toContain('invite:ACo-fresh');expect(calls).not.toContain('inmail');
  expect((await pool.query("SELECT count(*)::int AS n FROM sdr_linkedin_actions WHERE account_id='paused' AND step='inmail' AND state='pending' AND hold_reason='inmail_credits_exhausted'")).rows[0].n).toBeGreaterThan(0);
 });
 it('holds a person who accepted after the InMail, so they leave the queue pass',async()=>{
  await insertAccount(pool,'review',{rampStartedOn:'2026-10-01'});
  const campaign=await insertCampaign(pool,'review',prospectConfig({lane:'A',sourceIds:['after']}));
  const c=await insertProspect(pool,'review','after',{campaignId:campaign,state:'invite_sent'});
  await insertAction(pool,'review',c,campaign,{step:'invite',state:'confirmed'});
  await insertAction(pool,'review',c,campaign,{step:'inmail',state:'confirmed',body:'{}'});
  await pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,provider_id,source_at,observed_at,coverage,payload_hash) VALUES($1,'review',$2,$3,'new_relation','fixture','ACo-after',now(),now(),'event','rel-after')`,[company,c.id,c.person_id]);
  expect(await queueLinkedinAction({pool,candidateId:c.id,campaignId:campaign,now:new Date('2026-11-04T15:00:00Z')})).toEqual({state:'held',reason:'accepted_after_inmail'});
  expect((await pool.query('SELECT state,hold_reason FROM sdr_linkedin_candidates WHERE id=$1',[c.id])).rows[0]).toEqual({state:'held',hold_reason:'accepted_after_inmail'});
 });
});

describe.skipIf(!pool)('N4. invite slots ignore pending invites that cannot go out',()=>{
 it('does not count pending invites of an unapproved campaign against today\'s budget',async()=>{
  await insertAccount(pool,'slots2',{rampStartedOn:'2026-11-02'});
  const draftKeys=['d1','d2','d3','d4','d5'];
  const draft=await insertCampaign(pool,'slots2',prospectConfig({lane:'A',sourceIds:draftKeys}),{status:'unapproved'});
  for(const key of draftKeys){const c=await insertProspect(pool,'slots2',key,{campaignId:draft});await insertAction(pool,'slots2',c,draft)}
  const live=await insertCampaign(pool,'slots2',prospectConfig({lane:'A',sourceIds:['go']}));
  const c=await insertProspect(pool,'slots2','go',{campaignId:live});
  expect((await queueLinkedinAction({pool,candidateId:c.id,campaignId:live,now:MON})).step).toBe('invite');
 });
});

describe.skipIf(!pool)('N5. the migration upgrades the first version of the reply alerts table',()=>{
 it('adds next_reminder_at, message_ids and the reminded state',async()=>{
  const s=`${schema}_upgrade`;
  await pool.query(`CREATE SCHEMA ${s}`);
  const db=await pool.connect();
  try{
   await db.query(`SET search_path=${s}`);
   for(const file of MIGRATIONS.slice(0,2))await db.query(await fs.readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8'));
   await db.query(`CREATE TABLE sdr_linkedin_reply_alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id text NOT NULL, account_id text NOT NULL,
    candidate_id uuid NOT NULL, source_message_id text NOT NULL, chat_id text, thread_url text,
    reply_text text NOT NULL, suggested_answer text, lane text,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','answered','dismissed','failed')),
    sent_at timestamptz, gmail_message_id text, reminder1_sent_at timestamptz, reminder3_sent_at timestamptz,
    answered_at timestamptz, answered_by text, failure_reason text,
    attempted_at timestamptz, reminder1_attempted_at timestamptz, reminder3_attempted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,account_id,source_message_id));
    INSERT INTO sdr_linkedin_reply_alerts(company_id,account_id,candidate_id,source_message_id,reply_text) VALUES('c','a',gen_random_uuid(),'old','hi')`);
   const migration=await fs.readFile(new URL(`../../migrations/${MIGRATIONS[2]}`,import.meta.url),'utf8');
   await db.query(migration);await db.query(migration);
   await db.query("UPDATE sdr_linkedin_reply_alerts SET state='reminded',next_reminder_at=NULL,message_ids=array_append(message_ids,'m2') WHERE source_message_id='old'");
   expect((await db.query("SELECT state,message_ids FROM sdr_linkedin_reply_alerts")).rows).toEqual([{state:'reminded',message_ids:['m2']}]);
   await expect(db.query("UPDATE sdr_linkedin_reply_alerts SET state='nonsense'")).rejects.toThrow();
  }finally{await db.query('RESET search_path');db.release()}
 });
});

describe.skipIf(!pool)('Final re-check 1. an accept overtakes a waiting InMail and M1 still follows',()=>{
 it('cancels the InMail when they accepted, and the runtime queues M1, also behind a held InMail',async()=>{
  await insertAccount(pool,'overtake',{rampStartedOn:'2026-10-01',inmailBalance:5});
  const at=new Date('2026-11-04T15:00:00Z');
  const campaign=await insertCampaign(pool,'overtake',prospectConfig({lane:'A',sourceIds:['ot1','ot2']}));
  const people=[];
  for(const key of ['ot1','ot2']){const c=await insertProspect(pool,'overtake',key,{campaignId:campaign,state:'invite_sent'});people.push(c);
   await pool.query(`INSERT INTO sdr_linkedin_actions(company_id,account_id,candidate_id,person_id,campaign_id,campaign_revision,step,operation_key,due_at,context_hash,state,reserved_at,confirmed_at,provider_id) VALUES($1,'overtake',$2,$3,$4,1,'invite',$5,$6,'h','confirmed',$6,$6,$7)`,[company,c.id,c.person_id,campaign,`inv-${key}`,new Date(at-15*DAY),`inv-${key}`]);
   await pool.query(`INSERT INTO sdr_linkedin_events(company_id,account_id,candidate_id,person_id,kind,source,provider_id,source_at,observed_at,coverage,payload_hash) VALUES($1,'overtake',$2,$3,'new_relation','fixture',$4,$5,$5,'event',$6)`,[company,c.id,c.person_id,`ACo-${key}`,new Date(at-30*60_000),`rel-${key}`])}
  // ot1: the InMail was queued before the accept, then reaches dispatch.
  const inmail=await insertAction(pool,'overtake',people[0],campaign,{step:'inmail',body:JSON.stringify({subject:'S',body:'B'})});
  const fresh=async()=>({allowed:false,reasons:['relationship_changed']});
  const calls=[];const sender=new Proxy({},{get:(_,name)=>name==='then'?undefined:async()=>{calls.push(String(name));return {sales_navigator:5}}});
  expect(await dispatchLinkedinAction({pool,client:sender,actionId:inmail.id,readFreshContext:fresh,mode:'live',now:at,inmailEnabled:true,customerCheck:noCustomer})).toEqual({state:'cancelled'});
  expect(calls.filter(c=>c!=='getInmailBalance')).toEqual([]);
  // ot2: an InMail already held as relationship_changed (before this fix) does not block M1 either.
  await insertAction(pool,'overtake',people[1],campaign,{step:'inmail',state:'held',body:'{}'});
  await pool.query("UPDATE sdr_linkedin_actions SET hold_reason='relationship_changed' WHERE candidate_id=$1 AND step='inmail'",[people[1].id]);
  const client={getAccount:async()=>({id:'overtake',type:'LINKEDIN',sources:[{status:'OK'}]}),getSelf:async()=>({provider_id:'ACo-sender'}),
   getProfile:async({identifier})=>({provider_id:identifier,public_identifier:String(identifier).replace('ACo-',''),is_relationship:true}),
   findChats:async()=>({complete:true,items:[]}),listMessages:async()=>({complete:true,items:[]}),sendFirst:async()=>({outcome:'confirmed',providerId:'dm',chatId:'chat'})};
  const runtime=startLinkedinRuntime({pool,client,companyId:company,accountId:'overtake',mode:'live',inmailEnabled:true,withdrawEnabled:false,readFreshContext:createLinkedinProspectFreshContext({pool,client,customerCheck:noCustomer}),customerCheck:noCustomer,now:()=>at,scheduler:{setInterval:()=>1,clearInterval(){}}});
  await runtime.ready;await runtime.tick();runtime.stop();
  for(const c of people)expect((await actionsOf(c.id)).map(a=>a.step)).toEqual(['invite','inmail','dm1']);
  expect((await actionsOf(people[0].id))[1]).toMatchObject({state:'cancelled',hold_reason:'relationship_changed'});
 });
});
