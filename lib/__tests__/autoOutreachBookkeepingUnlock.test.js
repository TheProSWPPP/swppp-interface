import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
vi.mock('../sendRamp.js',async original=>({...await original(),mailboxBounceHealth:async()=>new Map()}));
vi.mock('../sdrDraftGenerator.js',()=>({buildDraftFromLead:vi.fn()}));
vi.mock('../customerSuppression.js',()=>({isCustomerLead:vi.fn(async()=>null)}));
import {buildDraftFromLead} from '../sdrDraftGenerator.js';
import {isCustomerLead} from '../customerSuppression.js';
import {runAutoOutreach,expireStaleQueuedDrafts,pruneStaleQueuedDrafts} from '../autoOutreach.js';

// B1 review 2026-10-26. Automatic outreach had 1 pickable lead while ~400 were held back by
// bookkeeping: drafts that only aged out were treated as staff rejections, send rows bulk-marked
// failed (never delivered) blocked forever, and the pending queue never cleared. Meanwhile 8 of 9
// new drafts went to people already sequenced under another lead.
const db=reportingTestDb('auto_bookkeeping');
const owner='10000000-0000-0000-0000-000000000001';
const mailbox='20000000-0000-0000-0000-000000000001';
const EXPIRED='auto: expired unapproved after 14 days';
const lead=(id,{score=100,person=`person-${id}`,email=`${id}@example.test`,verified=true,origin=null}={})=>db.pool.query(`INSERT INTO sdr_lead_state(pipedrive_lead_id,pipedrive_person_id,pipedrive_org_id,person_email,project_stage,trigger_type,outreach_status,lead_score,start_date,synced_at,crm_status,crm_company_id,email_verify_status,email_verified_at,email_verified_value,lead_origin)
 VALUES($1,$2,'org',$3,'Bid','LBA','clear',$4,CURRENT_DATE+1,'2026-10-01','active','42',$5,NOW(),$3,$6)`,[id,person,email,score,verified?'valid':'catchall',origin]);
const draft=async(leadId,{status='rejected',reason=null,origin='machine',initiated='automatic',email=`${leadId}@example.test`,person=null,days=20,updatedDays=days}={})=>
 (await db.pool.query(`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status,reject_reason,content_origin,initiated_by,contact_email_snapshot,contact_id_snapshot,subject,body,created_at,updated_at)
  VALUES($1,'LBA',$2,$3,$4,$5,$6,$7,'s','b',NOW()-make_interval(days=>$8::int),NOW()-make_interval(days=>$9::int)) RETURNING *`,[leadId,status,reason,origin,initiated,email,person,days,updatedDays])).rows[0];
