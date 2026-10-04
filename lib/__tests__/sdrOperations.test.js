import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {readRecentReplies} from '../sdrOperations.js';
const db=reportingTestDb('operations');
const pool=db?.pool;
const asOf='2026-10-03T12:00:00Z';
const options={visibleMailboxes:['rep@example.test'],asOf,now:new Date(asOf)};
describe.skipIf(!pool)('recent reply local SQL',()=>{
 beforeAll(async()=>{
  await db.setup();
  for(const name of ['2026-10-02-sdr-reporting.sql','2026-10-03-sdr-reply-actions.sql','2026-10-03-sdr-reply-visibility.sql']) await pool.query(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));
  await pool.query('CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,lead_title text,person_email text,owner_name text)');
 });
 afterAll(async()=>{await db.close();});
 beforeEach(async()=>{
  await pool.query('TRUNCATE sdr_reply_actions,sdr_reply_messages,sdr_reply_routes,sdr_message_facts,sdr_job_runs,sdr_lead_state');
  await pool.query(`INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,thread_id,mailbox_email,received_at,detected_at,reply_kind,link_status,pipedrive_lead_id,link_evidence,intent)
   SELECT 'reply-'||lpad(n::text,2,'0'),'gmail','gmail-'||n,'thread-'||n,'rep@example.test','2026-10-03T10:00:00Z'::timestamptz,'2026-10-03T11:00:00Z'::timestamptz,'human',CASE n%3 WHEN 0 THEN 'verified' WHEN 1 THEN 'ambiguous' ELSE 'unlinked' END,'project-a','local enrollment','interested' FROM generate_series(1,30) n`);
  await pool.query(`INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,mailbox_email,received_at,detected_at,reply_kind,link_status) VALUES
   ('other','gmail','other','other@example.test','2026-10-03T10:00:00Z','2026-10-03T11:00:00Z','human','unlinked'),
   ('auto','gmail','auto','rep@example.test','2026-10-03T10:00:00Z','2026-10-03T11:00:00Z','auto','unlinked'),
   ('bounce','gmail','bounce','rep@example.test','2026-10-03T10:00:00Z','2026-10-03T11:00:00Z','bounce','unlinked'),
   ('future-detection','gmail','future','rep@example.test','2026-10-03T10:00:00Z','2026-10-03T12:00:00.001Z','human','unlinked')`);
  await pool.query(`INSERT INTO sdr_lead_state VALUES('project-a','Verified local project','DO NOT GUESS CONTACT','DO NOT GUESS OWNER');
   INSERT INTO sdr_reply_routes VALUES('rep@example.test','PRIVATE ROUTE',42,'2026-10-01T00:00:00Z',true);
   INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,link_status) VALUES
    ('gmail','gmail-30','in','rep@example.test','buyer@example.test','verified'),
    ('gmail','gmail-29','in','other@example.test','PRIVATE OTHER BUYER','unmatched'),
    ('apollo','gmail-28','in','rep@example.test','WRONG PROVIDER','unmatched');
   INSERT INTO sdr_reply_actions(id,provider_message_id,mailbox_email,kind,target_key,payload,status,safe_error,receipt_at)
    VALUES(gen_random_uuid(),'reply-30','rep@example.test','forward','PRIVATE TARGET','{"body":"PRIVATE BODY"}','completed','PRIVATE ERROR','2026-10-03T11:30:00Z')`);
 });
 it('reconciles 30 scoped human replies across tied timestamp pages and preserves unknown response despite completed actions',async()=>{
  const page=await readRecentReplies(pool,{...options,limit:25});
  expect(page.total).toBe(30);expect(page.items).toHaveLength(25);expect(page.items.every(r=>r.mailbox==='rep@example.test')).toBe(true);
  const next=await readRecentReplies(pool,{...options,asOf:page.context.asOf,cursor:page.nextCursor});
  expect(next.total).toBe(30);expect(next.items).toHaveLength(5);expect(next.nextCursor).toBeNull();
  expect(new Set([...page.items,...next.items].map(r=>r.id)).size).toBe(30);
  expect(page.items.find(r=>r.actions.length).response).toEqual({status:'unknown',at:null,source:null,coverage:'partial'});
  expect(page.context).toEqual({asOf:'2026-10-03T12:00:00.000Z',from:'2026-09-26T12:00:00.000Z',to:'2026-10-03T12:00:00.000Z',mailbox:null,visibilitySnapshot:expect.any(String)});
 });
 it('joins exact Gmail identity, shows only verified project/owner and excludes private fields',async()=>{
  const page=await readRecentReplies(pool,options);const [verified,unlinked,ambiguous]=page.items;
  expect(verified.prospectEmail).toBe('buyer@example.test');
  expect(verified.project).toEqual({status:'verified',id:'project-a',title:'Verified local project',basis:'local enrollment'});
  expect(verified.owner).toEqual({status:'verified',pipedriveUserId:42,label:'Pipedrive owner #42'});
  expect(unlinked.prospectEmail).toBeNull();expect(ambiguous.prospectEmail).toBeNull();
  expect(unlinked.project.id).toBeNull();expect(ambiguous.project.title).toBeNull();
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE|DO NOT GUESS|WRONG PROVIDER|target_key|safe_error/);
 });
 it('records only actual staff response, with partial coverage and no inactive/invalid owner',async()=>{
  await pool.query("UPDATE sdr_reply_messages SET staff_response_at='2026-10-03T11:40:00Z' WHERE provider_message_id='reply-30'; UPDATE sdr_reply_routes SET pipedrive_user_id=0");
  let row=(await readRecentReplies(pool,options)).items[0];
  expect(row.response).toEqual({status:'recorded',at:'2026-10-03T11:40:00.000Z',source:'Connected inbox observation',coverage:'partial'});
  expect(row.owner).toEqual({status:'unassigned',pipedriveUserId:null,label:null});
  await pool.query('UPDATE sdr_reply_routes SET pipedrive_user_id=42,active=false');
  expect((await readRecentReplies(pool,options)).items[0].owner.status).toBe('unassigned');
 });
 it('uses inclusive from/detected cutoff and exclusive to, preserving submillisecond continuation',async()=>{
  await pool.query("UPDATE sdr_reply_messages SET received_at='2026-10-03T10:00:00.123456Z'; UPDATE sdr_reply_messages SET received_at='2026-09-26T12:00:00Z',detected_at='2026-10-03T12:00:00Z' WHERE provider_message_id='reply-01'; UPDATE sdr_reply_messages SET received_at='2026-10-03T12:00:00Z' WHERE provider_message_id='reply-02'");
  const first=await readRecentReplies(pool,{...options,limit:25});const next=await readRecentReplies(pool,{...options,cursor:first.nextCursor});
  expect(first.total).toBe(29);expect(new Set([...first.items,...next.items].map(r=>r.id)).size).toBe(29);
  expect(next.items.some(r=>r.id==='reply-01')).toBe(true);
 });
 it('freezes committed membership across in-flight commit and later backdated inserts',async()=>{
  const writer=await pool.connect();
  try {
   await writer.query('BEGIN');
   await writer.query("INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,mailbox_email,received_at,detected_at,reply_kind,link_status) VALUES('inflight','gmail','inflight','rep@example.test','2026-10-03T10:00:00Z','2026-10-03T11:00:00Z','human','unlinked')");
   const first=await readRecentReplies(pool,{...options,limit:25});
   expect(first.total).toBe(30);expect(first.items.some(r=>r.id==='inflight')).toBe(false);
   await writer.query('COMMIT');
   const pinned={...options,asOf:first.context.asOf,visibilitySnapshot:first.context.visibilitySnapshot};
   const same=await readRecentReplies(pool,pinned);
   expect(same.total).toBe(30);expect(same.context).toEqual(first.context);
   expect(same.items.some(r=>r.id==='inflight')).toBe(false);
   await writer.query('BEGIN');
   await writer.query("INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,mailbox_email,received_at,detected_at,reply_kind,link_status) VALUES('after-capture','gmail','after-capture','rep@example.test','2026-10-03T10:00:00Z','2026-10-03T11:00:00Z','human','unlinked')");
   await writer.query('COMMIT');
   expect((await readRecentReplies(pool,pinned)).total).toBe(30);
   const next=await readRecentReplies(pool,{...pinned,cursor:first.nextCursor});
   expect(next.total).toBe(30);expect(next.items).toHaveLength(5);expect(next.context).toEqual(first.context);
   expect(new Set([...first.items,...next.items].map(r=>r.id)).size).toBe(30);
   const fresh=await readRecentReplies(pool,options);
   expect(fresh.total).toBe(32);expect(fresh.context.visibilitySnapshot).not.toBe(first.context.visibilitySnapshot);
  } finally {await writer.query('ROLLBACK');writer.release();}
 });
 it('rejects a cursor paired with a different visibility snapshot',async()=>{
  const first=await readRecentReplies(pool,{...options,limit:1});
  const raw=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());
  expect(raw.v).toBe(2);expect(raw.visibilitySnapshot).toBe(first.context.visibilitySnapshot);
  await expect(readRecentReplies(pool,{...options,cursor:first.nextCursor,visibilitySnapshot:'1:2:'})).rejects.toThrow('invalid');
  const forged=Buffer.from(JSON.stringify({...raw,visibilitySnapshot:'1:2:'})).toString('base64url');
  await expect(readRecentReplies(pool,{...options,cursor:forged,visibilitySnapshot:first.context.visibilitySnapshot})).rejects.toThrow('invalid');
 });
 it('returns unavailable with unknown coverage if the visibility migration is absent',async()=>{
  await pool.query('ALTER TABLE sdr_reply_messages RENAME COLUMN ingestion_xid TO hidden_ingestion_xid');
  try {expect(await readRecentReplies(pool,options)).toMatchObject({state:'unavailable',total:null,items:[],context:{visibilitySnapshot:null},coverage:{state:'unknown'}});} finally {await pool.query('ALTER TABLE sdr_reply_messages RENAME COLUMN hidden_ingestion_xid TO ingestion_xid');}
 });
 it('keeps the original ingestion xid when latest response evidence changes',async()=>{
  const first=await readRecentReplies(pool,options);
  const before=(await pool.query("SELECT ingestion_xid::text AS xid FROM sdr_reply_messages WHERE provider_message_id='reply-30'")).rows[0].xid;
  await pool.query("UPDATE sdr_reply_messages SET staff_response_at='2026-10-03T11:40:00Z' WHERE provider_message_id='reply-30'");
  const current=await readRecentReplies(pool,{...options,visibilitySnapshot:first.context.visibilitySnapshot});
  expect(current.total).toBe(30);expect(current.items[0].response.status).toBe('recorded');
  expect((await pool.query("SELECT ingestion_xid::text AS xid FROM sdr_reply_messages WHERE provider_message_id='reply-30'")).rows[0].xid).toBe(before);
 });
 it('holds membership across later detections and changed technical evidence',async()=>{
  const first=await readRecentReplies(pool,{...options,limit:1});
  await pool.query("UPDATE sdr_reply_actions SET status='failed'; INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,mailbox_email,received_at,detected_at,reply_kind,link_status) VALUES('late','gmail','late','rep@example.test','2026-10-03T10:00:00Z','2026-10-03T12:01:00Z','human','unlinked')");
  expect((await readRecentReplies(pool,{...options,cursor:first.nextCursor})).total).toBe(30);
 });
 it('uses only scoped collector completion receipts, never account or another mailbox',async()=>{
  expect((await readRecentReplies(pool,options)).coverage).toMatchObject({state:'unknown',lastCollectedAt:null});
  await pool.query("INSERT INTO sdr_job_runs(job,scope,status,finished_at) VALUES('gmail_watch','account','complete','2026-10-03T11:59:00Z'),('gmail_watch','other@example.test','complete','2026-10-03T11:58:00Z'),('gmail_watch','rep@example.test','partial','2026-10-03T11:57:00Z')");
  expect((await readRecentReplies(pool,options)).coverage.lastCollectedAt).toBeNull();
  await pool.query("INSERT INTO sdr_job_runs(job,scope,status,finished_at) VALUES('gmail_watch','rep@example.test','complete','2026-10-03T11:50:00Z')");
  expect((await readRecentReplies(pool,options)).coverage).toMatchObject({state:'partial',lastCollectedAt:'2026-10-03T11:50:00.000Z'});
  expect((await readRecentReplies(pool,{...options,visibleMailboxes:['rep@example.test','other@example.test']})).coverage.lastCollectedAt).toBe('2026-10-03T11:50:00.000Z');
 });
 it('keeps records available without optional receipts but missing reporting schema unavailable',async()=>{
  await pool.query('ALTER TABLE sdr_job_runs RENAME TO hidden_job_runs');
  try {expect((await readRecentReplies(pool,options)).coverage.lastCollectedAt).toBeNull();} finally {await pool.query('ALTER TABLE hidden_job_runs RENAME TO sdr_job_runs');}
  await pool.query('ALTER TABLE sdr_message_facts RENAME TO hidden_facts');
  try {expect(await readRecentReplies(pool,options)).toMatchObject({state:'unavailable',total:null,items:[],nextCursor:null});} finally {await pool.query('ALTER TABLE hidden_facts RENAME TO sdr_message_facts');}
 });
 it('rejects cursor reuse after scope/filter/asOf changes and resumes with its pinned asOf',async()=>{
  const first=await readRecentReplies(pool,{...options,limit:1});
  for(const change of [{visibleMailboxes:['other@example.test']},{mailbox:'rep@example.test'},{asOf:'2026-10-03T11:59:00Z'}]) await expect(readRecentReplies(pool,{...options,cursor:first.nextCursor,...change})).rejects.toThrow('invalid');
  const next=await readRecentReplies(pool,{visibleMailboxes:options.visibleMailboxes,now:new Date(asOf),cursor:first.nextCursor});
  expect(next.context.asOf).toBe(first.context.asOf);expect(next.items[0].id).toBe('reply-29');
 });
 it('accepts timezone-offset and fractional ISO boundaries without losing future cutoff precision',async()=>{
  expect((await readRecentReplies(pool,{...options,asOf:'2026-10-03T14:00:00+02:00'})).total).toBe(30);
  await expect(readRecentReplies(pool,{...options,asOf:'2026-10-03T12:00:00.000001Z'})).rejects.toThrow('invalid');
 });
 it.each([
  ['2026-10-03T11:59:59.000Z','2026-10-03T11:59:59.000000Z','2026-09-26T11:59:59.000Z'],
  ['2026-10-03T11:59:59.000000Z','2026-10-03T13:59:59.000+02:00','2026-09-26T11:59:59.000Z'],
  ['2026-10-03T11:59:59.1234Z','2026-10-03T13:59:59.123400+02:00','2026-09-26T11:59:59.1234Z'],
 ])('resumes cursor across equivalent ISO precision and offsets: %s',async(firstAsOf,nextAsOf,from)=>{
  const first=await readRecentReplies(pool,{...options,asOf:firstAsOf,limit:1});
  const next=await readRecentReplies(pool,{...options,asOf:nextAsOf,cursor:first.nextCursor});
  expect(next.context).toEqual(first.context);expect(next.context.from).toBe(from);
  expect(next.total).toBe(30);expect(next.items[0].id).toBe('reply-29');
  await expect(readRecentReplies(pool,{...options,asOf:'2026-10-03T11:59:59.123401Z',cursor:first.nextCursor})).rejects.toThrow('invalid');
 });
 it('does not leave statement timeout on pooled sessions',async()=>{
  await readRecentReplies(pool,options);expect((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0');
 });
 it('backfills legacy rows once and preserves ingestion identity when the migration repeats',async()=>{
  const previous=(await pool.query("SELECT ingestion_xid::text AS xid FROM sdr_reply_messages WHERE provider_message_id='reply-30'")).rows[0].xid;
  await pool.query('ALTER TABLE sdr_reply_messages RENAME COLUMN ingestion_xid TO legacy_ingestion_xid');
  try {
   const migration=await readFile(new URL('../../migrations/2026-10-03-sdr-reply-visibility.sql',import.meta.url),'utf8');
   await pool.query(migration);
   const backfilled=(await pool.query('SELECT count(DISTINCT ingestion_xid)::int AS ids,min(ingestion_xid::text) AS xid,count(*)::int AS rows FROM sdr_reply_messages')).rows[0];
   expect(backfilled.ids).toBe(1);expect(backfilled.rows).toBe(34);expect(backfilled.xid).not.toBe(previous);
   await pool.query(migration);
   expect((await pool.query("SELECT ingestion_xid::text AS xid FROM sdr_reply_messages WHERE provider_message_id='reply-30'")).rows[0].xid).toBe(backfilled.xid);
   expect((await readRecentReplies(pool,options)).total).toBe(30);
  } finally {
   const current=(await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sdr_reply_messages' AND column_name='ingestion_xid'")).rowCount;
   if(current) await pool.query('ALTER TABLE sdr_reply_messages DROP COLUMN legacy_ingestion_xid');
   else await pool.query('ALTER TABLE sdr_reply_messages RENAME COLUMN legacy_ingestion_xid TO ingestion_xid');
  }
 });
 it('fails explicitly when generated context would exceed the accepted cursor budget',async()=>{
  const scope=['rep@example.test',...Array.from({length:700},(_,i)=>`long-visible-mailbox-${i}@example.test`)];
  await expect(readRecentReplies(pool,{...options,visibleMailboxes:scope})).rejects.toThrow('replies_context_unavailable');
 });
 it('adds a partial human membership index using the explicit local migration',async()=>{
  await pool.query(await readFile(new URL('../../migrations/2026-10-03-sdr-operations-read-index.sql',import.meta.url),'utf8'));
  const row=(await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='idx_sdr_reply_messages_human_recent'")).rows[0];
  expect(row.indexdef).toMatch(/mailbox_email, received_at DESC, provider_message_id DESC/);expect(row.indexdef).toContain("reply_kind = 'human'");
 });
});
it('never queries a global scope when visible mailbox list is empty',async()=>{
 const query=vi.fn();expect(await readRecentReplies({query},{...options,visibleMailboxes:[]})).toMatchObject({state:'available',total:0,items:[]});expect(query).not.toHaveBeenCalled();
});
it('rejects inconsistent cursor scope/asOf/filter and invalid dates before reading',async()=>{
 const query=vi.fn();const p={query};
 for(const change of [{asOf:'2026-10-03T12:00:00.001Z'},{asOf:'2026-09-26T11:59:59Z'},{asOf:'2026-02-30T12:00:00Z'},{limit:26},{limit:'2x'},{cursor:'garbage'},{visibilitySnapshot:'10:20:20'},{visibilitySnapshot:'10:20:10,10'},{visibilitySnapshot:'20:10:'},{visibilitySnapshot:'10:20:',asOf:undefined}]) await expect(readRecentReplies(p,{...options,...change})).rejects.toThrow('invalid');
 expect(query).not.toHaveBeenCalled();
});
it('discards a pooled client if rollback cannot clear transaction-local settings',async()=>{
 const failure=new Error('connection lost');const release=vi.fn();
 const client={query:async({text})=>{if(text==='ROLLBACK'||text.startsWith('SELECT')) throw failure;return {rows:[]};},release};
 await expect(readRecentReplies({connect:async()=>client},options)).rejects.toThrow('connection lost');
 expect(release).toHaveBeenCalledWith(failure);
});
