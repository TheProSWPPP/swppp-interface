import express from 'express';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
import {ownerScope,withLeadLock} from '../sdrAccess.js';
import {checkViewedDraft,checkDraftSchedule,draftContextHash,draftConflict,recordDraftApproval,checkApprovedDraft,serializeDraft,mutateViewedDraft} from '../sdrDraftRevision.js';
import {withProviderContactLock,reserveEnrollment,advanceEnrollmentPhase,recordPreAddRefusal,recordEnrollmentReceipt,recordEnrollmentUncertainty} from '../sdrProviderOperations.js';
import {customerCheckUnavailable} from '../customerSuppression.js';

// B1 review 2026-10-26, run against the real approve-and-send handler source:
// - an automatic send wrote its approval receipt before the provider checks, so every refused
//   automatic attempt left a receipt and expiry/pruning/retry skipped the draft for good;
// - the existing-customer and recent-contact checks allowed the send when Pipedrive failed.
const source=readFileSync(new URL('../../server.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('app.post("/api/sdr/drafts/:id/approve-and-send", async (req, res) => {'),source.indexOf('\napp.get("/api/projects", async (req, res) => {'));
const db=reportingTestDb('auto_send_receipt');
const draftId='10000000-0000-0000-0000-000000000001',owner='10000000-0000-0000-0000-000000000002',mailboxId='10000000-0000-0000-0000-000000000004';
describe.skipIf(!db)('approve-and-send: automatic receipts after acceptance, fail-closed CRM checks',()=>{
 let server,base,user,crmAllowed,customer,person,provider;
 const env={DATABASE_URL:'local-fixture',APOLLO_API_KEY:'local-fixture',PIPEDRIVE_API_TOKEN:'',SDR_CRM_COMPANY_ID:'42',SDR_REPLY_ACTIONS_ENABLED:''};
 const get=async()=>(await db.pool.query('SELECT * FROM sdr_drafts WHERE id=$1',[draftId])).rows[0];
 const request=async(extra={})=>{const view=await get();const response=await fetch(`${base}/api/sdr/drafts/${draftId}/approve-and-send`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:String(view.revision),expectedContextHash:draftContextHash(view),...extra})});return {status:response.status,body:await response.json()};};
 const receipts=async()=>(await db.pool.query("SELECT actor->>'execution' AS execution FROM sdr_draft_approvals")).rows;
 beforeAll(async()=>{
  await db.setup();await db.pool.query(`CREATE TABLE sdr_drafts(id uuid PRIMARY KEY,pipedrive_lead_id text,status text,sent_at timestamptz,subject text,body text,created_at timestamptz DEFAULT NOW(),updated_at timestamptz DEFAULT NOW(),metadata jsonb,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,pipedrive_contact_id text,pipedrive_org_id text,assigned_mailbox_id uuid,assigned_user_id uuid,apollo_sequence_id text,trigger_type text,scheduled_for timestamptz,approved_at timestamptz,approved_by text,reject_reason text,error_message text,company_id text,initiated_by text);
  CREATE TABLE sdr_sends(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),draft_id uuid,pipedrive_lead_id text,apollo_sequence_id text,apollo_contact_id text,mailbox_id uuid,status text,sent_at timestamptz,enrolled_trigger text,enrolled_person_id text,enrolled_org_id text,enrolled_stage text);
  CREATE TABLE permit_sends(id text,apollo_contact_id text);
  CREATE TABLE sdr_settings(id int,contact_cooldown_days int);INSERT INTO sdr_settings VALUES(1,14);
  CREATE TABLE sdr_message_facts(provider text,direction text,provider_status text,prospect_email text,occurred_at timestamptz);
  CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,sent_at timestamptz,source text);
  CREATE TABLE sdr_lead_state(pipedrive_lead_id text,project_stage text);
  CREATE TABLE sdr_mailboxes(id uuid,email text,apollo_mailbox_id text,active boolean,warmup_started_at timestamptz,signature_html text,pipedrive_sender_id text,daily_send_limit int);`);
  for(const file of ['2026-10-07-sdr-draft-revisions.sql','2026-10-07-sdr-provider-operations.sql','2026-10-10-sdr-enrollment-phases.sql','2026-10-07-sdr-outreach-controls.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  provider={matchContactByEmail:vi.fn(async()=>({id:'contact'})),getContact:vi.fn(async()=>({id:'contact',contact_campaign_statuses:[]})),updateContactCustomFields:vi.fn(async()=>{}),addContactsToSequence:vi.fn(async()=>({contacts:[{id:'contact',contact_campaign_statuses:[{emailer_campaign_id:'sequence',emailer_campaign_contact_id:'membership',added_at:'2026-10-10T00:00:00Z'}]}]}))};
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.sdrUser=user;next()});
  const deps={app,pool:db.pool,bidInviteLeadFor:async()=>null,BID_INVITE_MESSAGE:'bid',process:{env},crypto:{randomUUID},console:{log:()=>{},warn:()=>{},error:()=>{}},ownerScope,withLeadLock,withProviderContactLock,checkViewedDraft,checkDraftSchedule,draftContextHash,draftConflict,recordDraftApproval,checkApprovedDraft,serializeDraft,mutateViewedDraft,
   staleDraftBlock:()=>null,hasRecentReply:async()=>false,sequencePaused:async()=>null,isCustomerLead:async()=>customer(),contactCooldownDays:async()=>14,emailVerify:{verifyEnabled:()=>false},mailboxBounceHealth:async()=>new Map(),dailyCap:()=>10,mailboxSentToday:async()=>0,rampDay:()=>1,bounceStepPenalty:()=>0,
   assertSendSafety:async(_pool,draft)=>({companyId:'42',leadId:'lead',personId:'person',recipientEmail:'buyer@example.test',organizationId:'org',projectRole:null,stage:'Bid',trigger:'LBA',mailboxId:String(draft.assigned_mailbox_id),sequenceId:'sequence',scheduledFor:null,overrideDecisionId:null,roleExceptionId:null,cadence:'standard',sourceRevision:'source-1',draftId:String(draft.id),channel:'email',serviceId:null,technicalComplete:true}),
   readContactSendDaysAgo:async()=>null,reserveEnrollment,advanceEnrollmentPhase,recordPreAddRefusal,recordEnrollmentReceipt,recordEnrollmentUncertainty,enrollmentRetryEnabled:()=>false,enrollmentSendBlock:()=>null,crmLifecycleEnabled:()=>true,verifyCrmLead:async()=>({allowed:crmAllowed,reason:'crm_missing',retryable:false}),
   APOLLO_CF_DRAFT_SUBJECT:'subject',APOLLO_CF_DRAFT_BODY:'body',APOLLO_CF_TRACK:'track',APOLLO_CF_ENV:null,APOLLO_CF_SWPPP:null,pdSequenceStartedKey:'sequence_started',apolloClient:provider,
   pipedriveClient:{getPerson:async()=>person(),updateLead:async()=>({})},publishOutreachEvent:async()=>{}};
  new Function(...Object.keys(deps),block)(...Object.values(deps));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
 });
 afterAll(async()=>{await new Promise(r=>server.close(r));await db.close()});
 beforeEach(async()=>{
  user={sub:owner,username:'auto-outreach',role:'admin',machine:true};crmAllowed=true;customer=()=>null;person=()=>({id:'person',last_outgoing_mail_time:null});env.PIPEDRIVE_API_TOKEN='';vi.clearAllMocks();
  await db.pool.query('TRUNCATE sdr_draft_approvals,sdr_provider_membership_observations,sdr_provider_operations,sdr_outreach_control_decisions,sdr_outreach_controls,sdr_sends,sdr_drafts,sdr_outreach_log,sdr_lead_state,sdr_mailboxes');
  await db.pool.query(`INSERT INTO sdr_drafts(id,pipedrive_lead_id,status,subject,body,metadata,contact_id_snapshot,contact_email_snapshot,org_id_snapshot,pipedrive_contact_id,pipedrive_org_id,assigned_mailbox_id,assigned_user_id,apollo_sequence_id,trigger_type,company_id,content_origin,initiated_by)
   VALUES($1,'lead','pending','Subject','Body','{}','person','buyer@example.test','org','person','org',$2,$3,'sequence','LBA','42','machine','automatic')`,[draftId,mailboxId,owner]);
  await db.pool.query("INSERT INTO sdr_lead_state VALUES('lead','Bid')");await db.pool.query('INSERT INTO sdr_mailboxes VALUES($1,\'sender@example.test\',\'provider-mailbox\',true,NULL,NULL,NULL,10)',[mailboxId]);
 });

 it('a refused automatic attempt leaves no approval receipt, so housekeeping can still expire the draft',async()=>{
  crmAllowed=false;
  const result=await request();
  expect(result.status).toBe(409);
  expect(provider.addContactsToSequence).not.toHaveBeenCalled();
  expect(await receipts()).toEqual([]);
  expect((await get()).status).toBe('pending');
 });
 it('an accepted automatic send records exactly one automatic receipt with the send',async()=>{
  const result=await request();
  expect(result.status).toBe(200);
  expect(await receipts()).toEqual([{execution:'automatic'}]);
  expect((await get()).status).toBe('sent');
 });
 it('a person still gets their durable receipt at the click, before any provider check',async()=>{
  user={sub:owner,username:'rep',role:'sdr',machine:false};crmAllowed=false;
  expect((await request()).status).toBe(409);
  expect(await receipts()).toEqual([{execution:'interactive'}]);
 });
 it('holds an automatic send when the existing-customer check cannot read Pipedrive',async()=>{
  customer=()=>{throw customerCheckUnavailable('Pipedrive read failed');};
  const result=await request();
  expect(result).toMatchObject({status:503,body:{code:'crm_unverified'}});
  expect(provider.matchContactByEmail).not.toHaveBeenCalled();
  expect((await get()).status).toBe('pending');
 });
 it('lets only an admin person send through an unreadable customer check',async()=>{
  customer=()=>{throw customerCheckUnavailable('Pipedrive read failed');};
  user={sub:owner,username:'rep',role:'sdr',machine:false};
  expect((await request({override:true}))).toMatchObject({status:503,body:{code:'crm_unverified'}});
  user={sub:owner,username:'boss',role:'admin',machine:false};
  expect((await request({override:true})).status).toBe(200);
 });
 it('holds an automatic send when the recent-contact check cannot read Pipedrive',async()=>{
  env.PIPEDRIVE_API_TOKEN='synthetic';person=()=>{throw Object.assign(new Error('Pipedrive GET /persons → 429'),{status:429});};
  const result=await request();
  expect(result).toMatchObject({status:503,body:{code:'crm_unverified'}});
  expect(provider.matchContactByEmail).not.toHaveBeenCalled();
  expect((await get()).status).toBe('pending');
 });
 it('still refuses a recently contacted person when Pipedrive answers',async()=>{
  env.PIPEDRIVE_API_TOKEN='synthetic';person=()=>({id:'person',name:'Buyer',last_outgoing_mail_time:new Date(Date.now()-3*86400000).toISOString()});
  expect((await request())).toMatchObject({status:409,body:{code:'already_outreached'}});
  expect(provider.matchContactByEmail).not.toHaveBeenCalled();
 });
});
