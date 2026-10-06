import express from 'express';
import {readFile} from 'node:fs/promises';
import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
import {registerSdrDraftReplacementRoutes} from '../sdrDraftReplacement.js';
import {readDecisionContext} from '../sdrChangeJournal.js';
import {assertSendSafety} from '../sdrSendSafety.js';
const db=reportingTestDb('replacement');
const owner='10000000-0000-0000-0000-000000000001',oldId='20000000-0000-0000-0000-000000000001';
const payload={pipedrive_lead_id:'lead',pipedrive_contact_id:'person',pipedrive_org_id:'org',contact_id_snapshot:'person',contact_email_snapshot:'buyer@example.test',org_id_snapshot:'org',trigger_type:'LBA',apollo_sequence_id:'sequence',assigned_mailbox_id:owner,assigned_user_id:owner,subject:'New review copy',body:'New review body',metadata:{project_stage:'LBA',service_id:'swppp',reviewed_outreach_context_hash:'must-not-adopt'}};
let server,base,build;
describe.skipIf(!db)('explicit replacement review route',()=>{
 beforeAll(async()=>{
  await db.setup();await db.pool.query(`CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,pipedrive_org_id text,person_email text,person_name text,project_stage text,trigger_type text,trigger_override text,sequence_started text,owner_name text,crm_status text);
  CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,pipedrive_contact_id text,pipedrive_org_id text,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,trigger_type text,apollo_sequence_id text,assigned_mailbox_id uuid,assigned_user_id uuid,subject text,body text,metadata jsonb,status text DEFAULT 'pending',sent_at timestamptz,created_at timestamptz DEFAULT NOW(),updated_at timestamptz DEFAULT NOW(),approved_at timestamptz,approved_by uuid,scheduled_for timestamptz,error_message text,reject_reason text);
  CREATE UNIQUE INDEX uq_open ON sdr_drafts(pipedrive_lead_id,trigger_type) WHERE status IN ('pending','approved','edited');
  CREATE TABLE sdr_mailboxes(id uuid,email text,apollo_mailbox_id text,active boolean);CREATE TABLE sdr_sends(draft_id uuid,pipedrive_lead_id text)`);
  for(const file of ['2026-10-05-sdr-crm-observations.sql','2026-10-07-sdr-manual-protection.sql','2026-10-07-sdr-draft-revisions.sql','2026-10-07-sdr-outreach-controls.sql','2026-10-07-sdr-provider-operations.sql','2026-10-07-sdr-policy-rollout.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  const app=express();app.use(express.json());app.use((req,res,next)=>{const actor=req.get('x-test-actor')||'owner';if(actor!=='anonymous')req.sdrUser={sub:actor==='other'?'other':owner,role:actor==='admin'?'admin':'sdr',machine:actor==='machine'};next();});
  registerSdrDraftReplacementRoutes(app,{pool:db.pool,companyId:'42',buildDraftFromLead:(...args)=>build(...args)});
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/api/sdr/drafts/${oldId}`;
 });
 afterAll(async()=>{await new Promise(r=>server.close(r));await db.close();});
 beforeEach(async()=>{
  build=vi.fn(async()=>structuredClone(payload));
  await db.pool.query('TRUNCATE sdr_policy_decisions,sdr_policy_cohorts,sdr_policy_rollouts,sdr_mailboxes,sdr_change_receipts,sdr_change_intents,sdr_provider_membership_observations,sdr_provider_operations,sdr_outreach_control_decisions,sdr_outreach_controls,sdr_draft_approvals,sdr_sends,sdr_drafts,sdr_lead_state,sdr_crm_snapshots');
  await db.pool.query("INSERT INTO sdr_lead_state(pipedrive_lead_id,trigger_type,crm_company_id,crm_status) VALUES('lead','LBA','42','active')");
  await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at) VALUES('42','lead','lead','{"person_id":"person","organization_id":"org","7c1852c27664d1118f75660223a6af9e99d10f2c":"LBA"}',now()),('42','person','person','{"email":[{"value":"buyer@example.test","primary":true}]}',now()),('42','organization','org','{}',now())`);
  await db.pool.query("INSERT INTO sdr_drafts(id,pipedrive_lead_id,contact_id_snapshot,contact_email_snapshot,org_id_snapshot,trigger_type,apollo_sequence_id,assigned_mailbox_id,assigned_user_id,subject,body,metadata,status,approved_at,approved_by,reject_reason) VALUES($1,'lead','person','buyer@example.test','org','LBA','sequence',$2,$2,'Original exact copy','Original exact body','{\"cadence\":\"award_only\",\"service_id\":\"swppp\"}','rejected',now(),$2,'Original reason')",[oldId,owner]);
  await db.pool.query("INSERT INTO sdr_draft_approvals(draft_id,revision,context_hash,subject,body,context,actor) VALUES($1,1,'old','Original exact copy','Original exact body','{}','{}')",[oldId]);
 });
 const request=async(method,suffix,body,actor='owner')=>{const r=await fetch(base+suffix,{method,headers:{'content-type':'application/json','x-test-actor':actor},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json().catch(()=>({}))};};
 const review=async()=>{const r=await request('GET','/replacement-context');expect(r.status).toBe(200);return {expectedDraftId:oldId,expectedRevision:r.body.draft.revision,expectedContextHash:r.body.draft.contextHash,currentContextHash:r.body.context.contextHash,reason:'Reviewed selected recipient; prepare copy only'};};
 const count=async()=>(await db.pool.query('SELECT count(*)::int n FROM sdr_drafts')).rows[0].n;
 const hold=async(kind='lead')=>db.pool.query("INSERT INTO sdr_outreach_controls(company_id,lead_id,scope_kind,scope_id,channel,reason,context_hash,actor,owner_id) VALUES('42','lead',$1,$2,'email','Staff hold','hash','{}',$3)",[kind,kind==='draft'?oldId:'lead',owner]);
 const originals=async()=>({draft:(await db.pool.query('SELECT * FROM sdr_drafts WHERE id=$1',[oldId])).rows,approvals:(await db.pool.query('SELECT * FROM sdr_draft_approvals')).rows});
 it.each(['failed','rejected','cancelled'])('creates a pending interactive replacement of %s without changing source history',async status=>{
  await db.pool.query('UPDATE sdr_drafts SET status=$1 WHERE id=$2',[status,oldId]);const original=await originals();const fields=await review();const r=await request('POST','/replacement',fields);
  expect(r.status).toBe(201);expect(r.body.draft).toMatchObject({status:'pending',content_origin:'interactive',revision:'1',subject:'New review copy',approved_at:null,approved_by:null,sent_at:null,metadata:{replacement_of:oldId,cadence:'award_only'}});expect(r.body.draft.metadata.reviewed_outreach_context_hash).toBeUndefined();expect(await originals()).toEqual(original);expect(await count()).toBe(2);
  expect((await db.pool.query('SELECT reason,actor,expected_fields,proposed_fields FROM sdr_change_intents')).rows[0]).toMatchObject({reason:fields.reason,actor:{accountId:owner,execution:'interactive'},expected_fields:{draftId:oldId,revision:fields.expectedRevision},proposed_fields:{status:'pending'}});
  expect((await db.pool.query('SELECT status,provider_receipt FROM sdr_change_receipts')).rows).toEqual([{status:'confirmed',provider_receipt:null}]);expect((await db.pool.query('SELECT * FROM sdr_sends')).rows).toEqual([]);
 });
 it.each([[null,1],[null,2],['review',1],['review',2],['standard',1],['standard',2],['award_only',1],['award_only',2]])('enforces inherited award-only cadence after replacement when persisted cadence is %s and provider has %s steps',async(cadence,steps)=>{
  await db.pool.query('UPDATE sdr_lead_state SET safety_context=$1',[{cadence}]);
  if(cadence==='award_only')await db.pool.query("UPDATE sdr_drafts SET metadata=jsonb_set(metadata,'{cadence}','\"standard\"') WHERE id=$1",[oldId]);
  build.mockResolvedValue({...payload,metadata:{...payload.metadata,sender_email:'rep@example.test',sender_provider_id:'sender'}});
  const replacement=await request('POST','/replacement',await review());expect(replacement.status).toBe(201);
  const raw=(await db.pool.query('SELECT * FROM sdr_drafts WHERE id=$1',[replacement.body.draft.id])).rows[0];
  const current=await readDecisionContext(db.pool,'lead',{companyId:'42',draftId:raw.id});
  expect(current.cadence).toBe('award_only');expect(current.businessReviewed).toBe(false);
  await db.pool.query("INSERT INTO sdr_policy_rollouts(company_id,version,mode,owner_id,actor,evidence) VALUES('42',1,'observe','reviewer','{}','explicit test rollout')");
  await db.pool.query("INSERT INTO sdr_mailboxes VALUES($1,'rep@example.test','sender',true)",[owner]);
  const getSequence=vi.fn(async()=>({emailer_steps:Array.from({length:steps},()=>({type:'auto_email'}))}));
  const send=assertSendSafety(db.pool,raw,{companyId:'42',getSequence,
   getLead:async()=>({id:'lead',is_archived:false,person_id:'person',organization_id:'org','7c1852c27664d1118f75660223a6af9e99d10f2c':'LBA'}),
   getPerson:async()=>({id:'person',email:[{value:'buyer@example.test',primary:true}]})});
  if(steps===2)await expect(send).rejects.toMatchObject({code:'award_only_requires_matching_sequence'});
  else expect(await send).toMatchObject({technicalComplete:true,complete:false,cadence:'award_only'});
  expect(getSequence).toHaveBeenCalledOnce();
 });
 it.each(['machine','other','anonymous'])('denies %s before building',async actor=>{const fields=await review();expect((await request('POST','/replacement',fields,actor)).status).toBe(actor==='anonymous'?401:403);expect(build).not.toHaveBeenCalled();expect(await count()).toBe(1);});
 it('allows an interactive admin without adopting approvals',async()=>{const r=await request('POST','/replacement',await review(),'admin');expect(r.status).toBe(201);expect(r.body.draft.approved_at).toBeNull();});
 it.each(['expectedDraftId','expectedRevision','expectedContextHash','currentContextHash','reason'])('requires explicit matching %s',async field=>{const fields=await review();fields[field]=field==='reason'?' ':field==='expectedRevision'?'999':'wrong';expect((await request('POST','/replacement',fields)).status).toBe(field==='reason'?400:409);expect(build).not.toHaveBeenCalled();expect(await count()).toBe(1);});
 it.each(['lead','draft'])('blocks active %s holds before generation',async scope=>{const fields=await review();await hold(scope);expect((await request('POST','/replacement',fields)).status).toBe(409);expect(build).not.toHaveBeenCalled();expect(await count()).toBe(1);});
 it.each(['hold','revision','context','competing'])('rechecks %s added during generation',async change=>{const fields=await review();build.mockImplementation(async()=>{if(change==='hold')await hold();if(change==='revision')await db.pool.query("UPDATE sdr_drafts SET body='Staff correction' WHERE id=$1",[oldId]);if(change==='context')await db.pool.query("UPDATE sdr_lead_state SET trigger_override='CM'");if(change==='competing')await db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,status,trigger_type) VALUES('lead','pending','PB')");return payload;});expect((await request('POST','/replacement',fields)).status).toBe(409);expect(await count()).toBe(change==='competing'?2:1);expect((await db.pool.query('SELECT * FROM sdr_change_intents')).rows).toEqual([]);});
 it.each(['pending','approved','edited','sent','send','operation'])('blocks competing %s before building',async state=>{const fields=await review();if(state==='send')await db.pool.query("INSERT INTO sdr_sends(pipedrive_lead_id) VALUES('lead')");else if(state==='operation')await db.pool.query("INSERT INTO sdr_provider_operations(id,operation_key,kind,contact_id,campaign_id,lead_id,expected_membership,action_id,state) VALUES(gen_random_uuid(),'op','enroll','contact','sequence','lead','{}','action','unresolved')");else await db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,status,trigger_type) VALUES('lead',$1,'PB')",[state]);expect((await request('POST','/replacement',fields)).status).toBe(409);expect(build).not.toHaveBeenCalled();});
 it('serializes simultaneous replacement requests',async()=>{const fields=await review();let started=0,release;const wait=new Promise(r=>{release=r});build.mockImplementation(async()=>{if(++started===2)release();await wait;return payload;});const results=await Promise.all([request('POST','/replacement',fields),request('POST','/replacement',fields)]);expect(results.map(r=>r.status).sort()).toEqual([201,409]);expect(await count()).toBe(2);expect((await db.pool.query('SELECT * FROM sdr_change_intents')).rowCount).toBe(1);});
 it('rejects a generator changing the prior service scope',async()=>{const fields=await review();build.mockResolvedValue({...payload,metadata:{...payload.metadata,service_id:'another-service'}});expect((await request('POST','/replacement',fields)).status).toBe(409);expect(await count()).toBe(1);});
 it('preserves service scope and schedule when the generator has no service metadata',async()=>{await db.pool.query("UPDATE sdr_drafts SET scheduled_for='2030-01-01T12:00:00Z' WHERE id=$1",[oldId]);const fields=await review();build.mockResolvedValue({...payload,metadata:{project_stage:'LBA'}});const r=await request('POST','/replacement',fields);expect(r.status).toBe(201);expect(r.body.draft.metadata.service_id).toBe('swppp');expect(r.body.draft.scheduled_for).toBe('2030-01-01T12:00:00.000Z');});
 it('does not regenerate when current organization observations become inaccessible',async()=>{const fields=await review();await db.pool.query("UPDATE sdr_crm_snapshots SET access_status='denied' WHERE entity='organization'");expect((await request('POST','/replacement',fields)).status).toBe(409);expect(build).not.toHaveBeenCalled();});
 it('rejects a remote selection different from the reviewed recipient',async()=>{const fields=await review();build.mockResolvedValue({...payload,contact_email_snapshot:'different@example.test'});expect((await request('POST','/replacement',fields)).status).toBe(409);expect(await count()).toBe(1);});
});
