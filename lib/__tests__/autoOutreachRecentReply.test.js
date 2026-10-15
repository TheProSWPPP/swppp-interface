import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
vi.mock('../sendRamp.js',async original=>({...await original(),mailboxBounceHealth:async()=>new Map()}));
vi.mock('../sdrDraftGenerator.js',()=>({buildDraftFromLead:vi.fn()}));
import {buildDraftFromLead} from '../sdrDraftGenerator.js';
import {runAutoOutreach} from '../autoOutreach.js';
const db=reportingTestDb('auto_recent_reply');
const owner='10000000-0000-0000-0000-000000000001';
const mailboxes=['20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002'];
// Seeded with a fresh valid verdict for the current address; automatic drafting requires one.
const lead=(id,score=100,synced='2026-10-01')=>db.pool.query(`INSERT INTO sdr_lead_state(pipedrive_lead_id,pipedrive_person_id,pipedrive_org_id,person_email,project_stage,trigger_type,outreach_status,lead_score,start_date,synced_at,crm_status,crm_company_id,email_verify_status,email_verified_at,email_verified_value) VALUES($1,'person','org',$2,'Bid','LBA','clear',$3,CURRENT_DATE+1,$4,'active','42','ok',NOW(),$2)`,[id,`${id}@example.test`,score,synced]);
const payload=args=>({pipedrive_lead_id:args.pipedriveLeadId,pipedrive_contact_id:'person',pipedrive_org_id:'org',contact_id_snapshot:'person',contact_email_snapshot:`${args.pipedriveLeadId}@example.test`,org_id_snapshot:'org',trigger_type:'LBA',apollo_sequence_id:'seq',subject:'Generated',body:'Body',assigned_mailbox_id:args.assignedMailboxId,assigned_user_id:args.assignedUserId,metadata:{}});
const run=(maxDrafts=1)=>runAutoOutreach(db.pool,{companyId:'42',mailboxSentToday:async()=>0,maxDrafts});
describe.skipIf(!db)('no automatic cold outreach to someone who recently replied',()=>{
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
 const reply=(id,from,daysAgo=10)=>db.pool.query(`INSERT INTO sdr_inbox_reply_log VALUES($1,$2,NOW()-make_interval(days=>$3::int))`,[id,from,daysAgo]);
 it('skips a lead whose contact replied on another project and fills the slot with the next lead',async()=>{
  await lead('a');await lead('b',90);await reply('m1','Bill Deluca <A@example.test>');
  expect(await run()).toMatchObject({created:1});
  expect(buildDraftFromLead.mock.calls.map(([args])=>args.pipedriveLeadId)).toEqual(['b']);
 });
 it('counts a human reply recorded in message facts',async()=>{
  await lead('a');await lead('b',90);
  await db.pool.query("INSERT INTO sdr_message_facts VALUES('gmail','x','in','a@example.test',true,NOW()-INTERVAL '3 days')");
  await run();
  expect(buildDraftFromLead.mock.calls.map(([args])=>args.pipedriveLeadId)).toEqual(['b']);
 });
 it.each([
  ['a bounce',()=>reply('m1','[bounce] mailer-daemon <a@example.test>')],
  ['an auto-reply',()=>reply('m1','[auto-reply] a@example.test')],
  ['a reply older than six months',()=>reply('m1','a@example.test',181)],
  ['a fact that is not a human reply',()=>db.pool.query("INSERT INTO sdr_message_facts VALUES('gmail','x','in','a@example.test',false,NOW())")],
 ])('still drafts after %s',async(_,seed)=>{
  await lead('a');await seed();
  expect(await run()).toMatchObject({created:1});
  expect(buildDraftFromLead.mock.calls.map(([args])=>args.pipedriveLeadId)).toEqual(['a']);
 });
 it('refuses a generated draft whose recipient replied even when the lead email did not',async()=>{
  await lead('a');await lead('b',90);await reply('m1','someone.else@example.test');
  buildDraftFromLead.mockImplementation(async args=>({...payload(args),contact_email_snapshot:args.pipedriveLeadId==='a'?'Someone.Else@example.test':payload(args).contact_email_snapshot}));
  const result=await run();
  expect(result).toMatchObject({created:1,refused:1});
  expect(result.errors).toEqual([{lead:'a',error:'recent_reply_staff_owned'}]);
  expect((await db.pool.query('SELECT pipedrive_lead_id FROM sdr_drafts')).rows).toEqual([{pipedrive_lead_id:'b'}]);
 });
});
