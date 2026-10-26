import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
vi.mock('../sendRamp.js',async original=>({...await original(),mailboxBounceHealth:async()=>new Map()}));
vi.mock('../sdrDraftGenerator.js',()=>({buildDraftFromLead:vi.fn()}));
import {buildDraftFromLead} from '../sdrDraftGenerator.js';
import {runAutoOutreach} from '../autoOutreach.js';
import {isBidInviteOrigin} from '../bidInviteGuard.js';

describe('bid invite origin',()=>{
 it.each(['Bid Invite','Bid Invite: BuildingConnected',' bid invite: iSQFT'])('matches %j',value=>expect(isBidInviteOrigin(value)).toBe(true));
 it.each([null,undefined,'','CMD','Website','Invite Bid'])('does not match %j',value=>expect(isBidInviteOrigin(value)).toBe(false));
});

const db=reportingTestDb('auto_bid_invite');const user='10000000-0000-0000-0000-000000000001';
const payload={pipedrive_lead_id:'lead',pipedrive_contact_id:'person',pipedrive_org_id:'org',contact_id_snapshot:'person',contact_email_snapshot:'buyer@example.test',org_id_snapshot:'org',trigger_type:'CM',apollo_sequence_id:'seq',subject:'Generated',body:'Generated body',assigned_mailbox_id:user,assigned_user_id:user,metadata:{project_stage:'CM'}};
describe.skipIf(!db)('automatic outreach never enrolls bid-tracker contacts (Postgres)',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_settings(id int,auto_outreach_enabled boolean,auto_outreach_mode text,auto_min_score float8,recontact_after_days int,start_date_grace_days int);
 CREATE TABLE sdr_mailboxes(id uuid,email text,owner_user_id uuid,warmup_started_at timestamptz,daily_send_limit int,active boolean,apollo_mailbox_id text);
 CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,pipedrive_org_id text,person_email text,project_stage text,trigger_override text,trigger_type text,outreach_status text,last_outgoing_mail_time timestamptz,lead_score float8,start_date date,synced_at timestamptz,crm_status text,crm_company_id text,email_verify_status text,email_verified_at timestamptz,email_verified_value text,lead_origin text);
 CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,pipedrive_contact_id text,pipedrive_org_id text,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,trigger_type text,apollo_sequence_id text,subject text,body text,assigned_mailbox_id uuid,assigned_user_id uuid,initiated_by text,metadata jsonb,status text DEFAULT 'pending',created_at timestamptz DEFAULT NOW(),updated_at timestamptz,sent_at timestamptz,error_message text,reject_reason text,approved_at timestamptz,approved_by text);
 CREATE UNIQUE INDEX uq_open ON sdr_drafts(pipedrive_lead_id,trigger_type) WHERE status IN ('pending','approved','edited');
 CREATE TABLE sdr_sends(draft_id uuid,pipedrive_lead_id text);CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,sent_at timestamptz)`);
 for(const file of ['2026-10-07-sdr-draft-revisions.sql','2026-10-07-sdr-outreach-controls.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 });
 afterAll(()=>db.close());
 const seed=(origin,start='CURRENT_DATE+1')=>db.pool.query(`INSERT INTO sdr_lead_state VALUES('lead','person','org','buyer@example.test','CM',NULL,'CM','clear',NULL,50,${start},NOW(),'active','42','ok',NOW(),'buyer@example.test',$1)`,[origin]);
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_outreach_control_decisions,sdr_outreach_controls,sdr_draft_approvals,sdr_drafts,sdr_sends,sdr_outreach_log,sdr_lead_state,sdr_mailboxes,sdr_settings');await db.pool.query(`INSERT INTO sdr_settings VALUES(1,true,'queue',NULL,NULL,0);INSERT INTO sdr_mailboxes VALUES('${user}','sender@example.test','${user}',NULL,5,true,'provider')`);});
 const run=build=>{buildDraftFromLead.mockImplementation(build||(async()=>payload));return runAutoOutreach(db.pool,{companyId:'42',mailboxSentToday:async()=>0});};
 it('still drafts an ordinary CMD lead',async()=>{await seed('CMD');expect(await run()).toMatchObject({created:1});});
 it.each(['Bid Invite','Bid Invite: BuildingConnected'])('skips %j even with a future start date',async origin=>{await seed(origin);const build=vi.fn(async()=>payload);expect(await run(build)).toMatchObject({created:0});expect(build).not.toHaveBeenCalled();});
 it('rechecks the origin inside the lock when a sync marks the lead during generation',async()=>{await seed('CMD');
  expect(await run(async()=>{await db.pool.query("UPDATE sdr_lead_state SET lead_origin='Bid Invite: iSQFT'");return payload;})).toMatchObject({created:0});
  expect((await db.pool.query('SELECT * FROM sdr_drafts')).rows).toEqual([]);});
 const second=(id,{person='person',email='buyer@example.test',origin='CMD',crm='active'}={})=>db.pool.query(`INSERT INTO sdr_lead_state VALUES($1,$2,'org',$3,'CM',NULL,'CM','clear',NULL,40,CURRENT_DATE+30,NOW(),$5,'42','ok',NOW(),$3,$4)`,[id,person,email,origin,crm]);
 it.each([['the same Pipedrive person',{email:'other@example.test'}],['the same address under another person',{person:'person-2'}]])('does not enroll %s through a cold lead while they are on an open bid-sheet lead',async(_,who)=>{
  await second('bidlead',{origin:'Bid Invite: BuildingConnected'});
  await second('cmdlead',who);
  const build=vi.fn(async({pipedriveLeadId})=>({...payload,pipedrive_lead_id:pipedriveLeadId,contact_email_snapshot:who.email||payload.contact_email_snapshot}));
  expect(await run(build)).toMatchObject({created:0});
  expect(build).not.toHaveBeenCalled();
  expect((await db.pool.query('SELECT * FROM sdr_drafts')).rows).toEqual([]);
 });
 it('enrolls the person again once their bid-sheet lead is archived',async()=>{
  await second('bidlead',{origin:'Bid Invite',crm:'archived'});
  await second('cmdlead');
  expect(await run(async({pipedriveLeadId})=>({...payload,pipedrive_lead_id:pipedriveLeadId}))).toMatchObject({created:1});
 });
 it('rechecks the person inside the lock when a bid-sheet lead for them arrives during generation',async()=>{
  await second('cmdlead');
  expect(await run(async({pipedriveLeadId})=>{await second('bidlead',{person:'person-9',origin:'Bid Invite: iSQFT'});return {...payload,pipedrive_lead_id:pipedriveLeadId};})).toMatchObject({created:0,errors:[{lead:'cmdlead',error:'bid_invite_warm_lead'}]});
  expect((await db.pool.query('SELECT * FROM sdr_drafts')).rows).toEqual([]);
 });
});
