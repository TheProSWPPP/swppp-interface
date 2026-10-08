import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
let api;try{api=await import('../sdrReplyActionBacklog.js');}catch{api={};}
const db=reportingTestDb('reply_backlog');
const viewer={sub:'00000000-0000-0000-0000-000000000001',role:'admin'};
const read=(extra={})=>api.readReplyActionBacklog(db.pool,{companyId:'42',viewer,resolveVisibleMailboxes:async()=>['STAFF@example.com'],...extra});
async function action({lead=null,link=lead?'verified':'unlinked',mailbox='staff@example.com',messageMailbox=mailbox,status='failed',kind='forward',reason='completion_uncertain',payload={},created='2020-01-01T00:00:00Z',review=true}={}){
 const id=randomUUID(),message=randomUUID();
 await db.pool.query(`INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,mailbox_email,received_at,pipedrive_lead_id,link_status,reply_kind) VALUES($1,'gmail',$1,$2,now(),$3,$4,'human')`,[message,messageMailbox,lead,link]);
 await db.pool.query(`INSERT INTO sdr_reply_actions(id,provider_message_id,mailbox_email,kind,target_key,payload,status,safe_error,created_at,requires_review,attempts,retry_at) VALUES($1,$2,$3,$4,'secret target',$5,$6,$7,$8,$9,2,'2030-01-01')`,[id,message,mailbox,kind,payload,status,reason,created,review]);return id;
}
(db?describe:describe.skip)('read-only admin reply-action backlog',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-02-sdr-reporting.sql',import.meta.url),'utf8'));await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-03-sdr-reply-actions.sql',import.meta.url),'utf8'));await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-05-sdr-crm-observations.sql',import.meta.url),'utf8'));await db.pool.query('CREATE TABLE sdr_users(id uuid PRIMARY KEY,role text,active boolean);CREATE TABLE sdr_lead_state(pipedrive_lead_id text,crm_company_id text)');});
 afterAll(()=>db.close());
 beforeEach(async()=>{vi.stubGlobal('fetch',vi.fn(()=>{throw Error('external forbidden');}));await db.pool.query('TRUNCATE sdr_message_facts,sdr_reply_actions,sdr_reply_messages,sdr_users,sdr_lead_state,sdr_crm_snapshots,sdr_crm_scope_coverage CASCADE');await db.pool.query("INSERT INTO sdr_users VALUES($1,'admin',true);",[viewer.sub]);await db.pool.query("INSERT INTO sdr_lead_state VALUES('A','42'),('B','other'),('T','42');INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data,is_test) VALUES('42','lead','A','{}',false),('other','lead','B','{}',false),('42','lead','T','{}',false);UPDATE sdr_crm_snapshots SET is_test=true,test_evidence='fixture' WHERE entity_id='T'");});
 afterEach(()=>{expect(globalThis.fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();});
 it('counts all-age technical actions and returns only safe metadata',async()=>{
  await action({lead:'A'});await action({kind:'create_note',status:'pending',reason:'rate_limit',review:false});await action({status:'running',reason:'raw secret customer@example.com'});await action({status:'completed'});await action({status:'skipped'});
  const result=await read();expect(result).toMatchObject({state:'available',total:3,limit:50,coverage:'partial',unverified:2,groups:[{kind:'create_note',count:1},{kind:'forward',count:2}]});expect(new Date(result.oldestCreatedAt).getUTCFullYear()).toBe(2020);
  expect(result.items[0]).toHaveProperty('attempts',2);expect(result.items.map(i=>i.reason)).toContain('unclassified');
  const json=JSON.stringify(result);for(const secret of ['secret target','customer@example.com','provider_message_id','source_message_id','mailbox','payload'])expect(json).not.toContain(secret);
  expect((await db.pool.query('SELECT count(*)::int n FROM sdr_reply_actions')).rows[0].n).toBe(5);
 });
 it('separates historical action reason from current stored classification and link without interpreting it',async()=>{
  const id=await action({link:'ambiguous',reason:'lead_unlinked'});
  await db.pool.query("UPDATE sdr_reply_messages SET reply_kind='auto',intent='nurture' WHERE provider_message_id=(SELECT provider_message_id FROM sdr_reply_actions WHERE id=$1)",[id]);
  const r=await read();expect(r.total).toBe(1);expect(r.items[0]).toMatchObject({reason:'lead_unlinked',currentStoredLink:'ambiguous',recordedReply:{kind:'auto',intent:'nurture'}});expect(r.items[0].recordedReply.receivedAt).toBeTruthy();expect(r.items[0].recordedReply.recordedAt).toBeTruthy();
  await db.pool.query("UPDATE sdr_reply_messages SET intent='sensitive free text'");expect((await read()).items[0].recordedReply.intent).toBeNull();
 });
 it('excludes wrong mailboxes, cross-company, test, missing or ambiguous linked scope',async()=>{
  await action({lead:'A'});await action({lead:'B'});await action({lead:'T'});await action({lead:'missing'});await action({lead:'A',link:'ambiguous'});await action({mailbox:'other@example.com'});await action({messageMailbox:'other@example.com'});await action({payload:{leadId:'B'}});await action({lead:'A',payload:{leadId:'B'}});
  expect((await read()).total).toBe(1);
  await db.pool.query("INSERT INTO sdr_crm_snapshots(company_id,entity,entity_id,data) VALUES('other','lead','A','{}')");expect((await read()).total).toBe(0);
 });
 it('excludes exact marked-test message facts including unbound replies',async()=>{
  const id=await action();await action();
  await db.pool.query(`INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,link_status,is_test) SELECT m.source,m.source_message_id,'in',upper(m.mailbox_email),'synthetic@example.test','unmatched',true FROM sdr_reply_messages m JOIN sdr_reply_actions a ON a.provider_message_id=m.provider_message_id WHERE a.id=$1`,[id]);
  expect((await read()).total).toBe(1);
 });
 it('withholds conflicting exact message-fact project identities',async()=>{
  const id=await action();await action({lead:'A'});
  await db.pool.query(`INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,link_status,pipedrive_lead_id) SELECT m.source,m.source_message_id,'in',m.mailbox_email,'synthetic@example.test','verified','B' FROM sdr_reply_messages m JOIN sdr_reply_actions a ON a.provider_message_id=m.provider_message_id WHERE a.id=$1`,[id]);
  expect((await read()).total).toBe(1);
 });
 it('bounds rows without truncating the all-age total and group counts',async()=>{
  for(let i=0;i<55;i++)await action({created:new Date(Date.UTC(2020,0,1+i)).toISOString()});const r=await read();expect(r.total).toBe(55);expect(r.items).toHaveLength(50);expect(r.groups).toEqual([{kind:'forward',count:55}]);expect(new Date(r.items[49].createdAt).toISOString()).toBe('2020-02-19T00:00:00.000Z');
 });
 it('requires a current active admin and company before resolving mailboxes',async()=>{
  let calls=0;const resolve=async()=>{calls++;return ['staff@example.com'];};
  for(const bad of [null,{...viewer,machine:true},{...viewer,role:'sdr'},{...viewer,sub:'machine'}])await expect(read({viewer:bad,resolveVisibleMailboxes:resolve})).rejects.toMatchObject({code:'admin_required'});
  await expect(read({companyId:'',resolveVisibleMailboxes:resolve})).rejects.toMatchObject({code:'backlog_unavailable'});
  await db.pool.query("UPDATE sdr_users SET role='sdr'");await expect(read({resolveVisibleMailboxes:resolve})).rejects.toMatchObject({code:'admin_required'});
  await db.pool.query("UPDATE sdr_users SET role='admin',active=false");await expect(read({resolveVisibleMailboxes:resolve})).rejects.toMatchObject({code:'admin_required'});expect(calls).toBe(0);
 });
 it('distinguishes empty scope and unavailable collection',async()=>{
  expect(await read({resolveVisibleMailboxes:async()=>[]})).toMatchObject({state:'available',total:0,items:[]});
  await db.pool.query('ALTER TABLE sdr_reply_actions RENAME TO hidden_actions');try{await expect(read()).rejects.toBeTruthy();}finally{await db.pool.query('ALTER TABLE hidden_actions RENAME TO sdr_reply_actions');}
  await db.pool.query("INSERT INTO sdr_crm_scope_coverage(company_id,scope,status,error_category) VALUES('42','lead','error','permission')");await expect(read()).rejects.toMatchObject({code:'backlog_unavailable'});
 });
 it('runs reads within one repeatable read read-only transaction and rolls back errors',async()=>{
  const client=await db.pool.connect();let isolation;const wrapper={connect:async()=>({query:async(...args)=>{if(String(args[0]).startsWith('SELECT id,'))isolation=(await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation;return client.query(...args);},release:()=>client.release()})};
  await api.readReplyActionBacklog(wrapper,{companyId:'42',viewer,resolveVisibleMailboxes:async()=>{const r=await client.query('SHOW transaction_read_only');expect(r.rows[0].transaction_read_only).toBe('on');return ['staff@example.com'];}});expect(isolation).toBe('repeatable read');
 });
});