// A send row on `leadId` whose draft went to `email`; status 'failed' with no evidence = never delivered.
const send=async(leadId,{email,status='failed',step=null,person=null,contact='contact',seq='seq'}={})=>{
 const d=await draft(leadId,{status:'sent',email,person});
 await db.pool.query(`INSERT INTO sdr_sends(draft_id,pipedrive_lead_id,status,step_status,enrolled_person_id,apollo_contact_id,apollo_sequence_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[d.id,leadId,status,step,person,contact,seq]);
 return d;
};
// The provider receipt the app wrote when it enrolled `contact` into `seq` for `leadId`.
const operation=(leadId,{contact='contact',seq='seq',kind='enroll',state='confirmed'}={})=>
 db.pool.query('INSERT INTO sdr_provider_operations(lead_id,contact_id,campaign_id,kind,state) VALUES($1,$2,$3,$4,$5)',[leadId,contact,seq,kind,state]);
const payload=args=>({pipedrive_lead_id:args.pipedriveLeadId,pipedrive_contact_id:'p',pipedrive_org_id:'org',contact_id_snapshot:'p',contact_email_snapshot:null,org_id_snapshot:'org',trigger_type:'LBA',apollo_sequence_id:'seq',subject:'Generated',body:'Body',assigned_mailbox_id:args.assignedMailboxId,assigned_user_id:args.assignedUserId,metadata:{}});
const run=()=>runAutoOutreach(db.pool,{companyId:'42',mailboxSentToday:async()=>0,maxDrafts:20});
const generated=()=>buildDraftFromLead.mock.calls.map(([args])=>args.pipedriveLeadId).sort();
const status=async id=>(await db.pool.query('SELECT status,reject_reason FROM sdr_drafts WHERE id=$1',[id])).rows[0];

describe.skipIf(!db)('automatic outreach: bookkeeping no longer locks leads out, people are not sequenced twice',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(`CREATE TABLE sdr_settings(id int,auto_outreach_enabled boolean,auto_outreach_mode text,auto_min_score float8,recontact_after_days int,start_date_grace_days int);
 CREATE TABLE sdr_mailboxes(id uuid,email text,owner_user_id uuid,warmup_started_at timestamptz,daily_send_limit int,active boolean,apollo_mailbox_id text);
 CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,pipedrive_org_id text,person_email text,project_stage text,trigger_override text,trigger_type text,outreach_status text,last_outgoing_mail_time timestamptz,lead_score float8,start_date date,synced_at timestamptz,crm_status text,crm_company_id text,email_verify_status text,email_verified_at timestamptz,email_verified_value text,lead_origin text);
 CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,pipedrive_contact_id text,pipedrive_org_id text,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,trigger_type text,apollo_sequence_id text,subject text,body text,assigned_mailbox_id uuid,assigned_user_id uuid,initiated_by text,metadata jsonb,status text DEFAULT 'pending',created_at timestamptz DEFAULT NOW(),updated_at timestamptz,sent_at timestamptz,error_message text,reject_reason text,approved_at timestamptz,approved_by text);
 CREATE UNIQUE INDEX uq_open ON sdr_drafts(pipedrive_lead_id,trigger_type) WHERE status IN ('pending','approved','edited');
 CREATE TABLE sdr_sends(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),draft_id uuid,pipedrive_lead_id text,status text,step_status text,apollo_emailer_message_id text,apollo_contact_id text,apollo_sequence_id text,enrolled_person_id text);
 CREATE TABLE sdr_inbox_reply_log(gmail_message_id text PRIMARY KEY,from_addr text,created_at timestamptz DEFAULT NOW());
 CREATE TABLE sdr_message_facts(provider text,provider_message_id text,direction text,prospect_email text,human_reply boolean,provider_status text,occurred_at timestamptz);
 CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,source text,sent_at timestamptz);
 CREATE TABLE sdr_engagement_events(pipedrive_lead_id text,event_type text,occurred_at timestamptz DEFAULT NOW());
 CREATE TABLE sdr_reply_messages(pipedrive_lead_id text,reply_kind text,received_at timestamptz DEFAULT NOW());
 CREATE TABLE sdr_provider_operations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lead_id text,contact_id text,state text,kind text,campaign_id text);
 CREATE TABLE sdr_enrollment_attempts(draft_id uuid,status text);
 CREATE TABLE permit_operator_email(operator_key text,email text);CREATE TABLE permit_drafts(id uuid,email text);CREATE TABLE permit_sends(operator_key text,draft_id uuid)`);
 for(const file of ['2026-10-07-sdr-draft-revisions.sql','2026-10-07-sdr-outreach-controls.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
 });
 beforeEach(async()=>{
  vi.unstubAllEnvs();
  await db.pool.query(`TRUNCATE sdr_inbox_reply_log,sdr_message_facts,sdr_engagement_events,sdr_reply_messages,sdr_provider_operations,sdr_enrollment_attempts,permit_operator_email,permit_drafts,permit_sends,
   sdr_outreach_control_decisions,sdr_outreach_controls,sdr_draft_approvals,sdr_drafts,sdr_sends,sdr_outreach_log,sdr_lead_state,sdr_mailboxes,sdr_settings`);
  await db.pool.query("INSERT INTO sdr_settings VALUES(1,true,'queue',NULL,NULL,0)");
  await db.pool.query("INSERT INTO sdr_mailboxes VALUES($1,'one@example.test',$2,NULL,40,true,'p1')",[mailbox,owner]);
  isCustomerLead.mockReset().mockResolvedValue(null);
  buildDraftFromLead.mockReset().mockImplementation(async args=>{
   const row=(await db.pool.query('SELECT person_email,pipedrive_person_id FROM sdr_lead_state WHERE pipedrive_lead_id=$1',[args.pipedriveLeadId])).rows[0];
   return {...payload(args),contact_email_snapshot:row.person_email,contact_id_snapshot:row.pipedrive_person_id,pipedrive_contact_id:row.pipedrive_person_id};
  });
 });

 it('a draft that only aged out no longer blocks its lead; staff decisions still do',async()=>{
  await lead('expired');await draft('expired',{reason:EXPIRED});
  await lead('legacy');await draft('legacy',{reason:EXPIRED,origin:'unknown',initiated:'auto-switch'});
  await lead('staff');await draft('staff',{reason:'Wrong contact',origin:'interactive',initiated:'manual'});
  await lead('edited');await draft('edited',{reason:EXPIRED,origin:'interactive'});
  await lead('cancelled');await draft('cancelled',{status:'cancelled'});
  await lead('verify');await draft('verify',{reason:'Email verification failed'});
  // A person rejected an automatic draft without giving a reason (119 such drafts on 2026-10-27).
  await lead('no-reason');await draft('no-reason',{reason:null});
  await lead('refused');const refused=await draft('refused',{reason:EXPIRED});
  await db.pool.query("INSERT INTO sdr_enrollment_attempts VALUES($1,'review')",[refused.id]);
  await lead('approved');const reviewed=await draft('approved',{reason:EXPIRED});
  await db.pool.query(`INSERT INTO sdr_draft_approvals(draft_id,revision,context_hash,subject,body,context,actor) VALUES($1,$2,'h','s','b','{}','{"execution":"interactive"}')`,[reviewed.id,reviewed.revision]);
  const result=await run();
  expect(generated()).toEqual(['expired','legacy']);
  expect(result).toMatchObject({created:2,errors:[]});
 });

 it('a send row marked failed that never delivered no longer blocks its lead',async()=>{
  // The lead now names someone else, so the provider membership guard has no history for them.
  await lead('moved',{email:'new@example.test',person:'person-new'});await send('moved',{email:'old@example.test',person:'person-old'});
  const result=await run();
  expect(generated()).toEqual(['moved']);
  expect(result).toMatchObject({created:1,errors:[]});
 });

 it('a failed send with any sign of delivery or a reply still blocks',async()=>{
  const prep=async id=>{await lead(id,{email:`${id}-new@example.test`,person:`${id}-new`});return send(id,{email:`${id}-old@example.test`,person:`${id}-old`});};
  await prep('message');await db.pool.query("INSERT INTO sdr_message_facts(provider,direction,prospect_email) VALUES('apollo','out','message-old@example.test')");
  await prep('event');await db.pool.query("INSERT INTO sdr_engagement_events(pipedrive_lead_id,event_type) VALUES('event','email_sent')");
  await prep('reply');await db.pool.query("INSERT INTO sdr_reply_messages(pipedrive_lead_id,reply_kind) VALUES('reply','auto')");
  await prep('ledger');await db.pool.query("INSERT INTO sdr_outreach_log(pipedrive_lead_id,source,sent_at) VALUES('ledger','interface',NOW()-interval '90 days')");
  await lead('step',{email:'step-new@example.test',person:'step-new'});await send('step',{email:'step-old@example.test',person:'step-old',step:'sent'});
  await lead('enrolled',{email:'enrolled-new@example.test',person:'enrolled-new'});await send('enrolled',{email:'enrolled-old@example.test',person:'enrolled-old',status:'enrolled'});
  expect(await run()).toMatchObject({created:0});
  expect(buildDraftFromLead).not.toHaveBeenCalled();
 });

 it('a person or address we already enrolled, through any lead, is not drafted again',async()=>{
  await lead('fresh',{score:10});
  await lead('same-address',{email:'shared@example.test'});await send('other-lead-1',{email:'Shared@Example.test',status:'enrolled'});
  await lead('same-person',{person:'person-sequenced'});await send('other-lead-2',{email:'x@example.test',status:'switched',person:'person-sequenced'});
  await lead('apollo-emailed',{email:'apollo@example.test'});await db.pool.query("INSERT INTO sdr_message_facts(provider,direction,prospect_email) VALUES('apollo','out','apollo@example.test')");
  await lead('provider-op');await db.pool.query("INSERT INTO sdr_provider_operations(lead_id,contact_id,state) VALUES('provider-op','c','confirmed')");
  await lead('permit-op',{email:'op@example.test'});await db.pool.query("INSERT INTO permit_operator_email VALUES('k','op@example.test');INSERT INTO permit_sends VALUES('k',NULL)");
  await lead('permit-draft',{email:'pd@example.test'});await db.pool.query("INSERT INTO permit_drafts VALUES('30000000-0000-0000-0000-000000000001','pd@example.test');INSERT INTO permit_sends VALUES('x','30000000-0000-0000-0000-000000000001')");
  const result=await run();
  expect(generated()).toEqual(['fresh']);
  expect(result).toMatchObject({created:1,errors:[]});
 });

 it('refuses inside the lock when the address is sequenced while the draft is written',async()=>{
  await lead('racing');
  buildDraftFromLead.mockImplementation(async args=>{await send('elsewhere',{email:'racing@example.test',status:'enrolled'});return {...payload(args),contact_email_snapshot:'racing@example.test',contact_id_snapshot:'person-racing',pipedrive_contact_id:'person-racing'};});
  const result=await run();
  expect(result).toMatchObject({created:0,errors:[{lead:'racing',error:'existing_draft_decision_requires_review'}]});
  expect((await db.pool.query("SELECT count(*)::int n FROM sdr_drafts WHERE pipedrive_lead_id='racing'")).rows[0].n).toBe(0);
 });

 it('does not draft an existing customer (refused at send anyway) and stops when Pipedrive is unreadable',async()=>{
  await lead('customer');await draft('customer',{reason:EXPIRED});
  await lead('plain',{score:50});
  isCustomerLead.mockImplementation(async id=>id==='customer'?{reason:'lead carries the Pipedrive Customer label',matchedOn:'lead_label'}:null);
  expect(await run()).toMatchObject({created:1,errors:[{lead:'customer',error:'existing_customer'}]});
  expect(generated()).toEqual(['plain']);
  await db.pool.query("DELETE FROM sdr_drafts WHERE pipedrive_lead_id='plain'");buildDraftFromLead.mockClear();
  isCustomerLead.mockRejectedValue(Object.assign(new Error('Pipedrive 429'),{code:'crm_unverified'}));
  expect(await run()).toMatchObject({created:0,stopped:'crm_unverified',scanned:1});
  expect(buildDraftFromLead).not.toHaveBeenCalled();
 });
 it('an unlocked lead still passes the reply, Bid Invite, verification and hold guards',async()=>{
  for(const id of ['ok','replied','bid','unverified','held'])await draft(id,{reason:EXPIRED});
  await lead('ok',{score:1});
  await lead('replied');await db.pool.query("INSERT INTO sdr_message_facts(provider,direction,prospect_email,human_reply,occurred_at) VALUES('apollo','in','replied@example.test',true,NOW()-interval '100 days')");
  await lead('bid',{origin:'Bid Invite: BuildingConnected'});
  await lead('unverified',{verified:false});
  await lead('held');await db.pool.query("INSERT INTO sdr_outreach_controls(company_id,lead_id,scope_kind,scope_id,channel,reason,context_hash,actor,owner_id) VALUES('42','held','lead','held','email','Provider membership requires review','h','{}','svc')");
  const result=await run();
  expect(generated()).toEqual(['ok']);
  expect(result).toMatchObject({created:1,errors:[]});
 });
 // 2026-10-27: Apollo auto-paused PB and LBA, the app kept enrolling into them, and on Oct 15 516
 // contacts were removed from those sequences without any email and their send rows marked
 // failed. Their own failed send, the same address and the enrollment receipt kept every one of
 // them out of automatic outreach for good.
 it('a contact whose only enrollment never produced an email is drafted again',async()=>{
  const victim=async(id,{seq='seq'}={})=>{await lead(id,{email:`${id}@example.test`,person:`person-${id}`});
   await send(id,{email:`${id}@example.test`,person:`person-${id}`,contact:`c-${id}`,seq});await operation(id,{contact:`c-${id}`,seq});};
  await victim('removed');
  // The same person removed under another project too.
  await lead('two-projects',{email:'two@example.test',person:'person-two'});
  await send('two-projects',{email:'two@example.test',person:'person-two',contact:'c-two'});await operation('two-projects',{contact:'c-two'});
  await send('two-projects-old',{email:'two@example.test',person:'person-two',contact:'c-two',seq:'seq-lba'});await operation('two-projects-old',{contact:'c-two',seq:'seq-lba'});
  const result=await run();
  expect(generated()).toEqual(['removed','two-projects']);
  expect(result).toMatchObject({created:2,errors:[]});
 });

 it('any sign the contact was emailed, or a live, reserved or stop operation, still blocks',async()=>{
  const victim=async id=>{await lead(id,{email:`${id}@example.test`,person:`person-${id}`});
   await send(id,{email:`${id}@example.test`,person:`person-${id}`,contact:`c-${id}`});await operation(id,{contact:`c-${id}`});};
  await victim('apollo-message');await db.pool.query("INSERT INTO sdr_message_facts(provider,direction,prospect_email) VALUES('apollo','out','apollo-message@example.test')");
  await victim('sent-event');await db.pool.query("INSERT INTO sdr_engagement_events(pipedrive_lead_id,event_type) VALUES('sent-event','email_sent')");
  await victim('bounced-event');await db.pool.query("INSERT INTO sdr_engagement_events(pipedrive_lead_id,event_type) VALUES('bounced-event','email_bounced')");
  await victim('message-id');await db.pool.query("UPDATE sdr_sends SET apollo_emailer_message_id='m1' WHERE pipedrive_lead_id='message-id'");
  await victim('stop-op');await operation('stop-op',{contact:'c-stop-op',kind:'stop',state:'confirmed'});
  // Enrolled again for another project in the same sequence: that membership is live.
  await victim('live-elsewhere');await send('live-elsewhere-2',{email:'other@example.test',contact:'c-live-elsewhere',status:'enrolled'});
  await lead('reserved',{email:'reserved@example.test',person:'person-reserved'});
  await send('reserved',{email:'reserved@example.test',person:'person-reserved',contact:'c-reserved'});await operation('reserved',{contact:'c-reserved',state:'reserved'});
  await lead('unresolved',{email:'unresolved@example.test',person:'person-unresolved'});
  await send('unresolved',{email:'unresolved@example.test',person:'person-unresolved',contact:'c-unresolved'});await operation('unresolved',{contact:'c-unresolved',state:'unresolved'});
  // Removed without a message, but the person replied, sits on a hold or is a bid-sheet contact.
  await victim('replied');await db.pool.query("INSERT INTO sdr_message_facts(provider,direction,prospect_email,human_reply,occurred_at) VALUES('apollo','in','replied@example.test',true,NOW()-interval '10 days')");
  await victim('held');await db.pool.query("INSERT INTO sdr_outreach_controls(company_id,lead_id,scope_kind,scope_id,channel,reason,context_hash,actor,owner_id) VALUES('42','held','lead','held','email','hold','h','{}','rep')");
  await lead('bid',{email:'bid@example.test',person:'person-bid',origin:'Bid Invite: BuildingConnected'});
  await send('bid',{email:'bid@example.test',person:'person-bid',contact:'c-bid'});await operation('bid',{contact:'c-bid'});
  expect(await run()).toMatchObject({created:0});
  expect(buildDraftFromLead).not.toHaveBeenCalled();
 });

 // October gaps review 2026-10-27: Apollo's job-change refusal (retried with sequence_job_change on a
 // fresh valid verdict) does not wait out the failed-draft backoff, and an add Apollo explicitly
 // skipped is not an enrollment. "na" or a phone number is never drafted, whatever its verdict.
 it('a job-change refusal and an explicitly skipped add do not block; a non-address is never drafted',async()=>{
  await lead('job-change');
  await db.pool.query(`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status,error_message,content_origin,initiated_by,contact_email_snapshot,subject,body,created_at)
   VALUES('job-change','LBA','failed','Apollo did not enroll the contact: contacts_with_job_change','machine','automatic','job-change@example.test','s','b',NOW()-interval '5 days')`);
  await db.pool.query("INSERT INTO sdr_provider_operations(lead_id,contact_id,campaign_id,kind,state) VALUES('job-change','c-job','seq','enroll','provider_skipped')");
  await lead('other-refusal');
  await db.pool.query(`INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status,error_message,content_origin,initiated_by,subject,body,created_at)
   VALUES('other-refusal','LBA','failed','Apollo did not enroll the contact: contacts_active_in_other_campaigns','machine','automatic','s','b',NOW()-interval '5 days')`);
  await lead('na',{email:'na'});
  await lead('phone',{email:'555-123-4567'});
  const result=await run();
  expect(generated()).toEqual(['job-change']);
  expect(result).toMatchObject({created:1,errors:[]});
 });

 it('a removed contact who is an existing customer is still not drafted',async()=>{
  await lead('customer',{email:'customer@example.test',person:'person-customer'});
  await send('customer',{email:'customer@example.test',person:'person-customer',contact:'c-customer'});await operation('customer',{contact:'c-customer'});
  isCustomerLead.mockResolvedValue({reason:'lead carries the Pipedrive Customer label',matchedOn:'lead_label'});
  expect(await run()).toMatchObject({created:0,errors:[{lead:'customer',error:'existing_customer'}]});
  expect(buildDraftFromLead).not.toHaveBeenCalled();
 });

});

afterAll(()=>db?.close());

describe.skipIf(!db)('the approval queue clears',()=>{
 beforeEach(async()=>{vi.stubEnv('SDR_ENROLLMENT_RETRY_ENABLED','false');await db.pool.query('TRUNCATE sdr_outreach_control_decisions,sdr_outreach_controls,sdr_draft_approvals,sdr_drafts,sdr_sends,sdr_lead_state');});
 const receipt=(d,execution)=>db.pool.query(`INSERT INTO sdr_draft_approvals(draft_id,revision,context_hash,subject,body,context,actor) VALUES($1,$2,'h','s','b','{}',$3)`,[d.id,d.revision,{execution}]);
 it('expires automatic drafts of unknown origin and drafts carrying only an automatic receipt',async()=>{
  const legacy=await draft('a',{status:'pending',origin:'unknown',initiated:'automatic'});
  const legacySwitch=await draft('b',{status:'pending',origin:'unknown',initiated:'auto-switch'});
  const refused=await draft('c',{status:'pending'});await receipt(refused,'automatic');
  expect(await expireStaleQueuedDrafts(db.pool,{companyId:'42'})).toBe(3);
  for(const d of [legacy,legacySwitch,refused])expect(await status(d.id)).toEqual({status:'rejected',reject_reason:EXPIRED});
 });
 it('keeps a draft a person approved, a held draft, a young draft and recently touched staff work',async()=>{
  const approved=await draft('a',{status:'pending'});await receipt(approved,'interactive');
  const held=await draft('held',{status:'pending'});
  await db.pool.query("INSERT INTO sdr_outreach_controls(company_id,lead_id,scope_kind,scope_id,channel,reason,context_hash,actor,owner_id) VALUES('42','held','lead','held','email','hold','h','{}','rep')");
  const young=await draft('c',{status:'pending',days:5});
  const staff=await draft('d',{status:'pending',origin:'interactive',initiated:'automatic',days:40,updatedDays:10});
  const manual=await draft('e',{status:'pending',origin:'unknown',initiated:'manual',days:20});
  expect(await expireStaleQueuedDrafts(db.pool,{companyId:'42'})).toBe(0);
  for(const d of [approved,held,young,staff,manual])expect((await status(d.id)).status).toBe('pending');
 });
 it('expires staff-touched drafts once nobody touched them for 30 days',async()=>{
  const staff=await draft('d',{status:'pending',origin:'interactive',initiated:'automatic',days:40,updatedDays:31});
  const manual=await draft('e',{status:'pending',origin:'unknown',initiated:'manual',days:40,updatedDays:35});
  expect(await expireStaleQueuedDrafts(db.pool,{companyId:'42'})).toBe(2);
  for(const d of [staff,manual])expect((await status(d.id)).status).toBe('rejected');
 });
 it('prunes a contacted lead\'s draft even when an automatic attempt left a receipt',async()=>{
  await lead('pruned');await db.pool.query("UPDATE sdr_lead_state SET last_outgoing_mail_time=NOW() WHERE pipedrive_lead_id='pruned'");
  const d=await draft('pruned',{status:'pending',days:2});await receipt(d,'automatic');
  expect(await pruneStaleQueuedDrafts(db.pool,{companyId:'42'})).toBe(1);
 });
});
