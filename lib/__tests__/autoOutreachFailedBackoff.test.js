import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
vi.mock('../sendRamp.js',async original=>({...await original(),mailboxBounceHealth:async()=>new Map()}));
vi.mock('../sdrDraftGenerator.js',()=>({buildDraftFromLead:vi.fn()}));
import {buildDraftFromLead} from '../sdrDraftGenerator.js';
import {runAutoOutreach,FAILED_DRAFT_BACKOFF_DAYS} from '../autoOutreach.js';
const db=reportingTestDb('auto_failed_backoff');
const owner='10000000-0000-0000-0000-000000000001';
const mailboxes=['20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002'];
// verdict: [status, days since verified, verified address (defaults to the current one)]
const lead=(id,score,verdict=['ok',1])=>db.pool.query(`INSERT INTO sdr_lead_state(pipedrive_lead_id,pipedrive_person_id,pipedrive_org_id,person_email,project_stage,trigger_type,outreach_status,lead_score,start_date,synced_at,crm_status,crm_company_id,email_verify_status,email_verified_at,email_verified_value)
 VALUES($1,'person','org',$2,'Bid','LBA','clear',$3,CURRENT_DATE+1,'2026-10-01','active','42',$4,NOW()-make_interval(days=>$5::int),$6)`,[id,`${id}@example.test`,score,verdict[0],verdict[1],verdict[2]===undefined?`${id}@example.test`:verdict[2]]);
const payload=args=>({pipedrive_lead_id:args.pipedriveLeadId,pipedrive_contact_id:'person',pipedrive_org_id:'org',contact_id_snapshot:'person',contact_email_snapshot:`${args.pipedriveLeadId}@example.test`,org_id_snapshot:'org',trigger_type:'LBA',apollo_sequence_id:'seq',subject:'Generated',body:'Body',assigned_mailbox_id:args.assignedMailboxId,assigned_user_id:args.assignedUserId,metadata:{}});
const run=(maxDrafts=1)=>runAutoOutreach(db.pool,{companyId:'42',mailboxSentToday:async()=>0,maxDrafts});
const generated=()=>buildDraftFromLead.mock.calls.map(([args])=>args.pipedriveLeadId);
describe.skipIf(!db)('failed-draft backoff is the same at selection and at insert',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_settings(id int,auto_outreach_enabled boolean,auto_outreach_mode text,auto_min_score float8,recontact_after_days int,start_date_grace_days int);
 CREATE TABLE sdr_mailboxes(id uuid,email text,owner_user_id uuid,warmup_started_at timestamptz,daily_send_limit int,active boolean,apollo_mailbox_id text);
 CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,pipedrive_org_id text,person_email text,project_stage text,trigger_override text,trigger_type text,outreach_status text,last_outgoing_mail_time timestamptz,lead_score float8,start_date date,synced_at timestamptz,crm_status text,crm_company_id text,email_verify_status text,email_verified_at timestamptz,email_verified_value text);
 CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,pipedrive_contact_id text,pipedrive_org_id text,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,trigger_type text,apollo_sequence_id text,subject text,body text,assigned_mailbox_id uuid,assigned_user_id uuid,initiated_by text,metadata jsonb,status text DEFAULT 'pending',created_at timestamptz DEFAULT NOW(),updated_at timestamptz,sent_at timestamptz,error_message text,reject_reason text,approved_at timestamptz,approved_by text);
 CREATE UNIQUE INDEX uq_open ON sdr_drafts(pipedrive_lead_id,trigger_type) WHERE status IN ('pending','approved','edited');
 CREATE TABLE sdr_sends(draft_id uuid,pipedrive_lead_id text);CREATE TABLE sdr_inbox_reply_log(gmail_message_id text PRIMARY KEY,from_addr text,created_at timestamptz DEFAULT NOW());CREATE TABLE sdr_message_facts(provider text,provider_message_id text,direction text,prospect_email text,human_reply boolean,occurred_at timestamptz);CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,sent_at timestamptz)`);
 for(const file of ['2026-10-07-sdr-draft-revisions.sql','2026-10-07-sdr-outreach-controls.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 });
 afterAll(()=>db.close());
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_inbox_reply_log,sdr_message_facts');await db.pool.query('TRUNCATE sdr_outreach_control_decisions,sdr_outreach_controls,sdr_draft_approvals,sdr_drafts,sdr_sends,sdr_outreach_log,sdr_lead_state,sdr_mailboxes,sdr_settings');await db.pool.query("INSERT INTO sdr_settings VALUES(1,true,'queue',NULL,NULL,0)");await db.pool.query('INSERT INTO sdr_mailboxes VALUES($1,\'one@example.test\',$3,NULL,1,true,\'p1\'),($2,\'two@example.test\',$3,NULL,1,true,\'p2\')',[...mailboxes,owner]);buildDraftFromLead.mockReset().mockImplementation(async args=>payload(args));});
 const failed=(id,days,error)=>db.pool.query(`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status,error_message,created_at) VALUES($1,'LBA','failed',$2,NOW()-make_interval(days=>$3::int))`,[id,error,days]);
 it('does not select a lead the in-lock check would refuse (Apollo in_other_campaigns failure, day 14-30)',async()=>{
  await lead('looping',100);await failed('looping',20,'Apollo did not enroll the contact: contacts_finished_in_other_campaigns');
  await lead('fresh',50);
  const result=await run(1);
  expect(result).toMatchObject({created:1,scanned:1,refused:0,errors:[]});
  expect(generated()).toEqual(['fresh']);
 });
 it('treats every failure the same and releases it after the shared window',async()=>{
  expect(FAILED_DRAFT_BACKOFF_DAYS).toBe(30);
  await lead('other',100);await failed('other',20,'Apollo returned 500');
  await lead('old',90);await failed('old',FAILED_DRAFT_BACKOFF_DAYS+1,'Apollo did not enroll the contact: contacts_finished_in_other_campaigns');
  const result=await run(2);
  expect(result).toMatchObject({created:1,refused:0,errors:[]});
  expect(generated()).toEqual(['old']);
 });
});
