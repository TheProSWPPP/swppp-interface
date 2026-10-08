import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import {registerSdrOperationsSnapshotRoutes} from '../sdrOperationsSnapshotRoutes.js';
import {reportingTestDb} from './reportingTestDb.js';
let api;try{api=await import('../sdrOperationsSnapshot.js');}catch{api={};}
const db=reportingTestDb('operations_snapshot');
const viewer={sub:'00000000-0000-0000-0000-000000000001',role:'admin'};
const mailbox='staff@example.test';
const read=async(extra={})=>{expect(api.readOperationsSnapshot).toBeTypeOf('function');return api.readOperationsSnapshot(db.pool,{companyId:'42',viewer,resolveVisibleMailboxes:async()=>[mailbox],...extra});};
async function lead(id,{company='42',crm='active',status='clear',email='buyer@example.test',verify='valid',value=email,at='2026-10-08',flag=null,snapshot=true}={}){
 await db.pool.query('INSERT INTO sdr_lead_state VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,company,crm,status,email,verify,value,at,flag]);
 if(snapshot)await db.pool.query("INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES($1,'lead',$2,'{}')",[company,id]);
}
async function fact(id,{leadId='A',link='verified',mail=mailbox,status='completed',classification='sales_outreach',evidence='exact fixture',test=false,at='2026-10-08'}={}){
 await db.pool.query("INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,pipedrive_lead_id,link_status,provider_status,occurred_at,outreach_classification,classification_evidence,is_test) VALUES('apollo',$1,'out',$2,'buyer@example.test',$3,$4,$5,$6,$7,$8,$9)",[id,mail,leadId,link,status,at,classification,evidence,test]);
}
(db?describe:describe.skip)('admin collected operations snapshot',()=>{
 beforeAll(async()=>{await db.setup();
  for(const file of ['2026-10-02-sdr-reporting.sql','2026-10-04-sdr-metric-evidence.sql','2026-10-03-sdr-reply-actions.sql','2026-10-05-sdr-crm-observations.sql','2026-10-07-sdr-outreach-controls.sql'])await db.pool.query(await fs.readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  await db.pool.query(`CREATE TABLE sdr_users(id uuid PRIMARY KEY,role text,active boolean);
   CREATE TABLE sdr_lead_state(pipedrive_lead_id text,crm_company_id text,crm_status text,outreach_status text,person_email text,email_verify_status text,email_verified_value text,email_verified_at timestamptz,email_flag text);
   CREATE TABLE sdr_mailboxes(id text,email text);CREATE TABLE sdr_drafts(id text,pipedrive_lead_id text,status text);
   CREATE TABLE sdr_sends(id text,draft_id text,pipedrive_lead_id text,mailbox_id text,status text,sent_at timestamptz);`);
 });
 afterAll(()=>db.close());
 beforeEach(async()=>{vi.stubGlobal('fetch',vi.fn(()=>{throw Error('External request forbidden');}));
  await db.pool.query('TRUNCATE sdr_users,sdr_lead_state,sdr_crm_snapshots,sdr_crm_scope_coverage,sdr_outreach_controls,sdr_reply_messages,sdr_message_facts,sdr_drafts,sdr_sends,sdr_mailboxes,sdr_job_runs CASCADE');
  await db.pool.query("INSERT INTO sdr_users VALUES($1,'admin',true)",[viewer.sub]);await db.pool.query("INSERT INTO sdr_mailboxes VALUES('m',$1),('foreign','foreign@example.test')",[mailbox]);
 });
 afterEach(()=>{expect(globalThis.fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();});
 it('keeps inventory, snapshots, and active intersection distinct while excluding conflicting identities',async()=>{
  await lead('A');await lead('no-snapshot',{snapshot:false});await lead('inactive',{crm:'archived'});await lead('foreign',{company:'elsewhere'});await lead('test');await lead('conflict');
  await db.pool.query("UPDATE sdr_crm_snapshots SET is_test=true,test_evidence='fixture' WHERE entity_id='test'; INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES('elsewhere','lead','conflict','{}'),('42','lead','snapshot-only','{}')");
  const r=await read();expect(r.inventory).toEqual({total:3,byOutreachStatus:[{status:'clear',count:3}]});expect(r.crm.activeSnapshots).toBe(3);expect(r.contacts.denominator).toBe(1);expect(r.eligibleSupply).toBeNull();
 });
 it('partitions current-address verification without turning recorded clear into eligibility',async()=>{
  const now=new Date();const recent=new Date(+now-86400000).toISOString(),old=new Date(+now-91*86400000).toISOString(),future=new Date(+now+86400000).toISOString();
  await lead('missing',{email:null});await lead('bad',{flag:'email_bad',verify:null});await lead('unknown',{verify:'new_vendor_status'});await lead('no-time',{at:null});await lead('mismatch',{value:'former@example.test'});await lead('future',{at:future});await lead('stale',{at:old});await lead('valid',{email:' BUYER@EXAMPLE.TEST ',value:'buyer@example.test',at:recent});await lead('soft',{verify:'catch_all',at:recent});await lead('hard',{verify:'invalid',at:recent});
  const r=await read();expect(r.contacts.denominator).toBe(10);expect(r.contacts.buckets).toEqual({missing:1,email_bad:1,unverified:2,address_changed:1,future:1,stale:1,valid:1,soft:1,hard_failure:1});expect(Object.values(r.contacts.buckets).reduce((a,b)=>a+b,0)).toBe(10);expect(r.eligibleSupply).toBeNull();
 });
 it('counts overlapping project context without leaking hold details or ignoring optional restrictions',async()=>{
  await lead('A');await lead('B',{email:'other@example.test'});
  const holds=[['lead','A','A',null],['recipient','buyer@example.test',null,'email'],['recipient','other@example.test','A','email'],['recipient','other@example.test',null,'linkedin'],['channel','email',null,null],['service','writer','A',null]];
  for(const [kind,id,leadId,channel] of holds)await db.pool.query("INSERT INTO sdr_outreach_controls(company_id,scope_kind,scope_id,lead_id,channel,reason,context_hash,actor,owner_id) VALUES('42',$1,$2,$3,$4,'Secret reason','h','{}','staff')",[kind,id,leadId,channel]);
  await db.pool.query("INSERT INTO sdr_drafts VALUES('d','A','pending')");await db.pool.query("INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,mailbox_email,received_at,pipedrive_lead_id,link_status,reply_kind) VALUES('r','gmail','r',$1,now(),'A','verified','human')",[mailbox]);
  const r=await read();expect(r.projectContext).toMatchObject({leadOrRecipientHold:1,emailChannelHold:2,storedHumanReply:1,openDraft:1});expect(r.controls).toEqual({lead:1,recipient:3,draft:0,service:1,channel:1});expect(JSON.stringify(r)).not.toContain('Secret reason');expect(JSON.stringify(r)).not.toContain('buyer@example.test');
 });
 it('keeps local enrollments separate from completed Apollo message facts and unknown classifications',async()=>{
  await lead('A');await lead('foreign',{company:'elsewhere'});
  await db.pool.query("INSERT INTO sdr_drafts VALUES('d','A','sent');INSERT INTO sdr_sends VALUES('s','d','A','m','enrolled',now()),('s2','d','A','m','failed',now()),('s3','d','A','foreign','enrolled',now())");
  const at=new Date().toISOString();await fact('linked',{at});await fact('unknown',{leadId:null,link:'unmatched',evidence:null,at});await fact('other',{classification:'warmup',at});await fact('pending',{status:'scheduled',at});await fact('foreign',{leadId:'foreign',at});await fact('test',{test:true,at});await fact('old',{at:'2020-01-01'});await fact('wrongmail',{mail:'foreign@example.test',at});await fact('conflict',{leadId:'A',link:'ambiguous',at});
  const r=await read();expect(r.enrollments).toMatchObject({rows:2,projects:1,byStatus:[{status:'enrolled',count:1},{status:'failed',count:1}]});expect(r.completedMessages).toMatchObject({total:3,verifiedProjectLinked:2,unlinkedObservations:1,sales:1,unknownClassification:1,otherClassification:1});
 });
 it('shows missing expected collection jobs and a newer partial attempt separately from last complete',async()=>{
  await db.pool.query("INSERT INTO sdr_job_runs(job,scope,status,started_at,finished_at,counts) VALUES('apollo_messages',$1,'complete',now()-interval '2 hours',now()-interval '90 minutes','{\"all_sequences\":true}'),('apollo_messages',$1,'partial',now()-interval '1 hour',now()-interval '50 minutes','{}')",[mailbox]);
  const r=await read();expect(r.coverage.jobs).toHaveLength(2);expect(r.coverage.jobs.find(j=>j.job==='apollo_messages')).toMatchObject({status:'partial'});expect(r.coverage.jobs.find(j=>j.job==='apollo_messages').lastCompleteAt).toBeTruthy();expect(r.coverage.jobs.find(j=>j.job==='gmail_messages')).toMatchObject({status:'missing',lastCompleteAt:null});expect(r.coverage.partial).toBe(true);
 });
 it('preserves archived delivery history and switched enrollments outside the active contact cohort',async()=>{
  await lead('archived',{crm:'archived'});await db.pool.query("UPDATE sdr_crm_snapshots SET lifecycle='archived' WHERE entity_id='archived';INSERT INTO sdr_drafts VALUES('old-draft','archived','sent');INSERT INTO sdr_sends VALUES('old-send','old-draft','archived','m','switched',now())");
  await fact('old-project-message',{leadId:'archived',at:new Date().toISOString()});
  const r=await read();expect(r.contacts.denominator).toBe(0);expect(r.enrollments).toMatchObject({rows:1,projects:1,byStatus:[{status:'switched',count:1}]});expect(r.completedMessages.total).toBe(1);expect(r.projectContext.localEnrollment).toBe(0);
 });
 it('reports actual mailbox and account runtime jobs separately from historical message collectors',async()=>{
  await db.pool.query("INSERT INTO sdr_job_runs(job,scope,status,started_at,finished_at) VALUES('gmail_watch',$1,'complete',now()-interval '10 minutes',now()-interval '9 minutes'),('gmail_watch',$1,'failed',now()-interval '2 minutes',now()-interval '1 minute'),('apollo_poll','account','partial',now(),now())",[mailbox]);
  const r=await read();expect(r.coverage.runtimeJobs).toHaveLength(3);expect(r.coverage.runtimeJobs.find(j=>j.job==='gmail_watch')).toMatchObject({status:'failed',scope:mailbox});expect(r.coverage.runtimeJobs.find(j=>j.job==='gmail_watch').lastCompleteAt).toBeTruthy();expect(r.coverage.runtimeJobs.find(j=>j.job==='apollo_poll')).toMatchObject({status:'partial',scope:'account'});expect(r.coverage.runtimeJobs.find(j=>j.job==='enrollment')).toMatchObject({status:'missing'});expect(r.coverage.jobs.every(j=>j.status==='missing')).toBe(true);
 });
 it('requires current interactive admin, configured company, visible mailboxes and intact permission coverage',async()=>{
  for(const bad of [null,{...viewer,machine:true},{...viewer,role:'sdr'},{...viewer,sub:'machine'}])await expect(read({viewer:bad})).rejects.toMatchObject({code:'admin_required'});
  await expect(read({companyId:''})).rejects.toMatchObject({code:'operations_unavailable'});
  await db.pool.query("UPDATE sdr_users SET role='sdr'");await expect(read()).rejects.toMatchObject({code:'admin_required'});
  await db.pool.query("UPDATE sdr_users SET role='admin',active=false");await expect(read()).rejects.toMatchObject({code:'admin_required'});
  await db.pool.query("UPDATE sdr_users SET active=true;INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,error_category) VALUES('42','leads','error','permission')");await expect(read()).rejects.toMatchObject({code:'operations_unavailable'});
 });
 it('keeps empty mailbox scope separate from unavailable data and lists missing coverage per expected mailbox',async()=>{
  await lead('A');await fact('visible',{at:new Date().toISOString()});
  const empty=await read({resolveVisibleMailboxes:async()=>[]});expect(empty.completedMessages.total).toBe(0);expect(empty.enrollments.rows).toBe(0);expect(empty.coverage.visibleMailboxes).toBe(0);expect(empty.coverage.jobs).toEqual([]);expect(empty.contacts.denominator).toBe(1);
  const multiple=await read({resolveVisibleMailboxes:async()=>[mailbox,'another@example.test']});expect(multiple.coverage.jobs).toHaveLength(4);expect(multiple.coverage.runtimeJobs.filter(j=>j.job==='gmail_watch')).toHaveLength(2);expect(multiple.coverage.jobs.every(j=>j.status==='missing')).toBe(true);
 });
 it('withholds conflicting reply facts and sanitizes collection metadata',async()=>{
  await lead('A');await db.pool.query("INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,mailbox_email,received_at,pipedrive_lead_id,link_status,reply_kind) VALUES('r','gmail','r',$1,now(),'A','verified','human')",[mailbox]);
  await db.pool.query("INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,pipedrive_lead_id,link_status) VALUES('gmail','r','in',$1,'x@example.test','FOREIGN','verified')",[mailbox]);
  await db.pool.query("INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,error_category) VALUES('42','leads_active','error','secret@example.test'),('42','private scope','partial',null)");
  const r=await read();expect(r.projectContext.storedHumanReply).toBe(0);expect(r.coverage.crmScopes).toHaveLength(1);expect(r.coverage.crmScopes[0].errorCategory).toBe('collection_error');expect(JSON.stringify(r)).not.toContain('secret@example.test');expect(JSON.stringify(r)).not.toContain('private scope');
 });
 it('serves the registered route using real scoped SQL and rechecks a role change',async()=>{
  await lead('A');let handler;registerSdrOperationsSnapshotRoutes({get:(_p,h)=>handler=h},{pool:db.pool,companyId:'42',resolveVisibleMailboxes:async()=>[mailbox]});
  const response=()=>({code:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(v){this.code=v;return this;},json(v){this.value=v;return this;}});
  const good=response();await handler({sdrUser:viewer,query:{}},good);expect(good.code).toBe(200);expect(good.value.contacts.denominator).toBe(1);
  await db.pool.query("UPDATE sdr_users SET active=false");const denied=response();await handler({sdrUser:viewer,query:{}},denied);expect(denied.code).toBe(403);expect(denied.value.inventory).toBeUndefined();
 });
 it('retains every actual CRM collection scope including active and archived lead and deal reads',async()=>{
  const scopes=['leads_active','leads_archived','deals','deals_archived','activities','notes','persons','organizations'];
  for(const scope of scopes)await db.pool.query("INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,checked_at) VALUES('42',$1,'partial',now())",[scope]);
  const r=await read();expect(r.coverage.crmScopes.map(s=>s.scope).sort()).toEqual([...scopes].sort());expect(r.coverage.crmScopes.every(s=>s.checkedAt&&s.status==='partial')).toBe(true);
 });
 it('uses real repeatable-read read-only isolation with bounded statement timeout',async()=>{
  expect(api.readOperationsSnapshot).toBeTypeOf('function');const client=await db.pool.connect();const pool={connect:async()=>({query:(...args)=>client.query(...args),release:()=>client.release()})};
  expect(api.readOperationsSnapshot).toBeTypeOf('function');await api.readOperationsSnapshot(pool,{companyId:'42',viewer,resolveVisibleMailboxes:async()=>{expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on');expect((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read');expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('5s');return [];}});
 });
});
