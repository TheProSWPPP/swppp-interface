import {beforeAll,afterAll,beforeEach,it,expect,describe,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {readActivityFeed,registerActivityFeedRoute} from '../sdrActivityFeed.js';
const db=reportingTestDb('activity_feed'),pool=db?.pool;
const now=new Date('2026-10-06T12:00:00Z');
describe.skipIf(!pool)('activity feed evidence and mailbox isolation',()=>{
 beforeAll(async()=>{await db.setup();for(const name of ['2026-10-02-sdr-reporting.sql','2026-10-03-sdr-reply-actions.sql','2026-10-04-sdr-metric-evidence.sql','2026-10-05-sdr-test-exclusions.sql'])await pool.query(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));await pool.query('CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,lead_title text)');});
 afterAll(async()=>{await db.close();});
 beforeEach(async()=>{
  await pool.query('TRUNCATE sdr_reply_messages CASCADE; TRUNCATE sdr_message_facts,sdr_job_runs,sdr_lead_state');
  await pool.query(`INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,campaign_id,occurred_at,provider_status,link_status,pipedrive_lead_id,is_test,outreach_classification) VALUES
   ('apollo','sent','out','rep@example.test','buyer@example.test','campaign','2026-10-06T11:00:00Z','completed','verified','lead',false,'unknown'),
   ('apollo','scheduled','out','rep@example.test','buyer@example.test','campaign','2026-10-06T11:30:00Z','scheduled','unmatched',null,false,'unknown'),
   ('apollo','test','out','rep@example.test','buyer@example.test','campaign','2026-10-06T11:30:00Z','completed','unmatched',null,true,'unknown'),
   ('apollo','warmup','out','rep@example.test','buyer@example.test','campaign','2026-10-06T11:30:00Z','completed','unmatched',null,false,'warmup'),
   ('apollo','private','out','other@example.test','PRIVATE','campaign','2026-10-06T11:30:00Z','completed','unmatched',null,false,'unknown'),
   ('apollo','future','out','rep@example.test','buyer@example.test','campaign','2026-10-06T13:00:00Z','completed','unmatched',null,false,'unknown'),
   ('apollo','old','out','rep@example.test','buyer@example.test','campaign','2026-09-01T11:00:00Z','completed','unmatched',null,false,'unknown'),
   ('gmail','reply','in','rep@example.test','reply@example.test',null,'2026-10-06T11:15:00Z','received','unmatched',null,false,'unknown'),
   ('gmail','test-reply','in','rep@example.test','test@example.test',null,'2026-10-06T11:20:00Z','received','unmatched',null,true,'unknown');
   INSERT INTO sdr_lead_state VALUES('lead','Project A');
   INSERT INTO sdr_reply_messages(provider_message_id,source,source_message_id,mailbox_email,received_at,reply_kind,link_status,pipedrive_lead_id,detected_at) VALUES
    ('canonical','gmail','reply','rep@example.test','2026-10-06T11:15:00Z','human','ambiguous','lead','2026-10-06T11:16:00Z'),
    ('test-canonical','gmail','test-reply','rep@example.test','2026-10-06T11:20:00Z','human','unlinked',null,'2026-10-06T11:21:00Z'),
    ('auto','gmail','auto','rep@example.test','2026-10-06T11:25:00Z','auto','unlinked',null,'2026-10-06T11:26:00Z');`);
 });
 it('returns only scoped, dated sends and human replies with verified project links',async()=>{
  const result=await readActivityFeed(pool,{visibleMailboxes:['rep@example.test'],now});
  expect(result.items.map(x=>x.kind)).toEqual(['reply','sent']);
  expect(result.items[0]).toMatchObject({contact:'reply@example.test',projectId:null,projectTitle:null});
  expect(result.items[1]).toMatchObject({contact:'buyer@example.test',projectId:'lead',projectTitle:'Project A'});
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|scheduled|warmup|test-reply/);
 });
 it('filters before limiting and uses deterministic ordering',async()=>{
  await pool.query(`INSERT INTO sdr_message_facts(provider,provider_message_id,direction,mailbox_email,prospect_email,campaign_id,occurred_at,provider_status,link_status) SELECT 'apollo','bulk-'||n,'out','rep@example.test','buyer@example.test','campaign','2026-10-06T11:45:00Z','completed','unmatched' FROM generate_series(1,30)n`);
  expect((await readActivityFeed(pool,{visibleMailboxes:['rep@example.test'],now,kind:'reply'})).items).toHaveLength(1);
  const a=await readActivityFeed(pool,{visibleMailboxes:['rep@example.test'],now});const b=await readActivityFeed(pool,{visibleMailboxes:['rep@example.test'],now});
  expect(a.items).toHaveLength(20);expect(a.items).toEqual(b.items);
 });
 it('returns no data for an empty scope without a query',async()=>{
  const query=vi.fn();expect((await readActivityFeed({query},{visibleMailboxes:[],now})).items).toEqual([]);expect(query).not.toHaveBeenCalled();
 });
});
async function route(user,query={}) {
 let handler,status=200,body;const read=vi.fn(async(_pool,o)=>({scope:o.visibleMailboxes,kind:o.kind}));const resolve=vi.fn(async()=>['rep@example.test']);
 registerActivityFeedRoute({get(_path,h){handler=h;}},{pool:{},resolveVisibleMailboxes:resolve,read});
 await handler({sdrUser:user,query},{status(n){status=n;return this;},json(b){body=b;return this;},set(){return this;}});return {status,body,read,resolve};
}
it('requires auth and rejects scope overrides before resolving mailboxes',async()=>{
 expect((await route(null)).status).toBe(401);
 const invalid=await route({sub:'rep'},{mailbox:'private@example.test'});expect(invalid.status).toBe(400);expect(invalid.resolve).not.toHaveBeenCalled();
 const valid=await route({sub:'rep'},{kind:'reply'});expect(valid.body).toEqual({scope:['rep@example.test'],kind:'reply'});
});
