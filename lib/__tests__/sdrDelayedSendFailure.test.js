import express from 'express';
import {readFile} from 'node:fs/promises';
import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
import {checkViewedDraft,checkDraftSchedule,draftContextHash,mutateViewedDraft,draftConflict} from '../sdrDraftRevision.js';
const db=reportingTestDb('delayed_send_failure');
const id='10000000-0000-0000-0000-000000000001';
describe.skipIf(!db)('real approval handler delayed failure races',()=>{
 let server,base,started,release,outcome;
 const get=async()=>(await db.pool.query('SELECT * FROM sdr_drafts WHERE id=$1',[id])).rows[0];
 beforeAll(async()=>{
  await db.setup();
  await db.pool.query(`CREATE TABLE sdr_drafts(id uuid PRIMARY KEY,pipedrive_lead_id text,status text,sent_at timestamptz,subject text,body text,updated_at timestamptz,metadata jsonb,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,pipedrive_contact_id text,pipedrive_org_id text,assigned_mailbox_id text,assigned_user_id text,apollo_sequence_id text,trigger_type text,scheduled_for timestamptz,approved_at timestamptz,approved_by text,reject_reason text,error_message text);CREATE TABLE sdr_sends(draft_id uuid);CREATE TABLE sdr_outreach_log(pipedrive_lead_id text,sent_at timestamptz,source text)`);
  await db.pool.query(await readFile(new URL('../../migrations/2026-10-07-sdr-draft-revisions.sql',import.meta.url),'utf8'));
  vi.stubEnv('DATABASE_URL','synthetic');vi.stubEnv('APOLLO_API_KEY','synthetic');vi.stubEnv('PIPEDRIVE_API_TOKEN','');
  const source=await readFile(new URL('../../server.js',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('app.post("/api/sdr/drafts/:id/approve-and-send"'),source.indexOf('app.get("/api/projects"'));
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.sdrUser={sub:'rep',role:'sdr',machine:true};next();});
  const deps={app,pool:db.pool,ownerScope:()=>({requires:false}),checkViewedDraft,checkDraftSchedule,checkApprovedDraft:async()=>({allowed:true}),staleDraftBlock:()=>null,isCustomerLead:async()=>null,contactCooldownDays:async()=>14,
   emailVerify:{verifyEnabled:()=>true,canonicalVerdict:v=>v},readVerifyCache:async()=>{started();await new Promise(r=>{release=r});if(outcome==='exception')throw new Error('Synthetic delayed failure');return {email_verified_value:'buyer@example.invalid',email_verified_at:new Date(),email_verify_status:'hard_fail'};},STALE_MS:60000,enrollmentRetryEnabled:()=>false,mutateViewedDraft,draftConflict};
  new Function(...Object.keys(deps),block)(...Object.values(deps));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
 });
 afterAll(async()=>{await new Promise(r=>server.close(r));vi.unstubAllEnvs();await db.close();});
 beforeEach(async()=>{await db.pool.query('TRUNCATE sdr_draft_approvals,sdr_sends,sdr_drafts');await db.pool.query(`INSERT INTO sdr_drafts(id,pipedrive_lead_id,status,subject,body,contact_email_snapshot,assigned_mailbox_id,apollo_sequence_id,metadata) VALUES($1,'lead','pending','Reviewed','Original','buyer@example.invalid','mailbox','sequence','{}')`,[id]);});
 it.each(['hard_fail','exception'])('preserves a newer staff edit after delayed %s',async kind=>{
  outcome=kind;const original=await get();const ready=new Promise(r=>{started=r});
  const pending=fetch(`${base}/api/sdr/drafts/${id}/approve-and-send`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:original.revision,expectedContextHash:draftContextHash(original)})});
  await ready;
  await mutateViewedDraft(db.pool,{draft:original,expectedRevision:original.revision,expectedContextHash:draftContextHash(original),fields:{body:'New staff copy',status:'edited'}});
  const edited=await get();release();await pending;
  expect(await get()).toEqual(edited);
 });
 it('still rejects the unchanged revision after a verified hard failure',async()=>{
  outcome='hard_fail';const original=await get();const ready=new Promise(r=>{started=r});
  const pending=fetch(`${base}/api/sdr/drafts/${id}/approve-and-send`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:original.revision,expectedContextHash:draftContextHash(original)})});
  await ready;release();expect((await pending).status).toBe(422);
  expect(await get()).toMatchObject({status:'rejected',body:'Original'});
 });
});
