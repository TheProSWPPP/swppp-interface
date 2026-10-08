import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import {readFollowupProjectContext} from '../sdrFollowupProjectContext.js';
import {reportingTestDb} from './reportingTestDb.js';
import {registerSdrCrmObservationRoutes} from '../sdrCrmObservationRoutes.js';
const db=reportingTestDb('followup_project_context');
const staff={role:'sdr',sub:'00000000-0000-0000-0000-00000000000a'};
const other={role:'sdr',sub:'00000000-0000-0000-0000-00000000000b'};
const admin={role:'admin',sub:'00000000-0000-0000-0000-00000000000c'};
const routes=new Map();
const record=async(entity,id,data,url=null)=>db.pool.query(`INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,source_updated_at,source_url) VALUES('42',$1,$2,$3,'2026-10-08',$4)`,[entity,id,data,url]);
const link=async(entity,id,type='lead',target='A')=>db.pool.query(`INSERT INTO sdr_crm_links(company_id,entity,entity_id,link_type,linked_id,evidence) VALUES('42',$1,$2,$3,$4,'fixture')`,[entity,id,type,target]);
async function read(viewer=staff,leadId='A',query={}){
 const handler=routes.get('/api/sdr/crm/leads/:leadId/followup-context');expect(handler).toBeTypeOf('function');
 const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(s){this.statusCode=s;return this;},json(value){this.value=value;return this;}};
 await handler({params:{leadId},sdrUser:viewer,query},res);return res;
}
(db?describe:describe.skip)('current collected follow-up project context',()=>{
 beforeAll(async()=>{await db.setup();
  for(const file of ['2026-10-05-sdr-crm-observations.sql','2026-10-07-sdr-outreach-controls.sql'])await db.pool.query(await fs.readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  await db.pool.query('CREATE TABLE sdr_users(id uuid PRIMARY KEY,role text,active boolean); CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,crm_company_id text); CREATE TABLE sdr_drafts(pipedrive_lead_id text,assigned_user_id uuid,status text)');
  registerSdrCrmObservationRoutes({get:(p,h)=>routes.set(p,h)},{pool:db.pool,companyId:'42',canViewLead:async()=>true});
 });
 afterAll(()=>db.close());
 beforeEach(async()=>{vi.stubGlobal('fetch',vi.fn(()=>{throw Error('External request forbidden');}));
  await db.pool.query('TRUNCATE sdr_crm_snapshots,sdr_crm_links,sdr_crm_scope_coverage,sdr_lead_state,sdr_drafts,sdr_users,sdr_outreach_controls CASCADE');
  for(const u of [staff,other,admin])await db.pool.query('INSERT INTO sdr_users VALUES($1,$2,true)',[u.sub,u.role]);
  await db.pool.query("INSERT INTO sdr_lead_state VALUES('A','42'),('B','foreign')");
  await record('lead','A',{title:'Project A',owner_id:{id:7,name:'Owner'},person_id:12},'https://proswpppllc.pipedrive.com/leads/inbox/A');
  await record('person','12',{name:'Buyer',email:[{value:' BUYER@example.test ',primary:true}]});
 });
 afterEach(()=>{expect(globalThis.fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();});
 it('returns project identity without requiring or disclosing private drafts',async()=>{
  const r=await read();expect(r.statusCode).toBe(200);expect(r.headers['Cache-Control']).toBe('no-store');
  expect(r.value.lead).toMatchObject({id:'A',title:'Project A',ownerId:'7',contactName:'Buyer',contactEmail:'buyer@example.test',sourceUrl:'https://proswpppllc.pipedrive.com/leads/inbox/A'});
  expect(r.value).toMatchObject({openTaskCount:0,tasks:[],coverage:{partial:true,quoteStatus:'unknown',orderStatus:'unknown'}});
  expect(r.value.draft).toBeUndefined();
 });
 it('counts all open tasks before the preview limit without letting recent notes hide old dates',async()=>{
  for(let i=0;i<23;i++){await record('activity',`task-${String(i).padStart(2,'0')}`,{done:false,type:'call',subject:'Call buyer',note:'Keep promise',owner_id:99,due_date:i===0?'2020-01-02':'2026-10-01',due_time:'14:30'});await link('activity',`task-${String(i).padStart(2,'0')}`);}
  for(let i=0;i<25;i++){await record('note',`note-${i}`,{content:'Newer note'});await link('note',`note-${i}`);}
  const r=await read();expect(r.value.openTaskCount).toBe(23);expect(r.value.tasks).toHaveLength(20);expect(r.value.tasksLimited).toBe(true);
  expect(r.value.tasks[0]).toMatchObject({id:'task-00',dueDate:'2020-01-02',dueTime:'14:30',ownerId:'99',subject:'Call buyer',note:'Keep promise'});
 });
 it('withholds ambiguous, deal-linked, test, deleted and inaccessible tasks and unsafe URLs',async()=>{
  for(const id of ['safe','foreign','deal','test','deleted','denied']){await record('activity',id,{done:false,subject:id},'https://proswpppllc.pipedrive.com/leads/inbox/OTHER');await link('activity',id);}
  await link('activity','foreign','lead','B');await link('activity','deal','deal','d');
  await db.pool.query("UPDATE sdr_crm_snapshots SET is_test=true,test_evidence='fixture' WHERE entity_id='test'; UPDATE sdr_crm_snapshots SET lifecycle='deleted' WHERE entity_id='deleted'; UPDATE sdr_crm_snapshots SET access_status='denied' WHERE entity_id='denied'");
  const r=await read();expect(r.value.openTaskCount).toBe(1);expect(r.value.tasks[0]).toMatchObject({id:'safe',sourceUrl:null});
 });
 it('honors recipient/channel restrictions and never exposes unrelated holds',async()=>{
  const holds=[['lead','A','A',null],['recipient','buyer@example.test',null,'email'],['channel','email',null,null],['recipient','buyer@example.test','B','email'],['recipient','buyer@example.test',null,'linkedin'],['recipient','unrelated@example.test',null,null]];
  for(const [kind,id,leadId,channel] of holds)await db.pool.query("INSERT INTO sdr_outreach_controls(company_id,scope_kind,scope_id,lead_id,channel,reason,context_hash,actor,owner_id) VALUES('42',$1,$2,$3,$4,'Review contact','h','{}','staff')",[kind,id,leadId,channel]);
  const r=await read();expect(r.value.holds).toHaveLength(3);expect(r.value.holds.map(h=>h.scopeKind).sort()).toEqual(['channel','lead','recipient']);
 });
 it('fails closed on current sessions, tenant, visibility and permission coverage',async()=>{
  for(const viewer of [{...staff,machine:true},{...staff,role:'admin'},{role:'admin',sub:'machine'},null])expect((await read(viewer)).statusCode).toBe(403);
  expect((await read(admin,'B')).statusCode).toBe(404);
  await db.pool.query("INSERT INTO sdr_drafts VALUES('A',$1,'pending')",[other.sub]);expect((await read()).statusCode).toBe(404);expect((await read(other)).statusCode).toBe(200);
  await db.pool.query('UPDATE sdr_users SET active=false WHERE id=$1',[other.sub]);expect((await read(other)).statusCode).toBe(403);
  await db.pool.query("INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,error_category) VALUES('42','notes','error','permission')");expect((await read(admin)).statusCode).toBe(404);
 });
 it('returns recent note provenance while keeping completion time and authorship unverified',async()=>{
  const at=new Date(Date.now()-3600000).toISOString().replace(/\.\d{3}Z$/,'Z');
  await record('note','n',{content:'<p>Owner asks to wait</p>',update_time:at,add_time:at},'https://proswpppllc.pipedrive.com/leads/inbox/A');await link('note','n');
  await record('activity','c',{done:true,type:'call',subject:'Reviewed',note:'Called buyer',update_time:at});await link('activity','c');
  await db.pool.query("UPDATE sdr_crm_snapshots SET source_updated_at=$1 WHERE entity_id IN ('n','c')",[at]);
  const r=await read();expect(r.value.recentRecords.note).toMatchObject({id:'n',originStatus:'unknown',text:'Owner asks to wait',sourceUpdatedAt:at.replace('Z','.000Z')});expect(r.value.recentRecords.completedCall).toMatchObject({id:'c',originStatus:'unknown',eventAt:null});expect(r.value.openTaskCount).toBe(0);
 });
 it('enforces actual read-only repeatable-read isolation and a bounded statement timeout',async()=>{
  const client=await db.pool.connect();let checked=false;
  const pool={connect:async()=>({query:async(...args)=>{if(String(args[0]).startsWith('SELECT 1 FROM sdr_users')){checked=true;expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on');expect((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read');expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('5s');}return client.query(...args);},release:()=>client.release()})};
  await readFollowupProjectContext(pool,{companyId:'42',leadId:'A',viewer:staff});expect(checked).toBe(true);
 });
 it('shows real active and archived lead collection scope receipts',async()=>{
  await db.pool.query("INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,checked_at) VALUES('42','leads_active','complete',now()),('42','leads_archived','partial',now())");
  const r=await read();expect(r.value.coverage.scopes.map(s=>s.scope).sort()).toEqual(['leads_active','leads_archived']);
 });
 it('rejects query overrides and fail-closes test/deleted/inaccessible project sources',async()=>{
  expect((await read(staff,'A',{companyId:'other'})).statusCode).toBe(400);
  for(const patch of ["lifecycle='deleted'","lifecycle='active',access_status='denied'","access_status='accessible',is_test=true,test_evidence='fixture'"]){await db.pool.query('UPDATE sdr_crm_snapshots SET '+patch+" WHERE entity='lead'");expect((await read()).statusCode).toBe(404);}
 });
});
