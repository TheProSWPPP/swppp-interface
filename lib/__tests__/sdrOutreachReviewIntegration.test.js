import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import express from 'express';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {registerSdrOutreachControlRoutes} from '../sdrOutreachControlRoutes.js';
import {readDecisionContext,hashContextDependencies} from '../sdrChangeJournal.js';
import {recordDraftApproval,checkApprovedDraft,checkViewedDraft,draftContextHash} from '../sdrDraftRevision.js';
import {acquireLeadLock} from '../sdrAccess.js';

const db=reportingTestDb('outreach_review_integration');
const draftId='10000000-0000-0000-0000-000000000007';
const STAGE='7c1852c27664d1118f75660223a6af9e99d10f2c';
describe.skipIf(!db)('HTTP outreach review with coherent context and draft revision',()=>{
 let server,base;
 beforeAll(async()=>{
  await db.setup();
  await db.pool.query(`CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,pipedrive_org_id text,person_email text,person_name text,project_stage text,trigger_type text,trigger_override text,sequence_started text,owner_name text);
   CREATE TABLE sdr_mailboxes(id text PRIMARY KEY,email text,apollo_mailbox_id text,active boolean);
   CREATE TABLE sdr_drafts(id uuid PRIMARY KEY,pipedrive_lead_id text,status text,created_at timestamptz DEFAULT now(),updated_at timestamptz,subject text,body text,metadata jsonb,assigned_mailbox_id text,assigned_user_id text,apollo_sequence_id text,scheduled_for timestamptz,sent_at timestamptz,approved_at timestamptz,approved_by text,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,trigger_type text);
   CREATE TABLE sdr_sends(draft_id uuid,pipedrive_lead_id text,status text,apollo_sequence_id text,apollo_contact_id text,sent_at timestamptz);`);
  for(const file of ['2026-10-05-sdr-crm-observations.sql','2026-10-07-sdr-manual-protection.sql','2026-10-07-sdr-draft-revisions.sql','2026-10-07-sdr-outreach-controls.sql','2026-10-07-sdr-crm-proposals.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.sdrUser={sub:'rep',role:'sdr'};next();});
  registerSdrOutreachControlRoutes(app,{pool:db.pool,companyId:'42',canViewLead:async(_req,id)=>id==='lead'});
  server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
 });
 afterAll(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();});
 beforeEach(async()=>{
  await db.pool.query('TRUNCATE sdr_lead_state,sdr_crm_snapshots,sdr_drafts,sdr_sends,sdr_mailboxes,sdr_draft_approvals,sdr_change_intents,sdr_change_receipts,sdr_outreach_controls,sdr_outreach_control_decisions CASCADE');
  await db.pool.query(`INSERT INTO sdr_lead_state(pipedrive_lead_id,crm_company_id) VALUES('lead','42');
   INSERT INTO sdr_mailboxes VALUES('mailbox','rep@example.test','provider-mailbox',true);
   INSERT INTO sdr_drafts(id,pipedrive_lead_id,status,subject,body,metadata,assigned_mailbox_id,assigned_user_id,apollo_sequence_id,approved_at,approved_by,contact_id_snapshot,contact_email_snapshot,org_id_snapshot,trigger_type)
   VALUES('${draftId}','lead','approved','Staff subject','Staff copy with deliberate wording','{}','mailbox','rep','sequence',now(),'rep','1','chosen@example.test','2','PB')`);
  await db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at,source_read_started_at) VALUES
   ('42','lead','lead',$1,now(),clock_timestamp()),('42','person','1','{"id":1,"name":"Chosen","email":[{"value":"chosen@example.test","primary":true}]}',now(),clock_timestamp()),('42','organization','2','{"id":2,"name":"Company"}',now(),clock_timestamp())`,[JSON.stringify({id:'lead',person_id:1,organization_id:2,[STAGE]:'PB'})]);
  await recordDraftApproval(db.pool,await draft(),{sub:'rep',machine:false});
 });
 const draft=async()=>(await db.pool.query('SELECT * FROM sdr_drafts WHERE id=$1',[draftId])).rows[0];
 const context=()=>readDecisionContext(db.pool,'lead',{companyId:'42'});
 const post=(suffix,body)=>fetch(base+'/api/sdr/leads/lead/'+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const reviewBody=c=>({contextHash:c.contextHash,projectRole:'Verified project estimator',cadence:'award_only',evidence:'Estimator confirmed responsibility for this project'});
 it('ordinary role review binds exact current context, advances revision, preserves copy and mints no override',async()=>{
  const before=await draft(),viewed={expectedRevision:before.revision,expectedContextHash:draftContextHash(before)},c=await context();
  expect(await checkApprovedDraft(db.pool,before)).toEqual({allowed:true});
  expect(c.draftId).toBe(draftId);
  const response=await post('outreach-review',reviewBody(c));expect(response.status).toBe(200);
  const result=await response.json(),after=await draft(),current=await context();
  expect(result).toMatchObject({sendingAuthorized:false,review:{overrideDecisionId:null}});
  expect(current).toMatchObject({hasTriggerOverride:false,overrideDecisionId:null,complete:true});
  expect(after).toMatchObject({subject:before.subject,body:before.body,status:'pending',approved_at:null,approved_by:null,revision:'2',contact_email_snapshot:before.contact_email_snapshot});
  expect(after.metadata).toMatchObject({reviewed_outreach_context_hash:current.contextHash,override_decision_id:null,role_exception_id:result.review.roleExceptionId,cadence:'award_only'});
  expect(result.review.identityHash).toBe(hashContextDependencies(current));
  expect(await checkApprovedDraft(db.pool,after)).toEqual({allowed:false,code:'approval_missing'});
  expect(checkViewedDraft({draft:after,...viewed})).toEqual({allowed:false,code:'draft_stale'});
  expect((await db.pool.query('SELECT subject,body,revision FROM sdr_draft_approvals')).rows).toEqual([{subject:before.subject,body:before.body,revision:'1'}]);
 });
 it('records an override decision only for a real explicit local override',async()=>{
  await db.pool.query("UPDATE sdr_lead_state SET trigger_override='AGC',trigger_type='AGC' WHERE pipedrive_lead_id='lead'");
  const c=await context();expect(c).toMatchObject({hasTriggerOverride:true,trigger:'AGC'});
  const response=await post('outreach-review',reviewBody(c));expect(response.status).toBe(200);
  const result=await response.json(),current=await context(),saved=await draft();
  expect(result.review.overrideDecisionId).toBe(result.review.roleExceptionId);
  expect(current).toMatchObject({complete:true,overrideDecisionId:result.review.roleExceptionId,hasTriggerOverride:true});
  expect(saved.metadata.override_decision_id).toBe(result.review.roleExceptionId);
  expect(saved.metadata.reviewed_outreach_context_hash).toBe(current.contextHash);
 });
 it('does not expose a stale historical override decision after the actual override was removed',async()=>{
  await db.pool.query(`UPDATE sdr_lead_state SET safety_context='{"overrideDecisionId":"old-override"}' WHERE pipedrive_lead_id='lead'`);
  expect(await context()).toMatchObject({hasTriggerOverride:false,overrideDecisionId:null});
 });
 it('rejects a changed recipient context without changing review, copy, revision or approval history',async()=>{
  const c=await context(),before=await draft();
  await db.pool.query(`UPDATE sdr_crm_snapshots SET data=jsonb_set(data,'{email}','[{"value":"new-choice@example.test","primary":true}]') WHERE entity='person'`);
  const response=await post('outreach-review',reviewBody(c));expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'control_context_changed'});
  expect(await draft()).toEqual(before);
  expect((await db.pool.query('SELECT count(*)::int n FROM sdr_change_intents')).rows[0].n).toBe(0);
  expect((await db.pool.query('SELECT count(*)::int n FROM sdr_draft_approvals')).rows[0].n).toBe(1);
 });
 it('allows an explicit current-context release and records its versioned decision',async()=>{
  const c=await context();
  const held=await post('controls',{scope:{kind:'lead',id:'lead'},reason:'Review project recipient',contextHash:c.contextHash});expect(held.status).toBe(201);const control=await held.json();
  const response=await post(`controls/${control.id}/resolve`,{decision:'release',evidence:'Current project restriction reviewed',expectedVersion:1,contextHash:c.contextHash});
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({resolved:true,control:{status:'released',version:2}});
  expect((await db.pool.query('SELECT decision,version FROM sdr_outreach_control_decisions WHERE control_id=$1 ORDER BY version',[control.id])).rows).toEqual([{decision:'hold',version:1},{decision:'release',version:2}]);
 });
 it('rereads context after acquiring the hold-release lock and rejects a queued stale release',async()=>{
  const c=await context();const held=await post('controls',{scope:{kind:'lead',id:'lead'},reason:'Review project recipient',contextHash:c.contextHash});expect(held.status).toBe(201);const control=await held.json();
  const blocker=await db.pool.connect();let releasing;
  try{
   await blocker.query('BEGIN');await acquireLeadLock(blocker,'lead');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   releasing=post(`controls/${control.id}/resolve`,{decision:'release',evidence:'Reviewed old contact',expectedVersion:1,contextHash:c.contextHash});
   const deadline=Date.now()+5000;let waiting=false;
   while(Date.now()<deadline){const r=await db.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks waiting JOIN pg_locks held ON waiting.locktype=held.locktype AND waiting.classid=held.classid AND waiting.objid=held.objid WHERE held.pid=$1 AND held.locktype='advisory' AND NOT waiting.granted) AS waiting`,[pid]);waiting=r.rows[0].waiting;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}
   expect(waiting).toBe(true);
   await blocker.query(`UPDATE sdr_crm_snapshots SET data=jsonb_set(data,'{email}','[{"value":"new-choice@example.test","primary":true}]') WHERE entity='person'`);
   await blocker.query('COMMIT');
   const response=await releasing;expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'control_context_changed'});
   expect((await db.pool.query('SELECT status,version FROM sdr_outreach_controls WHERE id=$1',[control.id])).rows[0]).toEqual({status:'active',version:1});
   expect((await db.pool.query('SELECT count(*)::int n FROM sdr_outreach_control_decisions WHERE control_id=$1',[control.id])).rows[0].n).toBe(1);
  }finally{await blocker.query('ROLLBACK');blocker.release();if(releasing)await releasing;}
 });
});
