import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import * as api from '../sdrFollowupDrafts.js';
import {registerSdrFollowupDraftRoutes} from '../sdrFollowupDraftRoutes.js';
const db=reportingTestDb('followup_drafts');
const a={role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'};
const b={role:'sdr',sub:'00000000-0000-0000-0000-00000000000b'};
const admin={role:'admin',sub:'00000000-0000-0000-0000-00000000000c'};

const options=(viewer=a,leadId='A',companyId='42')=>({viewer,leadId,companyId});
const read=(viewer=a,leadId='A',companyId='42')=>api.readFollowupDraft(db.pool,options(viewer,leadId,companyId));
const save=async(fields={},viewer=a)=>{const current=await read(viewer);return api.saveFollowupDraft(db.pool,{...options(viewer),body:'Human follow-up',subject:'Project question',expectedRevision:current.draft?.revision||0,contextToken:current.contextToken,...fields});};
(db?describe:describe.skip)('private custom follow-up drafts',()=>{
 beforeAll(async()=>{
  await db.setup();
  await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-05-sdr-crm-observations.sql',import.meta.url),'utf8'));
  await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-07-sdr-outreach-controls.sql',import.meta.url),'utf8'));
  await db.pool.query('CREATE TABLE sdr_users(id uuid PRIMARY KEY,role text,active boolean); CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,crm_company_id text); CREATE TABLE sdr_drafts(pipedrive_lead_id text,assigned_user_id uuid,status text)');
  const migration=new URL('../../migrations/2026-10-08-sdr-followup-drafts.sql',import.meta.url);
  await db.pool.query(await fs.readFile(migration,'utf8'));
 });
 afterAll(async()=>db.close());
 afterEach(()=>{expect(globalThis.fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();});
 beforeEach(async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('External requests forbidden');}));
  await db.pool.query('TRUNCATE sdr_crm_snapshots,sdr_crm_links,sdr_lead_state,sdr_drafts,sdr_users,sdr_outreach_controls,sdr_crm_scope_coverage CASCADE');
  for(const user of [a,b,admin])await db.pool.query('INSERT INTO sdr_users VALUES($1,$2,true)',[user.sub,user.role]);
  await db.pool.query("INSERT INTO sdr_lead_state VALUES('A','42'),('B','other'); INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES('42','lead','A','{\"title\":\"Project A\",\"person_id\":12}'),('other','lead','B','{\"title\":\"Other project\"}')");
 });
 it('provides separate private read/save operations',()=>{expect(api.readFollowupDraft).toBeTypeOf('function');expect(api.saveFollowupDraft).toBeTypeOf('function');});
 it('saves one author-private draft without entering automated drafts',async()=>{
  expect((await read()).draft).toBeNull();
  const saved=await save();expect(saved.draft).toMatchObject({subject:'Project question',body:'Human follow-up',revision:1});
  expect((await read(b)).draft).toBeNull();expect((await read(admin)).draft).toBeNull();
  await save({body:'Other author'},b);expect((await read()).draft.body).toBe('Human follow-up');
  expect((await db.pool.query('SELECT count(*)::int n FROM sdr_drafts')).rows[0].n).toBe(0);
 });
 it('scopes even admin and rejects machine, inactive, stale-role, deleted/test/inaccessible leads',async()=>{
  await expect(read(admin,'B')).rejects.toMatchObject({code:'lead_unavailable'});
  await expect(read(a,'A','')).rejects.toMatchObject({code:'session_required'});
  await expect(read({...a,machine:true})).rejects.toMatchObject({code:'session_required'});
  await expect(read({...a,role:'admin'})).rejects.toMatchObject({code:'session_required'});
  await db.pool.query('UPDATE sdr_users SET active=false WHERE id=$1',[a.sub]);
  await expect(save()).rejects.toMatchObject({code:'session_required'});
  await db.pool.query('UPDATE sdr_users SET active=true');
  for(const patch of ["lifecycle='deleted'","lifecycle='active',access_status='denied'","access_status='accessible',is_test=true,test_evidence='test'"]){
   await db.pool.query('UPDATE sdr_crm_snapshots SET '+patch+" WHERE entity_id='A'");
   await expect(read()).rejects.toMatchObject({code:'lead_unavailable'});
  }
 });
 it('rechecks visibility after reassignment before read or save',async()=>{
  const current=await save();await db.pool.query("INSERT INTO sdr_drafts VALUES('A',$1,'pending')",[b.sub]);
  await expect(read()).rejects.toMatchObject({code:'lead_unavailable'});
  await expect(api.saveFollowupDraft(db.pool,{...options(),subject:'x',body:'x',expectedRevision:1,contextToken:current.contextToken})).rejects.toMatchObject({code:'lead_unavailable'});
  expect((await read(b)).draft).toBeNull();
 });
 it('uses source content identity, ignores collection timestamps, rejects changed context',async()=>{
  const current=await save();
  await db.pool.query("UPDATE sdr_crm_snapshots SET observed_at=now()+interval '1 day',source_read_started_at=now() WHERE entity_id='A'");
  expect((await read()).contextToken).toBe(current.contextToken);
  await db.pool.query("UPDATE sdr_crm_snapshots SET data=jsonb_set(data,'{title}','\"Renamed project\"') WHERE entity_id='A'");
  await expect(api.saveFollowupDraft(db.pool,{...options(),body:'Retain my text',subject:'s',expectedRevision:1,contextToken:current.contextToken})).rejects.toMatchObject({code:'context_changed',current:{context:{lead:{title:'Renamed project'}}}});
  await expect(save()).rejects.toMatchObject({code:'context_changed'});
  const accepted=await save({acknowledgeContext:true});expect(accepted.draft.revision).toBe(2);
 });
 it('detects notes, task edits and removed links without showing ambiguous records',async()=>{
  const original=await read();
  await db.pool.query("INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES('42','note','n','{\"content\":\"Call after Friday\"}'); INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42','note','n','lead','A','fixture')");
  const next=await read();expect(next.contextToken).not.toBe(original.contextToken);expect(next.context.records[0].text).toBe('Call after Friday');
  await db.pool.query("UPDATE sdr_crm_snapshots SET data=' {\"content\":\"Wait until next month\"}' WHERE entity_id='n'");
  expect((await read()).contextToken).not.toBe(next.contextToken);
  await db.pool.query("INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42','note','n','lead','PRIVATE','fixture')");
  expect((await read()).context.records).toEqual([]);
 });
 it('CAS rejects duplicate first saves and stale updates',async()=>{
  const current=await read(),input={...options(),body:'Draft',subject:'',expectedRevision:0,contextToken:current.contextToken};
  const results=await Promise.allSettled([api.saveFollowupDraft(db.pool,input),api.saveFollowupDraft(db.pool,input)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.find(r=>r.status==='rejected').reason.code).toBe('revision_conflict');
  await expect(api.saveFollowupDraft(db.pool,input)).rejects.toMatchObject({code:'revision_conflict'});
  expect((await read()).draft.revision).toBe(1);
 });
 it('withholds reads when CRM collection reports permission loss',async()=>{
  await db.pool.query("INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,error_category) VALUES('42','notes','error','permission')");
  await expect(read()).rejects.toMatchObject({code:'lead_unavailable'});
 });
 it('detects scoped hold state changes and hides unrelated global restrictions',async()=>{
  const before=await save();
  await db.pool.query("INSERT INTO sdr_outreach_controls(company_id,lead_id,scope_kind,scope_id,reason,context_hash,actor,owner_id) VALUES('42','A','lead','A','Confirm the contact','h','{}','staff'),('42',null,'recipient','other@example.test','Unrelated private hold','h','{}','staff')");
  const held=await read();expect(held.contextToken).not.toBe(before.contextToken);
  expect(held.context.holds).toHaveLength(1);expect(held.context.holds[0].reason).toBe('Confirm the contact');
  await db.pool.query("UPDATE sdr_outreach_controls SET provider_stop_status='confirmed' WHERE lead_id='A'");
  expect((await read()).contextToken).not.toBe(held.contextToken);
 });
 it('returns real scoped route conflicts without accepting client evidence or author overrides',async()=>{
  const handlers={};registerSdrFollowupDraftRoutes({get:(_p,h)=>handlers.read=h,put:(_p,h)=>handlers.save=h},{pool:db.pool,companyId:'42'});
  async function invoke(handler,body,viewer=a){const res={statusCode:200,status(s){this.statusCode=s;return this;},json(value){this.value=value;return this;}};await handler({params:{leadId:'A'},sdrUser:viewer,body},res);return res;}
  const initial=await invoke(handlers.read);
  const input={body:'Written manually',subject:'',expectedRevision:0,contextToken:initial.value.contextToken};
  expect((await invoke(handlers.save,input)).statusCode).toBe(200);
  const conflict=await invoke(handlers.save,input);expect(conflict.statusCode).toBe(409);expect(conflict.value.current.draft.body).toBe('Written manually');
  for(const field of ['author_id','viewer','companyId','context','recipient'])expect((await invoke(handlers.save,{...input,[field]:'attacker'})).statusCode).toBe(400);
  expect((await invoke(handlers.read,undefined,b)).value.draft).toBeNull();
  await db.pool.query("UPDATE sdr_users SET active=false WHERE id=$1",[a.sub]);
  const denied=await invoke(handlers.read);expect(denied.statusCode).toBe(403);expect(denied.value.current).toBeUndefined();
 });
 it('detects source timestamp edits and omits deal-linked or test records',async()=>{
  await db.pool.query("INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at) VALUES('42','activity','task','{\"type\":\"call\",\"done\":false,\"subject\":\"Call buyer\"}','2026-10-01'); INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42','activity','task','lead','A','fixture')");
  const original=await read();expect(original.context.records[0]).toMatchObject({type:'call',done:false,subject:'Call buyer'});
  await db.pool.query("UPDATE sdr_crm_snapshots SET source_updated_at='2026-10-02' WHERE entity_id='task'");
  expect((await read()).contextToken).not.toBe(original.contextToken);
  await db.pool.query("INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42','activity','task','deal','unknown','fixture')");
  expect((await read()).context.records).toEqual([]);
 });
 it('validates limits and forbidden fields and preserves stored draft on failure',async()=>{
  await save();
  for(const fields of [{body:''},{subject:'x'.repeat(501)},{body:'x'.repeat(20001)},{expectedRevision:-1},{recipient:'x@example.test'},{contextToken:'fake'}])await expect(save(fields)).rejects.toBeDefined();
  expect((await read()).draft.revision).toBe(1);
 });
});
