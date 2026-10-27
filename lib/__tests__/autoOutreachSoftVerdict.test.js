import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
vi.mock('../sendRamp.js',async original=>({...await original(),mailboxBounceHealth:async()=>new Map()}));
vi.mock('../sdrDraftGenerator.js',()=>({buildDraftFromLead:vi.fn()}));
vi.mock('../customerSuppression.js',()=>({isCustomerLead:vi.fn(async()=>null)}));
import {buildDraftFromLead} from '../sdrDraftGenerator.js';
import {runAutoOutreach,sendableVerdict} from '../autoOutreach.js';
import {sequenceBounceRates,softGuardState,softEnrolledToday} from '../softVerdictGuard.js';

// Ivan, 2026-10-27: automation also emails catch-all / unknown ("soft") addresses, at most
// soft_verdict_daily_cap a day (valid first, never capped), and not into a sequence whose
// 7-day bounce rate is 4% or more (Apollo paused PB at 8% and LBA at 6.5%).
const db=reportingTestDb('auto_soft_verdict');
const owner='10000000-0000-0000-0000-000000000001';
const mailbox='20000000-0000-0000-0000-000000000001';
const lead=(id,{score=50,verdict='soft',trigger='LBA',email=`${id}@example.test`,verifiedDays=3}={})=>db.pool.query(`INSERT INTO sdr_lead_state(pipedrive_lead_id,pipedrive_person_id,pipedrive_org_id,person_email,project_stage,trigger_type,outreach_status,lead_score,start_date,synced_at,crm_status,crm_company_id,email_verify_status,email_verified_at,email_verified_value)
 VALUES($1,$2,'org',$3,'Bid',$4,'clear',$5,CURRENT_DATE+1,'2026-10-01','active','42',$6,CASE WHEN $6::text IS NULL THEN NULL ELSE NOW()-make_interval(days=>$7::int) END,CASE WHEN $6::text IS NULL THEN NULL ELSE $3 END)`,[id,`person-${id}`,email,trigger,score,verdict,verifiedDays]);
// Apollo messages on a sequence in the last week: `sent` completed, `bounced` bounced after an attempt.
const traffic=async(seq,{sent,bounced})=>{
 for(let i=0;i<sent;i++)await db.pool.query(`INSERT INTO sdr_message_facts(provider,provider_message_id,direction,prospect_email,campaign_id,provider_status,bounce,occurred_at) VALUES('apollo',$1,'out',$2,$3,'completed',false,NOW()-interval '2 days')`,[`${seq}-s${i}`,`s${i}@x.test`,seq]);
 for(let i=0;i<bounced;i++)await db.pool.query(`INSERT INTO sdr_message_facts(provider,provider_message_id,direction,prospect_email,campaign_id,provider_status,bounce,occurred_at) VALUES('apollo',$1,'out',$2,$3,'failed',true,NOW()-interval '2 days')`,[`${seq}-b${i}`,`b${i}@x.test`,seq]);
};
const run=()=>runAutoOutreach(db.pool,{companyId:'42',mailboxSentToday:async()=>0,maxDrafts:20});
const generated=()=>buildDraftFromLead.mock.calls.map(([args])=>args.pipedriveLeadId);
const verdicts=async()=>Object.fromEntries((await db.pool.query("SELECT pipedrive_lead_id,metadata->>'email_verdict' v FROM sdr_drafts WHERE initiated_by='automatic'")).rows.map(r=>[r.pipedrive_lead_id,r.v]));

describe('soft verdicts in the automatic selector',()=>{
 it('accepts a fresh valid or soft verdict for the exact address, nothing else',()=>{
  const at=new Date();
  const row=(v,extra={})=>({email_verify_status:v,email_verified_at:at,email_verified_value:'a@b.co',...extra});
  expect(sendableVerdict(row('valid'),'a@b.co')).toBe('valid');
  for(const v of ['soft','catchall','catch_all','unknown'])expect(sendableVerdict(row(v),'a@b.co')).toBe('soft');
  for(const v of ['invalid','disposable','spamtrap','abuse','do_not_mail','hard_fail',null,'skipped'])expect(sendableVerdict(row(v),'a@b.co')).toBeNull();
  expect(sendableVerdict(row('soft'),'other@b.co')).toBeNull();
  expect(sendableVerdict(row('soft',{email_verified_at:new Date(Date.now()-91*86400000)}),'a@b.co')).toBeNull();
  expect(sendableVerdict({...row('soft'),email_verified_value:'na'},'na')).toBeNull();
 });
});

