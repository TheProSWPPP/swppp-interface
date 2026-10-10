import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {approveAndSendPermitDraft,sendPermitToOperator} from '../permitDrafts.js';
import {setOutreachControl} from '../sdrOutreachControls.js';
import * as apollo from '../apolloClient.js';
vi.mock('../apolloClient.js',()=>({matchContactByEmail:vi.fn(),getContact:vi.fn(),updateContactCustomFields:vi.fn(),addContactsToSequence:vi.fn()}));
vi.mock('../sendRamp.js',()=>({dailyCap:()=>100,mailboxBounceHealth:async()=>new Map()}));
const db=reportingTestDb('permit_provider');
const mailbox={id:'mailbox',email:'rep@example.test',apollo_mailbox_id:'sender',permit_enabled:true,daily_send_limit:100};
const op={operator_key:'operator',operator_name:'Synthetic Facility',email:'recipient@example.test'};
const tpl={apollo_sequence_id:'permit-campaign',subject:'Synthetic subject',body_html:'Synthetic body'};
describe.skipIf(!db)('permit writers share SDR provider protections',()=>{
 beforeAll(async()=>{
  await db.setup();
  await db.pool.query(`CREATE TABLE sdr_sends(id text,pipedrive_lead_id text,apollo_contact_id text,apollo_sequence_id text,status text,mailbox_id text,sent_at timestamptz);
  CREATE TABLE permit_sends(id bigserial,operator_key text,apollo_contact_id text,apollo_sequence_id text,mailbox_id text,status text,draft_id text,sent_at timestamptz DEFAULT now());
  CREATE TABLE sdr_settings(id int,contact_cooldown_days int);INSERT INTO sdr_settings VALUES(1,14);CREATE TABLE sdr_message_facts(provider text,direction text,provider_status text,prospect_email text,occurred_at timestamptz);
  CREATE TABLE permit_outreach(operator_key text,status text,channel text,note text);
  CREATE TABLE permit_engine_settings(id int,active bool);
  CREATE TABLE sdr_mailboxes(id text,email text,apollo_mailbox_id text,permit_enabled bool,warmup_started_at timestamptz,daily_send_limit int);
  CREATE TABLE permit_drafts(id text,operator_key text,email text,subject text,body text,apollo_sequence_id text,assigned_mailbox_id text,status text,approved_at timestamptz,sent_at timestamptz,updated_at timestamptz,apollo_contact_id text,reject_reason text);`);
  for (const name of ['sdr-provider-operations','sdr-outreach-controls']) await db.pool.query(await readFile(new URL(`../../migrations/2026-10-07-${name}.sql`,import.meta.url),'utf8'));
  await db.pool.query(await readFile(new URL('../../migrations/2026-10-10-sdr-enrollment-phases.sql',import.meta.url),'utf8'));
 });
 afterAll(async()=>await db.close());
 afterEach(()=>vi.unstubAllEnvs());
 beforeEach(async()=>{
  vi.clearAllMocks();vi.stubEnv('APOLLO_API_KEY','synthetic');vi.stubEnv('SDR_CRM_COMPANY_ID','company');
  apollo.matchContactByEmail.mockResolvedValue({id:'contact'});apollo.getContact.mockResolvedValue({id:'contact',contact_campaign_statuses:[]});apollo.addContactsToSequence.mockResolvedValue({contacts:[{id:'contact'}]});
  await db.pool.query(`TRUNCATE sdr_sends,permit_sends,permit_outreach,permit_engine_settings,sdr_mailboxes,permit_drafts,sdr_provider_membership_observations,sdr_provider_operations,sdr_outreach_control_decisions,sdr_outreach_controls;
  INSERT INTO permit_engine_settings VALUES(1,true); INSERT INTO sdr_mailboxes VALUES('mailbox','rep@example.test','sender',true,NULL,100);
  INSERT INTO permit_drafts(id,operator_key,email,subject,body,apollo_sequence_id,assigned_mailbox_id,status,updated_at) VALUES('draft','operator','recipient@example.test','subject','body','permit-campaign','mailbox','approved',now());`);
 });
 for(const mode of ['manual','automatic']) {
  const send=()=>mode==='manual'?approveAndSendPermitDraft(db.pool,'draft'):sendPermitToOperator(db.pool,op,mailbox,tpl);
  it(`${mode}: accepted contact response stays unresolved without a generation receipt`,async()=>{
   await send();
   expect((await db.pool.query('SELECT state,reason FROM sdr_provider_operations')).rows).toEqual([{state:'unresolved',reason:'accepted_generation_unverified'}]);
   expect(apollo.updateContactCustomFields).toHaveBeenCalledTimes(1);
  });
  it(`${mode}: a paused shared SDR campaign blocks permit copy and enrollment`,async()=>{
   apollo.getContact.mockResolvedValue({id:'contact',contact_campaign_statuses:[{emailer_campaign_id:'sdr-campaign',status:'paused'}]});
   await expect(send()).rejects.toMatchObject({code:'external_membership_requires_review'});
   expect(apollo.updateContactCustomFields).not.toHaveBeenCalled();expect(apollo.addContactsToSequence).not.toHaveBeenCalled();
  });
  it(`${mode}: global recipient hold blocks permit writes`,async()=>{
   await setOutreachControl(db.pool,{companyId:'company',leadId:null,scope:{kind:'recipient',id:op.email},channel:'email',reason:'recipient restriction',contextHash:'hash',actor:{accountId:'rep'}});
   await expect(send()).rejects.toMatchObject({code:'outreach_held'});
   expect(apollo.updateContactCustomFields).not.toHaveBeenCalled();expect(apollo.addContactsToSequence).not.toHaveBeenCalled();
  });
  it(`${mode}: unexplained removal of an earlier permit enrollment never restarts`,async()=>{
   await db.pool.query("INSERT INTO permit_sends(operator_key,apollo_contact_id,apollo_sequence_id,status) VALUES('earlier-project','contact','old','enrolled')");
   await expect(send()).rejects.toMatchObject({code:'external_membership_requires_review'});
   expect(apollo.updateContactCustomFields).not.toHaveBeenCalled();
  });
 }
});
