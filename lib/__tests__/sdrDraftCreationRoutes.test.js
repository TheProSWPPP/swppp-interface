import express from 'express';
import {readFile} from 'node:fs/promises';
import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {reportingTestDb} from './reportingTestDb.js';
import {leadVisibleTo} from '../sdrAccess.js';
import {serializeDraft} from '../sdrDraftRevision.js';
import * as guards from '../sdrDraftCreation.js';
const db=reportingTestDb('creation_routes');
const rep='10000000-0000-0000-0000-000000000001',other='10000000-0000-0000-0000-000000000002';
const payload={pipedrive_lead_id:'lead',pipedrive_contact_id:'person',pipedrive_org_id:'org',contact_id_snapshot:'person',contact_email_snapshot:'buyer@example.test',org_id_snapshot:'org',trigger_type:'LBA',apollo_sequence_id:'sequence',assigned_mailbox_id:rep,assigned_user_id:rep,subject:'Initial copy',body:'Initial body',metadata:{project_stage:'Bid',service_id:'swppp'}};
let server,base,build,beforeMailbox;
describe.skipIf(!db)('real draft creation routes (isolated Postgres)',()=>{
 beforeAll(async()=>{
  await db.setup();await db.pool.query(`CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,pipedrive_person_id text,pipedrive_org_id text,person_email text,project_stage text,trigger_type text,trigger_override text,crm_company_id text,crm_status text,safety_context jsonb);
  CREATE TABLE sdr_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pipedrive_lead_id text,pipedrive_contact_id text,pipedrive_org_id text,contact_id_snapshot text,contact_email_snapshot text,org_id_snapshot text,trigger_type text,apollo_sequence_id text,apollo_template_id text,assigned_mailbox_id uuid,assigned_user_id uuid,subject text,body text,metadata jsonb,status text DEFAULT 'pending',sent_at timestamptz,created_at timestamptz DEFAULT NOW(),updated_at timestamptz DEFAULT NOW(),approved_at timestamptz,approved_by uuid,scheduled_for timestamptz,error_message text,reject_reason text,initiated_by text);
  CREATE UNIQUE INDEX uq_open ON sdr_drafts(pipedrive_lead_id,trigger_type) WHERE status IN ('pending','approved','edited');
  CREATE TABLE sdr_sends(draft_id uuid,pipedrive_lead_id text)`);
  for(const file of ['2026-10-07-sdr-draft-revisions.sql','2026-10-07-sdr-outreach-controls.sql'])await db.pool.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  vi.stubEnv('DATABASE_URL','synthetic');vi.stubEnv('PIPEDRIVE_API_TOKEN','synthetic');vi.stubEnv('SDR_CRM_COMPANY_ID','42');
  const source=await readFile(new URL('../../server.js',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('app.post("/api/sdr/drafts/generate"'),source.indexOf('// Every mutation binds'));
  const app=express();app.use(express.json());app.use((req,res,next)=>{const actor=req.get('x-test-actor');if(actor!=='callback'&&actor!=='none')req.sdrUser={sub:rep,username:'rep',role:actor==='admin'?'admin':'sdr',...(actor==='machine'?{machine:true}:{})};next();});
  const deps={pool:db.pool,leadVisibleTo,serializeDraft,N8N_CALLBACK_SECRET:'synthetic-callback',buildDraftFromLead:(...args)=>build(...args),mailboxAssignmentError:async()=>{if(beforeMailbox)await beforeMailbox();return null;},contactCooldownDays:async()=>30,sdrDraftVerifyEnabled:()=>false,...guards};
  new Function('app',...Object.keys(deps),block)(app,...Object.values(deps));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
 });
 afterAll(async()=>{await new Promise(r=>server.close(r));vi.unstubAllEnvs();await db.close();});
 beforeEach(async()=>{build=vi.fn(async()=>({...payload}));beforeMailbox=null;await db.pool.query('TRUNCATE sdr_outreach_control_decisions,sdr_outreach_controls,sdr_draft_approvals,sdr_sends,sdr_drafts,sdr_lead_state');await db.pool.query("INSERT INTO sdr_lead_state VALUES('lead','person','org','buyer@example.test','Bid','LBA',NULL,'42','active','{}')");});
 const post=async(path,actor='callback',body=payload)=>{const r=await fetch(base+path+(actor==='callback'?'?callback_secret=synthetic-callback':''),{method:'POST',headers:{'content-type':'application/json','x-test-actor':actor},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const count=async()=>(await db.pool.query('SELECT COUNT(*)::int n FROM sdr_drafts')).rows[0].n;
 const hold=async()=>db.pool.query("INSERT INTO sdr_outreach_controls(company_id,lead_id,scope_kind,scope_id,channel,reason,context_hash,actor,owner_id) VALUES('42','lead','lead','lead','email','Staff hold','hash','{}','rep')");
 const reject=async()=>db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status,subject,body,content_origin) VALUES('lead','PB','rejected','Staff copy','Staff copy','interactive')");
 it('preserves normal callback initial creation and stamps authenticated machine origin',async()=>{const r=await post('/api/sdr/drafts/generate');expect(r.status).toBe(201);expect(r.body.draft).toMatchObject({content_origin:'machine',revision:'1'});expect(r.body.draft.contextHash).toMatch(/^[0-9a-f]{64}$/);});
 it('uses the real visibility function argument order for a rep initial generation',async()=>{const r=await post('/api/sdr/drafts/generate','rep');expect(r.status).toBe(201);expect(r.body.draft.content_origin).toBe('interactive');});
 it.each(['callback','machine','admin'])('blocks held %s generation before the remote generator',async actor=>{await hold();const r=await post('/api/sdr/drafts/generate',actor,{...payload,override:true});expect(r.status).toBe(409);expect(build).not.toHaveBeenCalled();expect(await count()).toBe(0);});
 it.each(['callback','admin'])('preserves a rejected choice from %s generation despite a changed trigger and override',async actor=>{await reject();const r=await post('/api/sdr/drafts/generate',actor,{...payload,override:true});expect(r.status).toBe(409);expect(build).not.toHaveBeenCalled();expect(await count()).toBe(1);});
 it.each(['hold','reject','contact'])('rechecks a %s that appears while remote generation waits',async change=>{
  build.mockImplementation(async()=>{if(change==='hold')await hold();if(change==='reject')await reject();if(change==='contact')await db.pool.query("UPDATE sdr_lead_state SET pipedrive_person_id='other' WHERE pipedrive_lead_id='lead'");return payload;});
  const r=await post('/api/sdr/drafts/generate');expect(r.status).toBe(409);expect(await count()).toBe(change==='reject'?1:0);
 });
 it('retains raw interactive copy and ignores spoofed body origin',async()=>{const r=await post('/api/sdr/drafts','rep',{...payload,content_origin:'machine'});expect(r.status).toBe(201);expect(r.body.draft.content_origin).toBe('interactive');});
 it.each(['hold','reject'])('raw creation cannot bypass a %s with generic override',async protection=>{await(protection==='hold'?hold():reject());const r=await post('/api/sdr/drafts','admin',{...payload,override:true});expect(r.status).toBe(409);expect(await count()).toBe(protection==='reject'?1:0);});
 it('rechecks raw creation after awaited mailbox validation',async()=>{beforeMailbox=hold;const r=await post('/api/sdr/drafts','rep');expect(r.status).toBe(409);expect(await count()).toBe(0);});
 it('serializes competing initial drafts even when they request different triggers',async()=>{
  let started=0,release;const wait=new Promise(resolve=>{release=resolve});
  build.mockImplementation(async({triggerType})=>{started++;if(started===2)release();await wait;return {...payload,trigger_type:triggerType};});
  const responses=await Promise.all(['LBA','CM'].map(trigger_type=>post('/api/sdr/drafts/generate','callback',{...payload,trigger_type})));
  expect(responses.map(r=>r.status).sort()).toEqual([201,409]);expect(await count()).toBe(1);
 });
 it('still allows an initial callback draft before a mirror row exists',async()=>{await db.pool.query('TRUNCATE sdr_lead_state');const r=await post('/api/sdr/drafts/generate');expect(r.status).toBe(201);});
 it('rejects a generated recipient conflicting with the preserved selection',async()=>{build.mockResolvedValue({...payload,contact_email_snapshot:'other@example.test'});const r=await post('/api/sdr/drafts/generate');expect(r.status).toBe(409);expect(await count()).toBe(0);});
 it('does not adopt cancelled work via raw creation',async()=>{await reject();await db.pool.query("UPDATE sdr_drafts SET status='cancelled'");const r=await post('/api/sdr/drafts','admin');expect(r.status).toBe(409);expect(await count()).toBe(1);});
 it('does not reveal or overwrite another reps private open draft',async()=>{await db.pool.query("INSERT INTO sdr_drafts(pipedrive_lead_id,trigger_type,status,assigned_user_id) VALUES('lead','PB','pending',$1)",[other]);const r=await post('/api/sdr/drafts/generate','rep');expect(r.status).toBe(404);expect(build).not.toHaveBeenCalled();expect(await count()).toBe(1);});
});

it('does not infer a machine or interactive origin without authenticated evidence',()=>{expect(guards.draftCreationOrigin()).toBe('unknown');expect(guards.draftCreationOrigin({user:{username:'auto',role:'admin'}})).toBe('unknown');expect(guards.draftCreationOrigin({user:{sub:'service',role:'admin',machine:true}})).toBe('machine');expect(guards.draftCreationOrigin({user:{sub:'rep',role:'sdr'}})).toBe('interactive');});