describe.skipIf(!db)('soft-verdict brakes (local Postgres)',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_settings(id int,auto_outreach_enabled boolean,auto_outreach_mode text,auto_min_score float8,recontact_after_days int,start_date_grace_days int,soft_verdict_daily_cap int);
 CREATE TABLE sdr_mailboxes(id uuid,email text,owner_user_id uuid,warmup_started_at timestamptz,daily_send_limit int,active boolean,apollo_mailbox_id text);
 CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,pipedrive_org_id text,person_email text,project_stage text,trigger_override text,trigger_type text,outreach_status text,last_outgoing_mail_time timestamptz,lead_score float8,start_date date,synced_at timestamptz,crm_status text,crm_company_id text,email_verify_status text,email_verified_at timestamptz,email_verified_value text,lead_origin text);
 CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,pipedrive_contact_id text,pipedrive_org_id text,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,trigger_type text,apollo_sequence_id text,subject text,body text,assigned_mailbox_id uuid,assigned_user_id uuid,initiated_by text,metadata jsonb,status text DEFAULT 'pending',created_at timestamptz DEFAULT NOW(),updated_at timestamptz,sent_at timestamptz,error_message text,reject_reason text,content_origin text);
 CREATE UNIQUE INDEX uq_open ON sdr_drafts(pipedrive_lead_id,trigger_type) WHERE status IN ('pending','approved','edited');
 CREATE TABLE sdr_sends(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),draft_id uuid,pipedrive_lead_id text,status text,step_status text,apollo_emailer_message_id text,apollo_contact_id text,apollo_sequence_id text,enrolled_person_id text,created_at timestamptz DEFAULT NOW());
 CREATE TABLE sdr_inbox_reply_log(gmail_message_id text PRIMARY KEY,from_addr text,created_at timestamptz DEFAULT NOW());
 CREATE TABLE sdr_message_facts(provider text,provider_message_id text,direction text,prospect_email text,campaign_id text,provider_status text,bounce boolean,spam_blocked boolean,human_reply boolean,occurred_at timestamptz,is_test boolean NOT NULL DEFAULT false);
 CREATE VIEW sdr_reporting_messages AS SELECT * FROM sdr_message_facts WHERE NOT is_test;
 CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,source text,sent_at timestamptz);
 CREATE TABLE sdr_engagement_events(pipedrive_lead_id text,event_type text);
 CREATE TABLE sdr_reply_messages(pipedrive_lead_id text,reply_kind text)`);
 for(const file of ['2026-10-07-sdr-draft-revisions.sql','2026-10-07-sdr-outreach-controls.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 });
 afterAll(async()=>{vi.unstubAllEnvs();await db.close();});
 beforeEach(async()=>{
  vi.stubEnv('APOLLO_SEQ_LBA','seq-lba');vi.stubEnv('APOLLO_SEQ_PB','seq-pb');
  await db.pool.query('TRUNCATE sdr_inbox_reply_log,sdr_message_facts,sdr_engagement_events,sdr_reply_messages,sdr_outreach_control_decisions,sdr_outreach_controls,sdr_draft_approvals,sdr_drafts,sdr_sends,sdr_outreach_log,sdr_lead_state,sdr_mailboxes,sdr_settings');
  await db.pool.query("INSERT INTO sdr_settings VALUES(1,true,'send',NULL,NULL,0,2)");
  await db.pool.query("INSERT INTO sdr_mailboxes VALUES($1,'one@example.test',$2,NULL,40,true,'p1')",[mailbox,owner]);
  buildDraftFromLead.mockReset().mockImplementation(async args=>{
   const row=(await db.pool.query('SELECT person_email,pipedrive_person_id,trigger_type FROM sdr_lead_state WHERE pipedrive_lead_id=$1',[args.pipedriveLeadId])).rows[0];
   return {pipedrive_lead_id:args.pipedriveLeadId,pipedrive_contact_id:row.pipedrive_person_id,pipedrive_org_id:'org',contact_id_snapshot:row.pipedrive_person_id,contact_email_snapshot:row.person_email,org_id_snapshot:'org',
    trigger_type:row.trigger_type,apollo_sequence_id:`seq-${row.trigger_type.toLowerCase()}`,subject:'s',body:'b',assigned_mailbox_id:args.assignedMailboxId,assigned_user_id:args.assignedUserId,metadata:{}};
  });
 });

 it('drafts valid first, then soft up to the daily cap; confident-bad and unverified never',async()=>{
  await lead('soft-high',{score:90});await lead('soft-mid',{score:80});await lead('soft-low',{score:70});
  await lead('valid-low',{score:10,verdict:'valid'});await lead('catchall-raw',{score:60,verdict:'catchall'});
  for(const v of ['invalid','disposable','spamtrap','hard_fail'])await lead(`bad-${v}`,{score:99,verdict:v});
  await lead('never',{score:99,verdict:null});
  const result=await run();
  expect(generated()).toEqual(['valid-low','soft-high','soft-mid']);
  expect(await verdicts()).toEqual({'valid-low':'valid','soft-high':'soft','soft-mid':'soft'});
  expect(result.soft).toMatchObject({guardAvailable:true,cap:2,drafted:2});
 });

 it('counts soft drafts and enrollments already made today against the cap; valid is never capped',async()=>{
  await db.pool.query(`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,initiated_by,metadata,status,contact_email_snapshot) VALUES('earlier','LBA','automatic','{"email_verdict":"soft"}','sent','e@x.test')`);
  await lead('soft-a',{score:90});await lead('soft-b',{score:80});
  for(let i=0;i<3;i++)await lead(`valid-${i}`,{score:i,verdict:'valid'});
  const result=await run();
  expect(generated().sort()).toEqual(['soft-a','valid-0','valid-1','valid-2']);
  expect(result.soft).toMatchObject({usedBefore:1,drafted:1});
  await db.pool.query("UPDATE sdr_settings SET soft_verdict_daily_cap=0");
  await db.pool.query("DELETE FROM sdr_drafts");buildDraftFromLead.mockClear();
  await run();
  expect(generated().sort()).toEqual(['valid-0','valid-1','valid-2']);
 });

 it('holds soft leads for a sequence bouncing 4% or more; valid leads and other sequences carry on',async()=>{
  await traffic('seq-lba',{sent:95,bounced:5});await traffic('seq-pb',{sent:97,bounced:3});
  expect((await sequenceBounceRates(db.pool)).map(r=>[r.sequenceId,r.paused]).sort()).toEqual([['seq-lba',true],['seq-pb',false]]);
  await lead('soft-lba',{score:90});await lead('valid-lba',{score:10,verdict:'valid'});await lead('soft-pb',{score:80,trigger:'PB'});
  const result=await run();
  expect(generated().sort()).toEqual(['soft-pb','valid-lba']);
  expect(result.soft).toMatchObject({pausedBounce:1,bouncingSequences:[{sequenceId:'seq-lba',rate:5}]});
 });

 it('a pre-send refusal is not an attempted send, and test traffic is ignored',async()=>{
  await traffic('seq-lba',{sent:20,bounced:0});
  await db.pool.query("INSERT INTO sdr_message_facts(provider,provider_message_id,direction,prospect_email,campaign_id,provider_status,bounce,occurred_at) VALUES('apollo','refused','out','r@x.test','seq-lba','failed',true,NULL)");
  await db.pool.query("INSERT INTO sdr_message_facts(provider,provider_message_id,direction,prospect_email,campaign_id,provider_status,bounce,occurred_at,is_test) VALUES('apollo','test','out','t@x.test','seq-lba','failed',true,NOW(),true)");
  expect(await sequenceBounceRates(db.pool)).toEqual([{sequenceId:'seq-lba',bounced:0,attempted:20,rate:0,paused:false}]);
 });

 it('counts soft enrollments of the current day, including older drafts whose address verdict is soft',async()=>{
  await lead('old-draft');
  const d=(await db.pool.query(`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,initiated_by,metadata,status,contact_email_snapshot) VALUES('old-draft','LBA','automatic','{}','sent','old-draft@example.test') RETURNING id`)).rows[0].id;
  await db.pool.query("INSERT INTO sdr_sends(draft_id,pipedrive_lead_id,status) VALUES($1,'old-draft','enrolled')",[d]);
  expect(await softEnrolledToday(db.pool)).toBe(1);
  expect(await softGuardState(db.pool,{soft_verdict_daily_cap:1})).toMatchObject({available:true,cap:1,remaining:0});
 });

 it('a soft draft whose marker was lost still counts against the drafting quota',async()=>{
  await lead('unmarked');
  await db.pool.query(`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,initiated_by,metadata,status,contact_email_snapshot) VALUES('unmarked','LBA','automatic','{}','pending','unmarked@example.test')`);
  expect(await softGuardState(db.pool,{soft_verdict_daily_cap:1})).toMatchObject({available:true,used:1,remaining:0});
 });
 it('drafts no soft lead when the bounce data cannot be read',async()=>{
  await db.pool.query('ALTER VIEW sdr_reporting_messages RENAME TO sdr_reporting_messages_off');
  try {
   await lead('soft-only',{score:90});await lead('valid-only',{score:1,verdict:'valid'});
   const result=await run();
   expect(generated()).toEqual(['valid-only']);
   expect(result.soft).toMatchObject({guardAvailable:false});
  } finally { await db.pool.query('ALTER VIEW sdr_reporting_messages_off RENAME TO sdr_reporting_messages'); }
 });
});
