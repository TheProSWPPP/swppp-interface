import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
vi.mock('../sendRamp.js',async original=>({...await original(),mailboxBounceHealth:async()=>new Map()}));
vi.mock('../sdrDraftGenerator.js',()=>({buildDraftFromLead:vi.fn()}));
import {buildDraftFromLead} from '../sdrDraftGenerator.js';
import {runAutoOutreach,pruneStaleQueuedDrafts,expireStaleQueuedDrafts} from '../autoOutreach.js';
const db=reportingTestDb('auto_protection');const user='10000000-0000-0000-0000-000000000001';
const payload={pipedrive_lead_id:'lead',pipedrive_contact_id:'person',pipedrive_org_id:'org',contact_id_snapshot:'person',contact_email_snapshot:'buyer@example.test',org_id_snapshot:'org',trigger_type:'LBA',apollo_sequence_id:'seq',subject:'Generated',body:'Generated body',assigned_mailbox_id:user,assigned_user_id:user,metadata:{project_stage:'Bid'}};
describe.skipIf(!db)('automatic generation protects manual decisions (Postgres)',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_settings(id int,auto_outreach_enabled boolean,auto_outreach_mode text,auto_min_score float8,recontact_after_days int,start_date_grace_days int);
 CREATE TABLE sdr_mailboxes(id uuid,email text,owner_user_id uuid,warmup_started_at timestamptz,daily_send_limit int,active boolean,apollo_mailbox_id text);
 CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,pipedrive_org_id text,person_email text,project_stage text,trigger_override text,trigger_type text,outreach_status text,last_outgoing_mail_time timestamptz,lead_score float8,start_date date,synced_at timestamptz,crm_status text,crm_company_id text);
 CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,pipedrive_contact_id text,pipedrive_org_id text,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,trigger_type text,apollo_sequence_id text,subject text,body text,assigned_mailbox_id uuid,assigned_user_id uuid,initiated_by text,metadata jsonb,status text DEFAULT 'pending',created_at timestamptz DEFAULT NOW(),updated_at timestamptz,sent_at timestamptz,error_message text,reject_reason text,approved_at timestamptz,approved_by text);
 CREATE UNIQUE INDEX uq_open ON sdr_drafts(pipedrive_lead_id,trigger_type) WHERE status IN ('pending','approved','edited');
 CREATE TABLE sdr_sends(draft_id uuid,pipedrive_lead_id text);CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,sent_at timestamptz)`);
 for(const file of ['2026-10-07-sdr-draft-revisions.sql','2026-10-07-sdr-outreach-controls.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 });
 afterAll(()=>db.close());
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_outreach_control_decisions,sdr_outreach_controls,sdr_draft_approvals,sdr_drafts,sdr_sends,sdr_outreach_log,sdr_lead_state,sdr_mailboxes,sdr_settings');await db.pool.query(`INSERT INTO sdr_settings VALUES(1,true,'queue',NULL,NULL,0);INSERT INTO sdr_mailboxes VALUES('${user}','sender@example.test','${user}',NULL,5,true,'provider');INSERT INTO sdr_lead_state VALUES('lead','person','org','buyer@example.test','Bid',NULL,'LBA','clear',NULL,100,CURRENT_DATE+1,NOW(),'active','42')`);});
 const run=build=>{buildDraftFromLead.mockImplementation(build|| (async()=>payload));return runAutoOutreach(db.pool,{companyId:'42',mailboxSentToday:async()=>0});};
 const hold=async(kind='lead',scope='lead',channel='email')=>db.pool.query(`INSERT INTO sdr_outreach_controls(company_id,lead_id,scope_kind,scope_id,channel,reason,context_hash,actor,owner_id) VALUES('42','lead',$1,$2,$3,'Staff hold','hash','{}','rep')`,[kind,scope,channel]);
 it('still generates one legitimate initial draft',async()=>{expect(await run()).toMatchObject({created:1});expect((await db.pool.query('SELECT content_origin FROM sdr_drafts')).rows[0]).toEqual({content_origin:'machine'});});
 it('does not generate from another explicitly scoped company',async()=>{await db.pool.query("UPDATE sdr_lead_state SET crm_company_id='other'");const build=vi.fn(async()=>payload);expect(await run(build)).toMatchObject({created:0});expect(build).not.toHaveBeenCalled();});
 it('does not recreate an old rejected draft after a CRM edit',async()=>{
  await db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status,created_at,content_origin) VALUES('lead','PB','rejected',NOW()-INTERVAL '90 days','interactive')");
  const build=vi.fn(async()=>payload);expect(await run(build)).toMatchObject({created:0});expect(build).not.toHaveBeenCalled();
 });
 it.each([['lead','lead','email'],['recipient','buyer@example.test','email'],['service','unknown-service','email']])('does not generate across active %s restrictions',async(kind,scope,channel)=>{
  await hold(kind,scope,channel);const build=vi.fn(async()=>payload);expect(await run(build)).toMatchObject({created:0});expect(build).not.toHaveBeenCalled();
 });
 it('keeps call-only and unrelated draft restrictions scoped',async()=>{await hold('channel','calls','calls');await hold('draft','old-unrelated-draft','email');expect(await run()).toMatchObject({created:1});});
 it('rechecks a hold saved while generation was waiting',async()=>{expect(await run(async()=>{await hold();return payload;})).toMatchObject({created:0});expect((await db.pool.query('SELECT * FROM sdr_drafts')).rows).toEqual([]);});
 it('rechecks manual rejection while generation was waiting',async()=>{expect(await run(async()=>{await db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status,content_origin) VALUES('lead','PB','rejected','interactive')");return payload;})).toMatchObject({created:0});expect((await db.pool.query('SELECT status FROM sdr_drafts')).rows).toEqual([{status:'rejected'}]);});
 it('does not generate over a contact reassignment during the remote read',async()=>{expect(await run(async()=>{await db.pool.query("UPDATE sdr_lead_state SET pipedrive_person_id='other' WHERE pipedrive_lead_id='lead'");return payload;})).toMatchObject({created:0});});
 it('pruning preserves a held pending draft while expiring an unreviewed unheld draft',async()=>{
  await db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status,content_origin,created_at) VALUES('lead','LBA','pending','machine',NOW()-INTERVAL '30 days')");
  await hold();expect(await expireStaleQueuedDrafts(db.pool,{companyId:'42'})).toBe(0);
  await db.pool.query("UPDATE sdr_outreach_controls SET status='released'");expect(await expireStaleQueuedDrafts(db.pool,{companyId:'42'})).toBe(1);
 });
 it('pruning preserves a reviewed pending machine draft with an approval receipt',async()=>{
  const row=(await db.pool.query(`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,subject,body,status,content_origin,created_at) VALUES('lead','LBA','Reviewed','Reviewed','pending','machine',NOW()-INTERVAL '30 days') RETURNING *`)).rows[0];
  await db.pool.query("INSERT INTO sdr_draft_approvals(draft_id,revision,context_hash,subject,body,context,actor) VALUES($1,$2,'hash','Reviewed','Reviewed','{}','{}')",[row.id,row.revision]);
  await db.pool.query("UPDATE sdr_lead_state SET last_outgoing_mail_time=NOW() WHERE pipedrive_lead_id='lead'");
  expect(await pruneStaleQueuedDrafts(db.pool,{companyId:'42'})).toBe(0);expect(await expireStaleQueuedDrafts(db.pool,{companyId:'42'})).toBe(0);
 });
});
